import { randomUUID } from 'node:crypto';
import {fetch} from './network.mjs';
import { parseInbound } from './inbound.mjs';
import { slackMessageText } from './slack-text.mjs';
import { prepareVoiceUpload } from './voice-audio.mjs';
import { downloadInboundMedia,inboundFileName,uploadOutboundMedia,outboundKind } from './weixin-media.mjs';
import { validTs,exactId,putReference,resolveReference,topicOf,nativeQuote } from './references.mjs';
import {deferItem,errorMetadata,fatalStateError} from './recovery.mjs';
const MIME={jpg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',mp4:'video/mp4',mp3:'audio/mpeg',spx:'audio/ogg',ogg:'audio/ogg',amr:'audio/amr',silk:'audio/silk',txt:'text/plain'};
const FOLLOW_UP_WINDOW_MS=15000;
const THUMBS_UP_REACTIONS=new Set(['+1','thumbsup']);
const isThumbsUpReaction=name=>typeof name==='string'&&THUMBS_UP_REACTIONS.has(name.split('::')[0]);
const isReactionEntry=o=>o.kind==='eyes_ack'||o.kind==='thumbsup_ack';
const reactionRefKey=o=>o.kind==='eyes_ack'?'ack:'+o.sourceJobId:o.kind==='thumbsup_ack'?'like:'+o.sourceJobId:null;

// Native bidirectional relay: preserve content, adapting Slack display formatting
// to readable Weixin plain text (paragraphs, lists and numbered link references).
// WeChat -> Slack: the bound user's new messages (text and files). WeChat
// sends one attachment per message, so document/image/video-only messages are
// staged untouched until a text or voice message arrives (or follow a text
// message sent within the last few seconds into the same context). Voice does
// not require a transcript.
// Slack -> WeChat: the assistant's new DM messages forward immediately,
// using the latest WeChat context token.
export class Relay {
  constructor({config,store,connector,weixin,reader=null,fetcher=fetch,voiceConverter=prepareVoiceUpload,activeFrom,now=Date.now}) {
    Object.assign(this,{config,store,connector,weixin,reader,fetcher,voiceConverter,now});
    const binding=JSON.stringify([config.slackTeam,config.slackUser,config.slackChannel,
      config.slackAssistantUser,config.weixinUserId,config.weixinBotId]);
    const loaded=store.load();
    if(loaded&&![3,4].includes(loaded.version))throw Error('state_binding_mismatch');
    this.state=loaded||{version:4,binding,activeFrom,cursor:'',lastContext:'',jobs:[],outbox:[]};
    if(this.state.binding!==binding||!Number.isSafeInteger(this.state.activeFrom)||
      !Array.isArray(this.state.jobs)||!Array.isArray(this.state.outbox))
      throw Error('state_binding_mismatch');
    this.state.version=4;
    this.state.references ||= [];
    // A crash between share dispatch and its receipt affects only that job.
    for(const j of this.state.jobs)if(j.phase==='queued'&&Object.values(j.mediaUploads||{}).some(u=>u.stage==='sharing'))j.phase='sending';
    // Slack history before this boundary is never backfilled: a state created
    // before the field existed starts collecting from now, not from activeFrom.
    if(!Number.isSafeInteger(this.state.slackActiveFrom))
      this.state.slackActiveFrom=loaded?now():this.state.activeFrom;
    // Enabling reaction acknowledgements must not replay historical eyes.
    if(!Number.isSafeInteger(this.state.eyesActiveFrom))
      this.state.eyesActiveFrom=loaded?now():this.state.activeFrom;
    // Distinguishing thumbs-up reactions must not replay historical likes.
    if(!Number.isSafeInteger(this.state.thumbsupActiveFrom))
      this.state.thumbsupActiveFrom=loaded?now():this.state.activeFrom;
    // A queue created by the later strict-routing repair remains usable:
    // restore only entries that still carry a deliverable payload.
    for(const job of this.state.jobs)if(job.phase==='unmapped')
      job.phase=job.text?.trim()?'queued':job.media?.length?'staged':'unmapped';
    for(const entry of this.state.outbox)if(entry.phase==='unmapped'&&(entry.text?.trim()||entry.files?.length))
      entry.phase='queued';
    // Voice jobs staged by the earlier all-media rule already carry their
    // transcripts. Restore them as immediate, complete messages on restart.
    for(const job of this.state.jobs)if(job.phase==='staged'&&job.media?.some(m=>m.kind==='voice')){
      const transcript=job.media.map(m=>m.item?.text).filter(t=>typeof t==='string').join('\n');
      if(transcript.trim())job.text=job.text?.trim()?job.text:transcript;
      job.phase='queued';
    }
  }
  save(){this.store.save(this.state);}
  get uncertain(){
    return this.state.jobs.some(j=>j.phase==='sending')||this.state.outbox.some(o=>o.phase==='sending');
  }
  // ---- WeChat -> Slack ----
  ingest(batch){
    // Mutations/save are synchronous on one JS event loop. Keep object identity
    // while independent network loops await: an inbound must not replace jobs
    // currently being delivered with stale cloned objects.
    const next=this.state,seen=new Set(next.jobs.map(j=>j.id));
    for(const message of batch.msgs){
      const now=this.now();
      const parsed=parseInbound(message,this.config,next.activeFrom,now);
      if(!parsed||seen.has(parsed.id))continue;
      seen.add(parsed.id);next.lastContext=parsed.context;
      const hasText=!!parsed.text.trim();
      const complete=hasText||parsed.media.some(m=>m.kind==='voice');
      const bundled=[];
      if(complete)for(const job of next.jobs)if(job.phase==='staged'&&
        // An explicitly quoted attachment must keep its own routing context.
        (!job.quote||JSON.stringify(job.quote)===JSON.stringify(parsed.quote))){
        job.phase='bundled';job.bundledInto=parsed.id;bundled.push(job);
      }
      const allowFollowUp=hasText&&!parsed.media.length&&!bundled.length;
      const anchor=!complete&&parsed.media.length?[...next.jobs].reverse().find(j=>!j.bundledInto&&!j.followUpTo):null;
      const followUp=anchor?.allowFollowUp&&
        (!parsed.quote||JSON.stringify(anchor.quote)===JSON.stringify(parsed.quote))&&
        now-(anchor.lastFollowUpAt??anchor.receivedAt??now)<=FOLLOW_UP_WINDOW_MS&&
        Math.abs(parsed.created-(anchor.lastFollowUpCreated??anchor.created??parsed.created))<=FOLLOW_UP_WINDOW_MS;
      const media=[...bundled.flatMap(j=>j.media||[]),...parsed.media];
      let anchorThreadTs;
      if(followUp){
        anchor.lastFollowUpAt=now;anchor.lastFollowUpCreated=parsed.created;
        if(anchor.phase==='queued'&&this.activeJobId!==anchor.id&&anchor.uploadedMedia===undefined&&
          !anchor.mediaUploads&&!anchor.slackTs&&!anchor.transcriptPosted){
          anchor.media=[...(anchor.media||[]),...parsed.media];
          anchor.bundledIds=[...(anchor.bundledIds||[]),parsed.id];
          next.jobs.push({...parsed,receivedAt:now,phase:'bundled',bundledInto:anchor.id});
          delete next.jobs.at(-1).media;delete next.jobs.at(-1).text;
          anchorThreadTs=validTs(anchor.threadTs||anchor.slackTs)?(anchor.threadTs||anchor.slackTs):undefined;
        }else{
          anchorThreadTs=validTs(anchor.threadTs||anchor.slackTs)?(anchor.threadTs||anchor.slackTs):undefined;
          const dependsOn=[anchor.id,...next.jobs.filter(j=>j.followUpTo===anchor.id).map(j=>j.id)];
          next.jobs.push({...parsed,receivedAt:now,media,followUpTo:anchor.id,dependsOn,
            ...(anchorThreadTs?{threadTs:anchorThreadTs}:{}),phase:'queued'});
        }
      }else{
        next.jobs.push({...parsed,receivedAt:now,
          media,
          ...(allowFollowUp?{allowFollowUp:true}:{}),
          ...(bundled.length?{bundledIds:bundled.map(j=>j.id)}:{}),
          phase:complete||!media.length?'queued':'staged'});
      }
      // Keep source records for deduplication and quoting, with one payload owner.
      for(const job of bundled){delete job.media;delete job.text;}
      const target=resolveReference(next,parsed.quote||(followUp?anchor?.quote:undefined));
      const refThreadTs=anchorThreadTs||(target&&validTs(topicOf(target))?topicOf(target):undefined);
      const ref=putReference(next,{key:'wx:'+parsed.id,role:'user',weixinIds:parsed.weixinIds,
        text:parsed.text||parsed.media.map(m=>m.item.file_name||`[${m.kind}]`).join('\n'),
        ...(refThreadTs?{threadTs:refThreadTs}:{})});
      next.lastVisibleKey=ref.key;
    }
    if(next.jobs.length>10000)throw Error('state_capacity_reached');
    next.cursor=batch.get_updates_buf||next.cursor;
    this.store.save(next);this.state=next;
  }
  async sendQueued(){
    const SAFE_BEFORE_TEXT=['connector_upload_start_invalid','connector_upload_post_failed',
      'connector_upload_outcome_unknown','connector_tool_denied_or_failed','remote_http_error',
      'transport_outcome_unknown','request_timeout','rate_limited','weixin_media_too_large',
      'weixin_media_key_missing','invalid_weixin_aes_key','unapproved_weixin_cdn_url',
      'voice_transcode_failed','voice_format_unsupported','voice_audio_invalid','voice_audio_too_large'];
    for(const job of this.state.jobs.filter(j=>j.phase==='queued')){
      if(job.phase!=='queued')continue;
      if(job.deferUntil>this.now())continue;
      if(job.dependsOn?.some(id=>this.state.jobs.some(j=>j.id===id&&j.phase!=='posted')))continue;
      this.activeJobId=job.id;
      try{
      if(job.quote&&!job.threadTs){
        const target=resolveReference(this.state,job.quote);
        if(!validTs(topicOf(target))){
          job.lastRoutingError='quoted_message_unresolved';this.save();continue;
        }
        job.threadTs=topicOf(target);job.quotedKey=target.key;
        delete job.lastRoutingError;
      }
      if(job.followUpTo&&!job.threadTs){
        const anchor=this.state.jobs.find(j=>j.id===job.followUpTo);
        const threadTs=anchor?.threadTs||anchor?.slackTs;
        if(validTs(threadTs))job.threadTs=threadTs;
      }
      const own=this.state.references.find(r=>r.key==='wx:'+job.id);
      if(job.threadTs&&this.state.jobs.slice(0,this.state.jobs.indexOf(job)).some(j=>j.threadTs===job.threadTs&&j.phase!=='posted'))continue;
      if(own&&job.threadTs)own.threadTs=job.threadTs;
      job.uploadedMedia=job.uploadedMedia||0;
      // Attach the instruction to the final file share (the voice, when present).
      // The connector shares one file per call; do not also post a text-only task.
      const combineTextWithFile=!!job.text?.trim()&&(job.media||[]).length>0&&!job.transcriptPosted;
      try{
        while(job.uploadedMedia<(job.media||[]).length){
          const media=job.media[job.uploadedMedia];
          const checkpoint=job.mediaUploads?.[job.uploadedMedia]||{};
          let upload;
          if(['uploaded','shared'].includes(checkpoint.stage))upload={filename:checkpoint.filename,contentType:checkpoint.contentType,bytes:Buffer.alloc(0)};
          else{
            const bytes=await downloadInboundMedia(media,this.fetcher);
            const name=inboundFileName(media,bytes,job.id);
            upload=media.kind==='voice'?await this.voiceConverter(bytes,media.item,job.id):
              {filename:name,bytes,contentType:MIME[name.split('.').pop()?.toLowerCase()]||'application/octet-stream'};
          }
          const uploadStartedAt=this.now();
          const sent=await this.connector.uploadFile({...upload,
            checkpoint,onCheckpoint:p=>{
              job.mediaUploads ||= {};job.mediaUploads[job.uploadedMedia]={...p,filename:upload.filename,
                contentType:upload.contentType,bytes:checkpoint.bytes||upload.bytes.length};this.save();
            },
            ...(job.threadTs?{threadTs:job.threadTs}:{}),
            ...(combineTextWithFile&&job.uploadedMedia===job.media.length-1?{initialComment:job.text}:{})});
          if(!/^F[A-Z0-9]+$/.test(sent?.fileId||''))throw Error('connector_receipt_invalid');
          job.slackFileIds=[...new Set([...(job.slackFileIds||[]),sent.fileId])];
          if(job.bundledIds&&job.uploadedMedia===job.media.length-1)job.taskFileId=sent.fileId;
          if(media.kind==='voice')job.voiceUpload={filename:upload.filename,contentType:upload.contentType,bytes:checkpoint.bytes||upload.bytes.length};
          if(combineTextWithFile)job.postMs=this.now()-uploadStartedAt;
          job.uploadedMedia++;this.save();
        }
      }catch(e){
        // Upload preparation has not necessarily shared anything; only an
        // unclassified failure is treated as an uncertain delivery outcome.
        if(fatalStateError(e))throw e;
        if(e.stage==='upload_share'||(!e.safeBeforeSend&&!SAFE_BEFORE_TEXT.includes(e.message))){job.phase='sending';this.save();throw e;}
        job.lastPreparationError={code:e.message,at:this.now()};
        // An unsupported/damaged recording must not silence its usable
        // protocol transcript. Send that once; retain the audio for retry.
        if(e.message.startsWith('voice_')&&job.text?.trim()&&!job.transcriptPosted){
          job.phase='sending';this.save();
          const sent=await this.connector.post(job.text,job.threadTs?{threadTs:job.threadTs}:{});
          if(sent.channel!==this.config.slackChannel||!validTs(sent.ts))throw Error('unexpected_destination');
          job.slackTs=sent.ts;if(own)own.slackTs=sent.ts;
          job.transcriptPosted=true;job.phase='queued';this.save();
        }
        deferItem(job,e,this.now());this.save();continue;
      }
      job.phase='sending';delete job.deferUntil;this.save();
      if(job.text?.trim()&&!combineTextWithFile&&!job.transcriptPosted){
        const postStartedAt=this.now();
        const sent=await this.connector.post(job.text,job.threadTs?{threadTs:job.threadTs}:{});
        job.postMs=this.now()-postStartedAt;
        if(sent.channel!==this.config.slackChannel||!validTs(sent.ts))throw Error('unexpected_destination');
        job.slackTs=sent.ts;
        if(own)own.slackTs=sent.ts;
        const topic=job.threadTs||job.slackTs;
        for(const follow of this.state.jobs)if(follow.followUpTo===job.id&&!follow.threadTs&&validTs(topic)){
          follow.threadTs=topic;
          const ref=this.state.references.find(r=>r.key==='wx:'+follow.id);
          if(ref)ref.threadTs=topic;
        }
      }
      job.phase='posted';delete job.text;delete job.media;delete job.uploadedMedia;
      for(const source of this.state.jobs)if(source.bundledInto===job.id)source.phase='posted';
      delete job.lastPreparationError;delete job.transcriptPosted;delete job.mediaUploads;delete job.lastError;delete job.attempts;this.save();
      }catch(e){
        if(fatalStateError(e))throw e;
        if(e.safeBeforeSend){job.phase='queued';deferItem(job,e,this.now());}
        else{job.phase='sending';job.lastError=errorMetadata(e,this.now());}
        this.save(); // Isolate ambiguity; never replay it automatically or stop unrelated jobs.
      }finally{this.activeJobId=null;}
    }
  }
  // ---- Slack -> WeChat ----
  indexSlackReferences(messages){
    for(const m of messages){
      if(!validTs(m.ts))continue;
      const threadTs=validTs(m.thread_ts)?m.thread_ts:m.ts;
      if(m.user===this.config.slackUser){
        const jobs=this.state.jobs.filter(j=>j.slackTs===m.ts||m.files?.some(f=>j.slackFileIds?.includes(f.id)||
          (j.phase==='sending'&&Object.values(j.mediaUploads||{}).some(u=>u.stage==='sharing'&&u.fileId===f.id))));
        if(jobs.length!==1)continue;
        const job=jobs[0];
        // Exact file ID in the bound owner's DM is a positive share receipt.
        // Never infer delivery from similar filenames/text or absence of a result.
        if(job.phase==='sending'){
          let recovered=false;
          for(const u of Object.values(job.mediaUploads||{}))if(u.stage==='sharing'&&m.files?.some(f=>f.id===u.fileId)){
            u.stage='shared';job.slackFileIds=[...new Set([...(job.slackFileIds||[]),u.fileId])];recovered=true;
          }
          if(recovered&&!Object.values(job.mediaUploads).some(u=>u.stage==='sharing')){
            job.phase='queued';delete job.deferUntil;job.reconciledAt=this.now();
          }
        }
        // Earlier file shares in a bundle must not move the instruction's topic.
        // Still reconcile their exact receipts above if a share was interrupted.
        if(job.bundledIds&&!m.files?.some(f=>f.id===job.taskFileId))continue;
        job.slackTs=m.ts;job.threadTs=threadTs;
        const old=this.state.references.find(r=>r.key==='wx:'+job.id);
        putReference(this.state,{key:'wx:'+job.id,role:'user',weixinIds:job.weixinIds||[job.id],
          text:old?.text||slackMessageText(m)||m.files?.map(f=>f.name).join('\n')||'',slackTs:m.ts,threadTs});
        for(const id of job.bundledIds||[]){
          const source=this.state.references.find(r=>r.key==='wx:'+id);
          if(source){source.slackTs=m.ts;source.threadTs=threadTs;}
        }
        for(const follow of this.state.jobs)if(follow.followUpTo===job.id&&!follow.threadTs){
          follow.threadTs=threadTs;
          const ref=this.state.references.find(r=>r.key==='wx:'+follow.id);
          if(ref)ref.threadTs=threadTs;
        }
      }else if(m.user===this.config.slackAssistantUser){
        // Index only replies actually delivered to this WeChat conversation.
        const entry=this.state.outbox.find(o=>o.ts===m.ts&&!isReactionEntry(o)&&(o.phase==='sent'||o.textSent));
        const old=this.state.references.find(r=>r.key==='slack:'+m.ts);
        if(entry)putReference(this.state,{key:'slack:'+m.ts,role:'assistant',slackTs:m.ts,threadTs,
          text:old?.text||slackMessageText(m)||m.files?.map(f=>f.name).join('\n')||'',
          ...(entry.weixinIds?{weixinIds:entry.weixinIds}:{})});
      }
    }
    if(!this.state.lastVisibleKey){
      const visible=[...this.state.jobs.map(j=>({key:'wx:'+j.id,at:j.receivedAt||j.created||0})),
        ...this.state.outbox.filter(o=>o.phase==='sent').map(o=>({
          key:reactionRefKey(o)||'slack:'+o.ts,at:o.sentAt||0}))]
        .sort((a,b)=>b.at-a.at)[0];
      if(visible)this.state.lastVisibleKey=visible.key;
    }
  }
  replyReference(entry){
    if(isReactionEntry(entry))return this.state.references.find(r=>r.key==='wx:'+entry.sourceJobId);
    // Slack identifies a topic by its thread root. The latest user message in
    // that thread before this reply is the closest explicit reply target.
    return this.state.references.filter(r=>r.role==='user'&&topicOf(r)===entry.replyTo&&
      validTs(r.slackTs)&&Number(r.slackTs)<Number(entry.ts))
      .sort((a,b)=>Number(b.slackTs)-Number(a.slackTs))[0];
  }
  quoteFor(entry){
    const target=this.replyReference(entry);
    const previous=this.state.references.find(r=>r.key===this.state.lastVisibleKey);
    return target&&topicOf(target)!==topicOf(previous)?nativeQuote(target):undefined;
  }
  recordDelivery(entry,receipt,text){
    const id=exactId(receipt?.message_id);
    if(id)entry.weixinIds=[...new Set([...(entry.weixinIds||[]),id])];
    const target=this.replyReference(entry);
    const key=reactionRefKey(entry)||'slack:'+entry.ts;
    putReference(this.state,{key,role:'assistant',text,
      ...(!isReactionEntry(entry)?{slackTs:entry.ts}:{}),
      threadTs:topicOf(target)||entry.replyTo||entry.ts,
      ...(entry.weixinIds?{weixinIds:entry.weixinIds}:{})});
    this.state.lastVisibleKey=key;
  }
  // Keep the persisted eyes_* identifiers so prior acknowledgements still dedupe.
  collectReactions(messages){
    const reactionBoundary=Math.min(this.state.eyesActiveFrom,this.state.thumbsupActiveFrom);
    const jobs=this.state.jobs.filter(j=>j.phase==='posted'&&!j.bundledInto&&j.created>=reactionBoundary);
    const acknowledged=new Set(this.state.outbox.filter(o=>o.kind==='eyes_ack').map(o=>o.sourceJobId));
    const liked=new Set(this.state.outbox.filter(o=>o.kind==='thumbsup_ack').map(o=>o.sourceJobId));
    for(const m of [...messages].sort((a,b)=>Number(a.ts)-Number(b.ts))){
      if(m.user!==this.config.slackUser||!validTs(m.ts))continue;
      const assistantReactions=(m.reactions||[]).filter(r=>r.name&&r.users?.includes(this.config.slackAssistantUser));
      if(!assistantReactions.length)continue;
      const matches=jobs.filter(j=>j.slackTs===m.ts||m.files?.some(f=>j.bundledIds?j.taskFileId===f.id:j.slackFileIds?.includes(f.id)));
      if(matches.length!==1)continue;
      const job=matches[0],sourceId=job.followUpTo||job.id,msgMs=Number(m.ts)*1000;
      const hasThumbsUp=assistantReactions.some(r=>isThumbsUpReaction(r.name));
      if(hasThumbsUp){
        if(job.created>=this.state.thumbsupActiveFrom&&msgMs>=this.state.thumbsupActiveFrom&&!liked.has(sourceId)){
          liked.add(sourceId);
          this.state.outbox.push({ts:m.ts,kind:'thumbsup_ack',sourceJobId:sourceId,text:'👍',files:[],
            phase:'queued',collectedAt:this.now(),clientId:randomUUID()});
        }
        continue;
      }
      if(job.created<this.state.eyesActiveFrom||msgMs<this.state.eyesActiveFrom)continue;
      if(acknowledged.has(sourceId)||liked.has(sourceId))continue;
      // If the full threaded reply was collected on a previous poll, a newly
      // observed reaction would be a stale waiting notice. Same-poll
      // reaction and reply still arrive in the natural order: acknowledgement first.
      if(this.state.outbox.some(o=>!isReactionEntry(o)&&o.replyTo===(job.threadTs||m.ts)&&Number(o.ts)>Number(m.ts)))continue;
      acknowledged.add(sourceId);
      this.state.outbox.push({ts:m.ts,kind:'eyes_ack',sourceJobId:sourceId,text:'稍等',files:[],
        phase:'queued',collectedAt:this.now(),clientId:randomUUID()});
    }
  }
  collectSlackMessages(messages){
    this.indexSlackReferences(messages);
    this.collectReactions(messages);
    const seen=new Set(this.state.outbox.filter(o=>!isReactionEntry(o)).map(o=>o.ts));
    const fresh=[...messages]
      .filter(m=>m.user===this.config.slackAssistantUser&&validTs(m.ts)&&!seen.has(m.ts)&&
        Number(m.ts)*1000>=this.state.slackActiveFrom&&m.streaming_state!=='in_progress'&&
        (!m.subtype||m.subtype==='bot_message'||m.subtype==='file_share'))
      .sort((a,b)=>Number(a.ts)-Number(b.ts));
    const added=new Set();
    for(const m of fresh){
      if(added.has(m.ts))continue; // Same message can arrive via main timeline and its thread.
      added.add(m.ts);
      const files=(m.files||[]).filter(f=>/^F[A-Z0-9]+$/.test(f?.id||'')).map(f=>({id:f.id,
        name:typeof f.name==='string'&&f.name?f.name:'slack-file',mimetype:f.mimetype||'',size:f.size,
        url_private_download:f.url_private_download||f.url_private||''}));
      const text=slackMessageText(m);
      if(!text.trim()&&!files.length)continue;
      this.state.outbox.push({ts:m.ts,...(validTs(m.thread_ts)?{replyTo:m.thread_ts}:{}),
        text,files,phase:'queued',collectedAt:this.now(),clientId:randomUUID()});
    }
    if(this.state.outbox.length>10000)throw Error('state_capacity_reached');
    this.save();
  }
  async slackBytes(file){
    if(this.reader?.downloadFile)try{return await this.reader.downloadFile(file);}catch(e){
      if(['rate_limited','transport_outcome_unknown'].includes(e.message))throw e;
    }
    const bytes=await this.connector.readFileBytes(file.id);
    if(Number.isSafeInteger(file.size)&&bytes.length!==file.size)throw Error('connector_file_size_mismatch');
    return bytes;
  }
  async returnQueued(){
    const EXPLICIT=['weixin_api_error','weixin_session_expired','rate_limited'];
    for(const entry of this.state.outbox.filter(o=>o.phase==='queued')){
      if(entry.phase!=='queued')continue;
      if(entry.replyTo&&this.state.outbox.slice(0,this.state.outbox.indexOf(entry)).some(o=>o.replyTo===entry.replyTo&&o.phase!=='sent'))continue;
      // Explicitly rejected earlier: retry after a defer, or immediately once
      // a newer inbound message brought a fresh context token.
      if(entry.deferUntil>this.now()&&entry.deferContext===(this.state.lastContext||''))continue;
      try{
        const context=this.state.lastContext||undefined;
        // Deliver the accompanying text independently so an unavailable file
        // cannot make the whole reply disappear. Checkpoint it before preparing
        // media, and never repeat it when a file retry or restart follows.
        if(entry.text?.trim()&&!entry.textSent){
          entry.phase='sending';this.save();
          const receipt=await this.weixin.send(this.config.weixinUserId,context,entry.text,entry.clientId,this.quoteFor(entry));
          this.recordDelivery(entry,receipt,entry.text);
          entry.textSent=true;entry.phase='queued';this.save();
        }
        // Download+CDN-upload is not delivery yet: prepare and persist the media
        // items first so a failure here stays retryable instead of "sending".
        entry.prepared=entry.prepared||[];entry.sentItems=entry.sentItems||0;
        for(let i=entry.prepared.length;i<entry.files.length;i++){
          const file=entry.files[i],bytes=await this.slackBytes(file);
          entry.prepared.push(await uploadOutboundMedia(this.weixin,
            {bytes,kind:outboundKind(file.mimetype),name:file.name,toUserId:this.config.weixinUserId},this.fetcher));
          this.save();
        }
        entry.phase='sending';delete entry.deferUntil;delete entry.deferContext;this.save();
        while(entry.sentItems<entry.prepared.length){
          const item=entry.prepared[entry.sentItems],quote=this.quoteFor(entry);
          const receipt=await this.weixin.sendItems(this.config.weixinUserId,context,
            [{...item,...(quote?{ref_msg:quote}:{})}],randomUUID());
          const ref=this.state.references.find(r=>r.key==='slack:'+entry.ts);
          this.recordDelivery(entry,receipt,ref?.text||entry.files[entry.sentItems]?.name||'[附件]');
          entry.sentItems++;this.save();
        }
      }catch(e){
        // Unknown outcome mid-send stays "sending" for manual review. Anything
        // else (explicit rejection, or failure before delivery began) requeues.
        if(fatalStateError(e))throw e;
        if(entry.phase==='sending'&&!EXPLICIT.includes(e.message)){
          entry.lastDeliveryError=errorMetadata(e,this.now());this.save();continue;
        }
        const code=/^(?:(?:weixin|slack|connector|invalid|unapproved)_[a-z_]+|rate_limited|transport_outcome_unknown|remote_http_error|request_timeout)$/.test(e.message)
          ?e.message:'reply_delivery_failed';
        entry.lastDeliveryError={code,at:this.now(),
          ...(Number.isSafeInteger(e.remoteCode)?{remoteCode:e.remoteCode}:{})};
        entry.phase='queued';deferItem(entry,e,this.now());
        entry.deferContext=this.state.lastContext||'';this.save();continue;
      }
      entry.phase='sent';entry.sentAt=this.now();delete entry.text;delete entry.files;delete entry.prepared;
      delete entry.lastDeliveryError;
      delete entry.lastError;delete entry.attempts;
      delete entry.sentItems;delete entry.textSent;this.save();
    }
  }
}
