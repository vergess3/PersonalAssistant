export function relayStatus(relay){
  const count=(list,phase)=>list.filter(x=>x.phase===phase).length;
  return {requests:relay.state.jobs.length,
    queuedRequests:count(relay.state.jobs,'queued'),stagedRequests:count(relay.state.jobs,'staged'),
    bundledRequests:count(relay.state.jobs,'bundled'),
    sentRequests:count(relay.state.jobs,'posted'),
    uncertainRequests:count(relay.state.jobs,'sending'),
    uncertainReplies:count(relay.state.outbox,'sending'),
    deferredRequests:relay.state.jobs.filter(j=>j.phase==='queued'&&j.deferUntil>relay.now()).length,
    unresolvedQuotes:relay.state.jobs.filter(j=>j.phase==='queued'&&j.lastRoutingError==='quoted_message_unresolved').length,
    outbox:relay.state.outbox.length,
    queuedReplies:count(relay.state.outbox,'queued'),
    returnedReplies:count(relay.state.outbox,'sent'),
    eyesAcknowledgements:relay.state.outbox.filter(o=>o.kind==='eyes_ack').length,
    sentEyesAcknowledgements:relay.state.outbox.filter(o=>o.kind==='eyes_ack'&&o.phase==='sent').length,
    thumbsupAcknowledgements:relay.state.outbox.filter(o=>o.kind==='thumbsup_ack').length,
    sentThumbsupAcknowledgements:relay.state.outbox.filter(o=>o.kind==='thumbsup_ack'&&o.phase==='sent').length,
    uncertain:relay.uncertain};
}
export async function receiveOnce(relay,weixin){
  const batch=await weixin.updates(relay.state.cursor);relay.ingest(batch);return relayStatus(relay);
}
// Read the DM since the watermark with a 10-minute overlap (thread replies to
// recent parents included); the relay dedupes by message ts. Network reads
// only here, so callers can apply the result under their state lock.
export async function fetchSlackMessages(relay,reader){
  const fromMs=Math.max(relay.state.slackActiveFrom,(relay.state.slackWatermark||relay.state.slackActiveFrom)-600000);
  // Slack timestamps have at most six decimal places. Converting a stored
  // fractional-ms watermark back to seconds can produce seven (for example
  // 1793969388.5969388), which Slack silently answers with an empty page.
  // Round the lower bound down to whole seconds; ts deduplication handles the
  // extra fraction of a second without missing or resending a message.
  const main=await reader.historySince(String(Math.floor(fromMs/1000)));
  const messages=[...main];
  const roots=new Set(main.filter(m=>m.reply_count&&Number(m.latest_reply||0)*1000>=fromMs).map(m=>m.ts));
  // A reply does not bump its parent's history timestamp. A WeChat quote can
  // revive a root outside that window, so recently posted follow-ups must be
  // watched independently of the slow historical sweep.
  relay.threadReads ||= new Map();
  const now=relay.now?.()??Date.now(),activity=new Map();
  for(const job of relay.state.jobs||[]){
    const root=job.threadTs||job.slackTs;if(!root)continue;
    // Use the share timestamp too: an old durable task may only just have
    // reached Slack after an authorization or network failure was resolved.
    const latest=Math.max(Number(job.slackTs)*1000||0,job.receivedAt||job.created||0);
    activity.set(root,Math.max(activity.get(root)||0,latest));
  }
  const lastRead=root=>relay.threadReads.get(root)||0;
  const unreadActivity=root=>lastRead(root)<activity.get(root)?1:0;
  const active=[...activity.keys()].filter(root=>!roots.has(root)&&activity.get(root)>=now-3600000)
    .sort((a,b)=>unreadActivity(b)-unreadActivity(a)||lastRead(a)-lastRead(b)||activity.get(b)-activity.get(a));
  // Bound extra reads while rotating fairly through simultaneous active topics.
  for(const root of active.slice(0,3))roots.add(root);
  // Keep one slot for the historical sweep so late replies still surface.
  const historical=[...activity.keys()].filter(root=>!roots.has(root)&&activity.get(root)<now-3600000)
    .sort((a,b)=>lastRead(a)-lastRead(b));
  if(historical.length)roots.add(historical[0]);
  for(const root of roots){
    messages.push(...await reader.replies(root));
    relay.threadReads.set(root,relay.now?.()??Date.now());
  }
  const watermark=main.reduce((max,m)=>Math.max(max,Number(m.ts)*1000||0),relay.state.slackWatermark||0);
  return {messages,watermark};
}
export async function collectSlack(relay,reader){
  const {messages,watermark}=await fetchSlackMessages(relay,reader);
  relay.state.slackWatermark=watermark||relay.state.slackWatermark;
  relay.collectSlackMessages(messages);
  return relayStatus(relay);
}
