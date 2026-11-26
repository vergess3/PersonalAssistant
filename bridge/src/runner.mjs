import {setTimeout as delay} from 'node:timers/promises';
import {fetchSlackMessages,relayStatus} from './relay-loop.mjs';
import {errorMetadata,fatalStateError,retryDelay} from './recovery.mjs';
// Each lane has one worker. State edits and DPAPI saves are synchronous; only
// network waits interleave. A slow upload cannot hold the receive/poll workers.
export async function runBridge({relay,reader,weixin,connector,forwarding,shouldStop,
  onHealth=()=>{},log=()=>{},sleep=delay,intervals={}}){
  let stopped=false,verified=false,failure;
  const health={startedAt:Date.now(),lanes:{}};
  const active=()=>!stopped&&!shouldStop();
  const pause=async ms=>{const until=Date.now()+ms;while(active()&&Date.now()<until)await sleep(Math.min(250,until-Date.now()));};
  async function lane(name,fn,interval){
    let attempts=0;
    while(active()){
      const state=health.lanes[name] ||= {};state.lastAttempt=Date.now();
      try{await fn();attempts=0;state.lastSuccess=Date.now();delete state.lastError;state.nextAttempt=Date.now()+interval;}
      catch(e){
        if(fatalStateError(e)){failure=e;stopped=true;connector?.close();return;}
        state.lastError=errorMetadata(e);state.nextAttempt=Date.now()+retryDelay(++attempts,e.retryAfter);
        log({status:name+'_retry',...state.lastError,nextAttempt:state.nextAttempt});
      }
      await pause(Math.max(0,state.nextAttempt-Date.now()));
    }
  }
  const workers=[lane('receive',async()=>{
    const batch=await weixin.updates(relay.state.cursor);
    if(batch.msgs.length)relay.ingest(batch);
    else if(batch.get_updates_buf&&batch.get_updates_buf!==relay.state.cursor){relay.state.cursor=batch.get_updates_buf;relay.save();}
  },intervals.receive??0)];
  if(forwarding)workers.push(
    lane('send',()=>relay.sendQueued(),intervals.send??250),
    lane('poll',async()=>{
      try{
        if(!verified){await reader.verify();verified=true;}
        const fetched=await fetchSlackMessages(relay,reader);
        relay.state.slackWatermark=fetched.watermark||relay.state.slackWatermark;
        relay.collectSlackMessages(fetched.messages);
      }catch(e){if(e.message==='slack_api_error')verified=false;throw e;}
    },intervals.poll??5000),
    lane('return',()=>relay.returnQueued(),intervals.return??250)
  );
  workers.push(lane('health',async()=>{
    onHealth({at:Date.now(),pid:process.pid,startedAt:health.startedAt,
      lanes:structuredClone(health.lanes),connector:connector?.status,
      receive:weixin.receiveStatus?{...weixin.receiveStatus,timeoutMs:weixin.longPollTimeoutMs}:undefined,
      queue:relayStatus(relay)});
  },intervals.health??15000));
  await Promise.all(workers);
  if(failure)throw failure;
}
