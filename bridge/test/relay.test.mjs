import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay } from '../src/relay.mjs';
import { fetchSlackMessages } from '../src/relay-loop.mjs';
import { encryptAesEcb } from '../src/weixin-media.mjs';
import { encode,isWav } from 'silk-wasm';
const config={slackTeam:'T',slackUser:'U',slackChannel:'D',slackAssistantUser:'A',weixinUserId:'W',weixinBotId:'B'};
const KEY=Buffer.from('00112233445566778899aabbccddeeff','hex');
const VOICE_SAMPLE=Buffer.from((await encode(Buffer.alloc(9600),24000)).data);
const message=(extra={})=>({message_id:'18446744073709551615',from_user_id:'W',to_user_id:'B',create_time_ms:101,
  message_type:1,message_state:2,context_token:'test-context',item_list:[{type:1,text_item:{text:'hello'}}],...extra});
const fileMessage=id=>message({message_id:id,item_list:[{type:4,file_item:{file_name:'notes.txt',len:'5',
  media:{encrypt_query_param:'PARAM',aes_key:Buffer.from(KEY.toString('hex')).toString('base64'),encrypt_type:1}}}]});
const voiceMessage=(id,transcript='spoken hello')=>message({message_id:id,item_list:[{type:3,voice_item:{
  text:transcript,encode_type:4,playtime:1000,
  media:{encrypt_query_param:'VOICE',aes_key:Buffer.from(KEY.toString('hex')).toString('base64'),encrypt_type:1}}}]});
function fixture(){
  let saved=null;const writes=[],uploads=[],returns=[],items=[];
  const store={load:()=>saved&&structuredClone(saved),save:s=>{saved=structuredClone(s);}};
  const connector={post:async text=>{writes.push(text);return{channel:'D',ts:'1.000001'};},
    uploadFile:async f=>{uploads.push(f);return{fileId:'F1'};},readFileBytes:async()=>Buffer.from('slack-bytes')};
  const weixin={send:async(...args)=>returns.push(args),sendItems:async(...args)=>items.push(args),getUploadUrl:async()=>({upload_param:'UP'})};
  const fetcher=async(url)=>{
    if(String(url).includes('/download?'))return new Response(encryptAesEcb(
      new URL(url).searchParams.get('encrypted_query_param')==='VOICE'?VOICE_SAMPLE:Buffer.from('hello'),KEY));
    if(String(url).includes('/upload?'))return new Response('',{headers:{'x-encrypted-param':'DOWN'}});
    throw Error('unexpected synthetic fetch');
  };
  const restart=()=>new Relay({config,store,connector,weixin,fetcher,activeFrom:100,now:()=>200});
  return {writes,uploads,returns,items,restart,connector,weixin,store,fetcher};
}

test('interleaved topics quote on return, while consecutive user/ack/AI messages in one topic do not',async()=>{
  const f=fixture(),b=f.restart();let sequence=1;
  f.connector.post=async()=>({channel:'D',ts:`${sequence++}.000001`});
  b.ingest({msgs:[message({message_id:'hotel',item_list:[{type:1,text_item:{text:'双床房'}}]})]});
  await b.sendQueued();
  b.collectSlackMessages([{user:'A',ts:'1.5',thread_ts:'1.000001',text:'酒店回复'}]);await b.returnQueued();
  assert.equal(f.returns.at(-1)[4],undefined);
  b.ingest({msgs:[message({message_id:'business',item_list:[{type:1,text_item:{text:'营业额'}}]})]});
  await b.sendQueued();
  b.collectSlackMessages([{user:'A',ts:'3.0',thread_ts:'1.000001',text:'酒店补充'}]);await b.returnQueued();
  assert.equal(f.returns.at(-1)[4].svr_id,'hotel');
  assert.equal(f.returns.at(-1)[4].message_item.text_item.text,'双床房');
  b.collectSlackMessages([{user:'A',ts:'4.0',thread_ts:'1.000001',text:'酒店再补充'}]);await b.returnQueued();
  assert.equal(f.returns.at(-1)[4],undefined);
  const restored=f.restart();
  restored.collectSlackMessages([{user:'A',ts:'5.0',thread_ts:'2.000001',text:'营业额答复'}]);await restored.returnQueued();
  assert.equal(f.returns.at(-1)[4].svr_id,'business');
});

test('quoting an AI answer or a user follow-up reuses the root thread across restarts',async()=>{
  const f=fixture(),b=f.restart(),posts=[];
  let sequence=1;
  f.connector.post=async(text,options)=>{posts.push({text,options});return{channel:'D',ts:`${sequence++}.000001`};};
  f.weixin.send=async(...args)=>{f.returns.push(args);return{message_id:'18446744073709551615'};};
  b.ingest({msgs:[message({message_id:'original'})]});await b.sendQueued();
  b.collectSlackMessages([{user:'A',ts:'1.5',thread_ts:'1.000001',text:'answer'}]);await b.returnQueued();
  const restored=f.restart();
  restored.ingest({msgs:[message({message_id:'follow-up',item_list:[{type:1,text_item:{text:'really?'},
    ref_msg:{svr_id:'18446744073709551615'}}]})]});await restored.sendQueued();
  assert.deepEqual(posts.at(-1),{text:'really?',options:{threadTs:'1.000001'}});
  restored.collectSlackMessages([{user:'A',ts:'3.0',thread_ts:'1.000001',text:'confirmed'}]);await restored.returnQueued();
  assert.equal(f.returns.at(-1)[4],undefined);
  restored.ingest({msgs:[message({message_id:'follow-again',item_list:[{type:1,text_item:{text:'more'},
    ref_msg:{svr_id:'follow-up'}}]})]});await restored.sendQueued();
  assert.equal(posts.at(-1).options.threadTs,'1.000001');
});

test('inline legacy quote resolves exactly; ambiguous or missing quotes never become new topics',async()=>{
  const f=fixture(),b=f.restart();let sequence=1;const posts=[];
  f.connector.post=async(text,options)=>{posts.push(options);return{channel:'D',ts:`${sequence++}.000001`};};
  b.ingest({msgs:[message({message_id:'first'})]});await b.sendQueued();
  b.ingest({msgs:[message({message_id:'quote',item_list:[{type:1,text_item:{text:'follow'},
    ref_msg:{message_item:{type:1,text_item:{text:'hello'}}}}]})]});await b.sendQueued();
  assert.equal(posts.at(-1).threadTs,'1.000001');
  b.ingest({msgs:[message({message_id:'duplicate'})]});await b.sendQueued();
  for(const [id,text] of [['ambiguous','hello'],['missing','unknown']]){
    b.ingest({msgs:[message({message_id:id,item_list:[{type:1,text_item:{text:'follow'},
      ref_msg:{message_item:{type:1,text_item:{text}}}}]})]});
  }
  await b.sendQueued();assert.equal(posts.length,3);
  assert.ok(b.state.jobs.slice(-2).every(j=>j.phase==='queued'&&j.lastRoutingError==='quoted_message_unresolved'));
});

test('file receipts recover user references and old sent AI content without replaying messages',async()=>{
  const f=fixture(),b=f.restart();
  b.state.jobs.push({id:'old-voice',phase:'posted',slackFileIds:['FOLD']});
  b.state.outbox.push({ts:'2.0',replyTo:'1.0',phase:'sent'});
  b.indexSlackReferences([{user:'U',ts:'1.0',text:'spoken question',files:[{id:'FOLD'}]},
    {user:'A',ts:'2.0',thread_ts:'1.0',text:'old answer'}]);
  b.save();const restored=f.restart();
  const posts=[];f.connector.post=async(text,options)=>{posts.push(options);return{channel:'D',ts:'3.0'};};
  restored.ingest({msgs:[message({message_id:'new',item_list:[{type:1,text_item:{text:'follow'},
    ref_msg:{message_item:{type:1,text_item:{text:'old answer'}}}}]})]});
  await restored.sendQueued();assert.equal(posts[0].threadTs,'1.0');assert.equal(f.returns.length,0);
});

test('old thread replies remain discoverable after their parent leaves the history window',async()=>{
  const f=fixture(),b=f.restart();b.state.slackWatermark=10000000;
  b.state.jobs.push({id:'old',phase:'posted',slackTs:'1.0'});
  const calls=[];
  const reader={historySince:async()=>[],replies:async root=>{calls.push(root);
    return[{user:'A',ts:'10001.0',thread_ts:'1.0',text:'late answer'}];}};
  const fetched=await fetchSlackMessages(b,reader);b.collectSlackMessages(fetched.messages);await b.returnQueued();
  assert.deepEqual(calls,['1.0']);assert.equal(f.returns.at(-1)[2],'late answer');
});

test('eyes acknowledgement belongs to its topic and does not cause a redundant quote on the answer',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message({message_id:'hotel'})]});await b.sendQueued();
  b.ingest({msgs:[message({message_id:'other',item_list:[{type:1,text_item:{text:'different topic'}}]})]});
  b.collectSlackMessages([eyesMessage(),{user:'A',ts:'2.000001',thread_ts:'1.000001',text:'answer'}]);
  await b.returnQueued();
  assert.equal(f.returns[0][4].svr_id,'hotel');assert.equal(f.returns[1][4],undefined);
});

test('quoted voice uploads into the original topic and a late file reply carries a native quote',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message({message_id:'original'})]});await b.sendQueued();
  const voice=voiceMessage('quoted-voice');voice.item_list[0].ref_msg={svr_id:'original'};
  b.ingest({msgs:[voice]});await b.sendQueued();assert.equal(f.uploads[0].threadTs,'1.000001');
  b.ingest({msgs:[message({message_id:'other'})]});
  b.collectSlackMessages([{user:'U',ts:'2.0',thread_ts:'1.000001',text:'spoken hello',files:[{id:'F1'}]},
    {user:'A',ts:'3.0',thread_ts:'1.000001',files:[{id:'F9',name:'doc.pdf',mimetype:'application/pdf',size:11}]}]);
  await b.returnQueued();assert.equal(f.items[0][2][0].ref_msg.svr_id,'quoted-voice');
});

test('WeChat text forwards to Slack exactly as-is; other peer, history and duplicates excluded',async()=>{
  const f=fixture(),b=f.restart();
  b.ingest({msgs:[message(),message(),message({from_user_id:'X'}),message({message_id:'old',create_time_ms:99})],get_updates_buf:'c'});
  assert.equal(b.state.jobs.length,1);
  await b.sendQueued();await f.restart().sendQueued();
  assert.deepEqual(f.writes,['hello']);assert.equal(f.restart().state.cursor,'c');
});

test('file-only WeChat message waits untouched until a text message releases it first',async()=>{
  const f=fixture(),b=f.restart();
  b.ingest({msgs:[fileMessage('f1')]});await b.sendQueued();
  assert.equal(f.uploads.length,0);assert.equal(b.state.jobs[0].phase,'staged');
  b.ingest({msgs:[message({message_id:'t1'})]});await b.sendQueued();
  assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].bytes.toString(),'hello');
  assert.equal(f.uploads[0].initialComment,'hello');
  assert.deepEqual(f.writes,[]);assert.deepEqual(b.state.jobs.map(j=>j.phase),['posted','posted']);
});

test('WeChat voice transcript forwards immediately and releases staged attachments first',async()=>{
  const f=fixture(),b=f.restart();
  b.ingest({msgs:[fileMessage('f1')]});await b.sendQueued();
  assert.equal(b.state.jobs[0].phase,'staged');assert.equal(f.uploads.length,0);
  b.ingest({msgs:[voiceMessage('v1')]});
  assert.equal(b.state.jobs[1].phase,'queued');assert.equal(b.state.jobs[1].text,'spoken hello');
  await b.sendQueued();
  assert.equal(f.uploads.length,2);assert.equal(f.uploads[0].initialComment,undefined);
  assert.equal(f.uploads[1].initialComment,'spoken hello');assert.deepEqual(f.writes,[]);
  assert.equal(f.uploads[1].filename,'weixin-voice-v1.wav');assert.equal(f.uploads[1].contentType,'audio/wav');
  assert.ok(isWav(f.uploads[1].bytes));assert.equal(b.state.jobs[1].voiceUpload.contentType,'audio/wav');
  assert.deepEqual(b.state.jobs.map(j=>j.phase),['posted','posted']);
});

test('previously staged voice jobs restore their transcripts and queue on restart',async()=>{
  const f=fixture(),b=f.restart();
  b.state.jobs.push({id:'old-voice',created:101,receivedAt:150,phase:'staged',text:'',context:'test-context',
    media:[{kind:'voice',item:{text:'old spoken words',encode_type:4,playtime:1000,
      media:{encrypt_query_param:'VOICE',aes_key:Buffer.from(KEY.toString('hex')).toString('base64'),encrypt_type:1}}}]});
  b.save();
  const restored=f.restart();
  assert.equal(restored.state.jobs[0].phase,'queued');assert.equal(restored.state.jobs[0].text,'old spoken words');
  await restored.sendQueued();assert.equal(f.uploads[0].initialComment,'old spoken words');
  assert.deepEqual(f.writes,[]);
});

test('upload start failure requeues a voice job without stranding it in sending',async()=>{
  const f=fixture(),b=f.restart();
  const workingUpload=f.connector.uploadFile;
  f.connector.uploadFile=async()=>{throw Error('connector_upload_start_invalid');};
  b.ingest({msgs:[voiceMessage('v-retry')]});
  await b.sendQueued();
  assert.equal(b.state.jobs[0].phase,'queued');assert.equal(b.uncertain,false);assert.deepEqual(f.writes,[]);
  f.connector.uploadFile=workingUpload;b.state.jobs[0].deferUntil=0;
  await b.sendQueued();
  assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].initialComment,'spoken hello');
  assert.deepEqual(f.writes,[]);assert.equal(b.state.jobs[0].phase,'posted');
});

test('assistant Slack messages return as-is without reply mapping; owner messages ignored',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  b.collectSlackMessages([{user:'U',ts:'1.5',text:'owner typing in Slack'},
    {user:'A',ts:'2.0',text:'free-standing answer'},{user:'A',ts:'2.0',text:'duplicate'}]);
  await b.returnQueued();
  assert.equal(f.returns.length,1);assert.deepEqual(f.returns[0].slice(0,3),['W','test-context','free-standing answer']);
  const restored=f.restart();restored.collectSlackMessages([{user:'A',ts:'2.0',text:'free-standing answer'}]);
  await restored.returnQueued();assert.equal(f.returns.length,1);
});

test('file-only Slack message forwards immediately without waiting for text',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  b.collectSlackMessages([{user:'A',ts:'2.0',text:'',files:[{id:'F9',name:'doc.pdf',mimetype:'application/pdf',size:11}]}]);
  await b.returnQueued();
  assert.equal(f.items.length,1);assert.equal(f.items[0][2][0].file_item.file_name,'doc.pdf');
  assert.equal(b.state.outbox[0].phase,'sent');assert.equal(f.returns.length,0);
});

test('Slack display formatting persists across restart and sends once, including block-only messages',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});
  const blocks=[{type:'rich_text',elements:[
    {type:'rich_text_section',elements:[{type:'text',text:'行程：\n\n'}]},
    {type:'rich_text_list',style:'bullet',elements:[
      {type:'rich_text_section',elements:[{type:'text',text:'奥赛'}]},
      {type:'rich_text_section',elements:[{type:'text',text:'卢浮宫'}]}]}]}];
  b.collectSlackMessages([{user:'A',ts:'2.0',text:'行程： • 奥赛 • 卢浮宫',blocks},
    {user:'A',ts:'3.0',blocks}, {user:'U',ts:'4.0',blocks},
    {user:'A',ts:'5.0',blocks,streaming_state:'in_progress'}]);
  const restored=f.restart();await restored.returnQueued();
  assert.deepEqual(f.returns.map(args=>args[2]),['行程：\n\n• 奥赛\n• 卢浮宫','行程：\n\n• 奥赛\n• 卢浮宫']);
  restored.collectSlackMessages([{user:'A',ts:'2.0',blocks}]);
  await restored.returnQueued();assert.equal(f.returns.length,2);
});

test('explicit Weixin rejection requeues; a fresh context token flushes it at once',async()=>{
  const f=fixture(),b=f.restart();
  f.weixin.send=async(user,context,text,id)=>{
    if(!context)throw Object.assign(Error('weixin_api_error'),{remoteCode:-2,remoteText:'sensitive'});
    f.returns.push([user,context,text,id]);
  };
  b.collectSlackMessages([{user:'A',ts:'2.0',text:'early answer'}]);
  await b.returnQueued();
  assert.equal(f.returns.length,0);assert.equal(b.state.outbox[0].phase,'queued');assert.equal(b.uncertain,false);
  assert.deepEqual(f.restart().state.outbox[0].lastDeliveryError,{code:'weixin_api_error',at:200,remoteCode:-2});
  b.ingest({msgs:[message()]});await b.returnQueued();
  assert.equal(f.returns.length,1);assert.equal(f.returns[0][1],'test-context');
  assert.equal(f.restart().state.outbox[0].lastDeliveryError,undefined);
});

test('legacy queued and repair-unmapped payloads remain resumable',async()=>{
  let saved={version:4,binding:JSON.stringify(['T','U','D','A','W','B']),activeFrom:100,slackActiveFrom:100,cursor:'c',lastContext:'test-context',
    jobs:[{id:'j1',phase:'unmapped',text:'synthetic',context:'test-context'}],
    outbox:[{ts:'2.0',phase:'unmapped',text:'synthetic reply',files:[],clientId:'x'}]};
  const store={load:()=>structuredClone(saved),save:s=>{saved=structuredClone(s);}};
  const writes=[],returns=[];
  const b=new Relay({config,store,connector:{post:async text=>{writes.push(text);return{channel:'D',ts:'3.0'};}},
    weixin:{send:async(...args)=>returns.push(args)},activeFrom:999,now:()=>5000});
  await b.sendQueued();await b.returnQueued();
  assert.deepEqual(writes,['synthetic']);assert.equal(returns[0][2],'synthetic reply');
});

test('unknown state versions fail rather than discarding data',()=>{
  assert.throws(()=>new Relay({config,store:{load:()=>({version:2,binding:'[]',activeFrom:1,jobs:[],outbox:[]})},
    connector:{},weixin:{},activeFrom:1}),/state_binding_mismatch/);
});

test('Slack polling reads only the watermark window, including recent thread replies',async()=>{
  const f=fixture(),b=f.restart();b.state.slackWatermark=1000000;
  let oldestSeen;const calls=[];
  const reader={historySince:async o=>{oldestSeen=o;return[{user:'U',ts:'999.9',reply_count:1,latest_reply:'1000.5'},
    {user:'A',ts:'1000.5',text:'main'}];},
    replies:async root=>{calls.push(root);return[{user:'A',ts:'1000.5',thread_ts:'999.9',text:'thread'}];}};
  const {messages,watermark}=await fetchSlackMessages(b,reader);
  assert.equal(oldestSeen,'400');assert.deepEqual(calls,['999.9']);assert.equal(messages.length,3);assert.equal(watermark,1000500);
});

test('fractional Slack watermark recovers missed replies and stays deduplicated after restart',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});
  const lastRead='1793969988.596939';
  b.state.slackWatermark=Number(lastRead)*1000;
  const newest={user:'A',ts:'1793970004.257709',text:'missed reply'};
  // Reproduce the live API behavior: an over-precise lower bound yields an
  // empty page, even though a new assistant reply exists in the requested window.
  const reader={historySince:async oldest=>{
    if(!/^\d+(?:\.\d{1,6})?$/.test(oldest))return [];
    assert.ok(Number(oldest)*1000<=b.state.slackWatermark-600000);
    return [newest];
  }};
  assert.deepEqual(await reader.historySince(String((b.state.slackWatermark-600000)/1000)),[]);
  const fetched=await fetchSlackMessages(b,reader);
  assert.equal(fetched.messages.length,1);
  b.state.slackWatermark=fetched.watermark;b.collectSlackMessages(fetched.messages);
  await b.returnQueued();assert.deepEqual(f.returns.map(args=>args[2]),['missed reply']);
  const restored=f.restart(),again=await fetchSlackMessages(restored,reader);
  restored.collectSlackMessages(again.messages);await restored.returnQueued();
  assert.equal(f.returns.length,1);
  assert.equal(restored.state.slackWatermark,Number(newest.ts)*1000);
});

test('Slack poll lower bound stays valid for fractional, integral and activation boundaries',async()=>{
  for(const watermark of [1793969988596.939,1793970004257.709,1793970092714.399,1000000,0]){
    const state={slackActiveFrom:1793960000123,slackWatermark:watermark};
    const fromMs=Math.max(state.slackActiveFrom,(watermark||state.slackActiveFrom)-600000);
    await fetchSlackMessages({state},{historySince:async oldest=>{
      assert.match(oldest,/^\d+$/);
      assert.ok(Number(oldest)*1000<=fromMs);
      assert.ok(fromMs-Number(oldest)*1000<1000);
      return [];
    }});
  }
});

test('attachment preparation failures retain the file while accompanying text is sent only once',async()=>{
  for(const fault of ['prepare','unavailable','size']){
    const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
    b.collectSlackMessages([{user:'A',ts:'2.0',text:'with file',
      files:[{id:'F9',name:'d.bin',mimetype:'application/octet-stream',size:fault==='size'?999:11}]}]);
    if(fault==='prepare')f.weixin.getUploadUrl=async()=>{throw Error('weixin_api_error');};
    if(fault==='unavailable')f.connector.readFileBytes=async()=>{throw Error('connector_file_bytes_unavailable');};
    await b.returnQueued();assert.equal(f.items.length,0);assert.equal(f.returns.length,1);
    const again=f.restart();assert.equal(again.state.outbox[0].phase,'queued');assert.equal(again.uncertain,false);
    assert.equal(again.state.outbox[0].textSent,true);assert.ok(again.state.outbox[0].lastDeliveryError);
    again.state.outbox[0].deferUntil=0;await again.returnQueued();assert.equal(f.returns.length,1);
    f.weixin.getUploadUrl=async()=>({upload_param:'UP'});
    f.connector.readFileBytes=async()=>Buffer.from('slack-bytes');
    again.state.outbox[0].files[0].size=11;again.state.outbox[0].deferUntil=0;
    await again.returnQueued();assert.equal(f.items.length,1);assert.equal(f.returns.length,1);
    assert.equal(again.state.outbox[0].phase,'sent');
  }
});

test('unavailable file does not block an independent reply in the same pass',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});
  b.collectSlackMessages([{user:'A',ts:'2.0',text:'file reply',files:[{id:'F9',name:'a.pdf',size:11}]},
    {user:'A',ts:'3.0',text:'independent reply'}]);
  f.connector.readFileBytes=async()=>{throw Error('connector_file_bytes_unavailable');};
  await b.returnQueued();
  assert.deepEqual(f.returns.map(args=>args[2]),['file reply','independent reply']);
  assert.deepEqual(b.state.outbox.map(o=>o.phase),['queued','sent']);
});

test('uncertain accompanying-text delivery remains stopped on restart',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});
  b.collectSlackMessages([{user:'A',ts:'2.0',text:'file reply',files:[{id:'F9',name:'a.pdf',size:11}]}]);
  f.weixin.send=async()=>{throw Error('transport_outcome_unknown');};
  await b.returnQueued();
  assert.equal(b.state.outbox[0].phase,'sending');
  await f.restart().returnQueued();
  assert.equal(f.items.length,0);
});

test('ambiguous sends stop after restart without duplicate writes',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});
  let calls=0;f.connector.post=async()=>{calls++;throw Error('timeout');};await b.sendQueued();
  await f.restart().sendQueued();assert.equal(calls,1);assert.equal(b.state.jobs[0].phase,'sending');
});

const eyesMessage=(extra={})=>({user:'U',ts:'1.000001',reactions:[{name:'eyes',users:['A'],count:1}],...extra});

test('Hilly eyes on a relayed text sends one acknowledgement across polls, removal and restart',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  b.collectSlackMessages([eyesMessage(),eyesMessage()]);await b.returnQueued();
  assert.deepEqual(f.returns.map(args=>args[2]),['稍等']);
  assert.equal(b.state.outbox[0].kind,'eyes_ack');
  const again=f.restart();
  again.collectSlackMessages([eyesMessage({reactions:[]})]);
  again.collectSlackMessages([eyesMessage()]);await again.returnQueued();
  assert.equal(f.returns.length,1);
});

test('voice upload receipt identifies the corresponding Slack file reaction',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[voiceMessage('voice-eyes')]});await b.sendQueued();
  assert.deepEqual(f.restart().state.jobs[0].slackFileIds,['F1']);
  assert.equal(b.state.jobs[0].slackTs,undefined);
  b.collectSlackMessages([eyesMessage({ts:'2.000001',files:[{id:'F1'}]})]);
  await b.returnQueued();assert.deepEqual(f.returns.map(args=>args[2]),['稍等']);
  assert.equal(b.state.outbox[0].sourceJobId,'voice-eyes');
});

test('only Hilly reactions on a uniquely matched WeChat-origin message can acknowledge',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  for(const m of [eyesMessage({reactions:[{name:'eyes',users:['U']}]}),
    eyesMessage({reactions:[{name:'+1',users:['U']}]}),
    eyesMessage({reactions:[{name:'thumbsup',users:['U']}]}),eyesMessage({reactions:[{name:'eyes',count:1}]}),
    eyesMessage({reactions:[{name:'+1',count:1}]}),
    eyesMessage({user:'OTHER'}),eyesMessage({ts:'9.000001'}),eyesMessage({ts:'9.000002',files:[{id:'FUNRELATED'}]})])
    b.collectSlackMessages([m]);
  await b.returnQueued();assert.equal(f.returns.length,0);
});

test('any non-thumbsup Hilly emoji sends 稍等 once even when changed after restart',async()=>{
  for(const name of ['eyes','art','mag','custom_hilly']){
    const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
    b.collectSlackMessages([eyesMessage({reactions:[{name,users:['A']},{name:'heart',users:['A']}]})]);
    await b.returnQueued();
    assert.deepEqual(f.returns.map(args=>args[2]),['稍等']);
    const again=f.restart();
    again.collectSlackMessages([eyesMessage({reactions:[]})]);
    again.collectSlackMessages([eyesMessage({reactions:[{name:'wave',users:['A']}]})]);
    await again.returnQueued();assert.equal(f.returns.length,1);
  }
});

test('Hilly thumbs-up reactions forward 👍 instead of 稍等 once across polls, skin tones and restart',async()=>{
  for(const name of ['+1','thumbsup','+1::skin-tone-2','thumbsup::skin-tone-4']){
    const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
    b.collectSlackMessages([eyesMessage({reactions:[{name,users:['A']}]})]);
    await b.returnQueued();
    assert.deepEqual(f.returns.map(args=>args[2]),['👍']);
    assert.equal(b.state.outbox[0].kind,'thumbsup_ack');
    const again=f.restart();
    again.collectSlackMessages([eyesMessage({reactions:[]})]);
    again.collectSlackMessages([eyesMessage({reactions:[{name:'+1::skin-tone-5',users:['A']}]})]);
    again.collectSlackMessages([eyesMessage({reactions:[{name:'heart',users:['A']}]})]);
    await again.returnQueued();assert.equal(f.returns.length,1);
  }
});

test('eyes followed by thumbs-up across polls sends 稍等 then 👍; simultaneous eyes and thumbs-up sends only 👍',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  b.collectSlackMessages([eyesMessage()]);await b.returnQueued();
  assert.deepEqual(f.returns.map(args=>args[2]),['稍等']);
  b.collectSlackMessages([eyesMessage({reactions:[{name:'eyes',users:['A']},{name:'+1',users:['A']}]})]);
  await b.returnQueued();
  assert.deepEqual(f.returns.map(args=>args[2]),['稍等','👍']);
  const again=f.restart();
  again.collectSlackMessages([eyesMessage({reactions:[{name:'+1',users:['A']}]})]);
  await again.returnQueued();assert.equal(f.returns.length,2);

  const f2=fixture(),b2=f2.restart();b2.ingest({msgs:[message({message_id:'both'})]});await b2.sendQueued();
  b2.collectSlackMessages([eyesMessage({reactions:[{name:'eyes',users:['A']},{name:'+1',users:['A']}]})]);
  await b2.returnQueued();
  assert.deepEqual(f2.returns.map(args=>args[2]),['👍']);
});

test('thumbs-up after a full threaded reply still sends 👍 and interleaved topics quote the liked message',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message({message_id:'hotel'})]});await b.sendQueued();
  b.collectSlackMessages([{user:'A',ts:'2.000001',thread_ts:'1.000001',text:'实际回复'}]);
  await b.returnQueued();
  b.ingest({msgs:[message({message_id:'other',item_list:[{type:1,text_item:{text:'different topic'}}]})]});
  const again=f.restart();
  again.collectSlackMessages([eyesMessage({reactions:[{name:'+1',users:['A']}]})]);
  await again.returnQueued();
  assert.deepEqual(f.returns.map(args=>args[2]),['实际回复','👍']);
  assert.equal(f.returns[1][4].svr_id,'hotel');
  again.collectSlackMessages([{user:'A',ts:'3.000001',thread_ts:'1.000001',text:'同话题补充'}]);
  await again.returnQueued();
  assert.equal(f.returns[2][4],undefined);
});

test('thumbs-up activation boundary excludes historical +1 reactions and survives restart',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  delete b.state.thumbsupActiveFrom;b.save();
  const migrated=f.restart();assert.equal(migrated.state.thumbsupActiveFrom,200);
  migrated.collectSlackMessages([eyesMessage({reactions:[{name:'+1',users:['A']}]})]);
  await migrated.returnQueued();
  assert.equal(f.returns.length,0);assert.equal(f.restart().state.thumbsupActiveFrom,200);
  migrated.ingest({msgs:[voiceMessage('new-like-voice')]});
  migrated.state.jobs.at(-1).created=201;await migrated.sendQueued();
  migrated.collectSlackMessages([eyesMessage({ts:'2.000001',files:[{id:'F1'}],reactions:[{name:'+1',users:['A']}]})]);
  await migrated.returnQueued();assert.deepEqual(f.returns.map(args=>args[2]),['👍']);
});

test('feature activation excludes historical eyes and its boundary survives restart',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  delete b.state.eyesActiveFrom;b.save();
  const migrated=f.restart();assert.equal(migrated.state.eyesActiveFrom,200);
  migrated.collectSlackMessages([eyesMessage()]);await migrated.returnQueued();
  assert.equal(f.returns.length,0);assert.equal(f.restart().state.eyesActiveFrom,200);
  migrated.ingest({msgs:[voiceMessage('new-voice')]});
  migrated.state.jobs.at(-1).created=201;await migrated.sendQueued();
  migrated.collectSlackMessages([eyesMessage({ts:'2.000001',files:[{id:'F1'}]})]);
  await migrated.returnQueued();assert.deepEqual(f.returns.map(args=>args[2]),['稍等']);
});

test('same-poll acknowledgement precedes the full reply without changing reply content',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  b.collectSlackMessages([{user:'A',ts:'2.000001',thread_ts:'1.000001',text:'实际回复'},eyesMessage()]);
  await b.returnQueued();assert.deepEqual(f.returns.map(args=>args[2]),['稍等','实际回复']);
});

test('eyes first observed after the full threaded reply does not send a stale acknowledgement',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  b.collectSlackMessages([{user:'A',ts:'2.000001',thread_ts:'1.000001',text:'实际回复'}]);
  await b.returnQueued();
  const again=f.restart();again.collectSlackMessages([eyesMessage()]);await again.returnQueued();
  assert.deepEqual(f.returns.map(args=>args[2]),['实际回复']);
});

test('explicitly rejected acknowledgement remains a single durable retry',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  const send=f.weixin.send;f.weixin.send=async()=>{throw Object.assign(Error('weixin_api_error'),{remoteCode:-2});};
  b.collectSlackMessages([eyesMessage()]);await b.returnQueued();
  const again=f.restart();again.collectSlackMessages([eyesMessage()]);assert.equal(again.state.outbox.length,1);
  f.weixin.send=send;again.state.outbox[0].deferUntil=0;await again.returnQueued();
  assert.deepEqual(f.returns.map(args=>args[2]),['稍等']);
});

test('ambiguous acknowledgement delivery is not duplicated on restart',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});await b.sendQueued();
  b.collectSlackMessages([eyesMessage()]);f.weixin.send=async()=>{throw Error('transport_outcome_unknown');};
  await b.returnQueued();
  const again=f.restart();again.collectSlackMessages([eyesMessage()]);
  assert.equal(again.state.outbox.length,1);
  await again.returnQueued();
});

test('failed voice conversion sends its transcript once and retries only the audio after restart',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[voiceMessage('voice-fail')]});
  b.voiceConverter=async()=>{throw Error('voice_transcode_failed');};
  await b.sendQueued();
  assert.deepEqual(f.writes,['spoken hello']);assert.equal(f.uploads.length,0);
  assert.equal(b.state.jobs[0].phase,'queued');assert.equal(b.uncertain,false);
  assert.equal(b.state.jobs[0].lastPreparationError.code,'voice_transcode_failed');
  const again=f.restart();again.state.jobs[0].deferUntil=0;await again.sendQueued();
  assert.deepEqual(f.writes,['spoken hello']);assert.equal(f.uploads.length,1);
  assert.equal(f.uploads[0].initialComment,undefined);assert.ok(isWav(f.uploads[0].bytes));
  assert.equal(again.state.jobs[0].phase,'posted');assert.equal(again.state.jobs[0].lastPreparationError,undefined);
});

test('voice conversion failure does not block a later message and does not replay its transcript',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[voiceMessage('bad-voice'),message({message_id:'later'})]});
  b.voiceConverter=async()=>{throw Error('voice_audio_invalid');};await b.sendQueued();
  assert.deepEqual(f.writes,['spoken hello','hello']);
  b.state.jobs[0].deferUntil=0;await b.sendQueued();assert.equal(f.writes.length,2);
});

test('ambiguous transcript fallback is kept for review instead of being sent twice',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[voiceMessage('voice-unknown')]});
  b.voiceConverter=async()=>{throw Error('voice_audio_invalid');};
  f.connector.post=async()=>{throw Error('connector_timeout_outcome_unknown');};
  await b.sendQueued();
  assert.equal(b.state.jobs[0].phase,'sending');await f.restart().sendQueued();
});

test('failed upload preparation defers only that job and allows an independent message through',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[voiceMessage('bad'),message({message_id:'later'})]});
  f.connector.uploadFile=async()=>{throw Object.assign(Error('connector_rpc_error'),{stage:'upload_init',safeBeforeSend:true,rpcCode:-32000});};
  await b.sendQueued();assert.deepEqual(b.state.jobs.map(j=>j.phase),['queued','posted']);
  assert.equal(b.uncertain,false);assert.deepEqual(f.writes,['hello']);
  assert.equal(b.state.jobs[0].lastError.stage,'upload_init');assert.ok(b.state.jobs[0].deferUntil>200);
});

test('uncertain share is isolated across restart while unrelated messages and replies continue',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[voiceMessage('bad'),message({message_id:'later'})]});
  let calls=0;f.connector.uploadFile=async args=>{calls++;args.onCheckpoint({stage:'sharing',fileId:'F123'});throw Object.assign(Error('connector_rpc_error'),{stage:'upload_share',safeBeforeSend:false});};
  await b.sendQueued();assert.deepEqual(b.state.jobs.map(j=>j.phase),['sending','posted']);
  const again=f.restart();await again.sendQueued();assert.equal(calls,1);
  again.collectSlackMessages([{user:'A',ts:'2.0',text:'independent reply'}]);await again.returnQueued();
  assert.deepEqual(f.returns.map(x=>x[2]),['independent reply']);
});

test('an inbound arriving during a slow send cannot replace the in-flight job with stale state',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message({message_id:'first'})]});
  let complete;f.connector.post=()=>new Promise(resolve=>{complete=resolve;});
  const sending=b.sendQueued();await Promise.resolve();
  b.ingest({msgs:[message({message_id:'second'})],get_updates_buf:'new-cursor'});
  complete({channel:'D',ts:'1.0'});await sending;
  const again=f.restart();assert.deepEqual(again.state.jobs.map(j=>j.phase),['posted','queued']);assert.equal(again.state.cursor,'new-cursor');
});

test('bundled attachments and their instruction retry together while independent work continues',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[fileMessage('image'),message({message_id:'description'}),message({message_id:'independent'})]});
  f.connector.uploadFile=async()=>{throw Object.assign(Error('connector_rpc_error'),{safeBeforeSend:true,stage:'upload_init'});};
  await b.sendQueued();assert.deepEqual(b.state.jobs.map(j=>j.phase),['bundled','queued','posted']);assert.deepEqual(f.writes,['hello']);
});

test('multiple files wait through restart, join the next instruction, and do not replay',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[fileMessage('f1'),fileMessage('f2')]});
  await b.sendQueued();await f.restart().sendQueued();assert.equal(f.uploads.length,0);
  const resumed=f.restart();resumed.ingest({msgs:[message({message_id:'instruction'})]});
  assert.deepEqual(resumed.state.jobs.map(j=>j.phase),['bundled','bundled','queued']);
  assert.deepEqual(resumed.state.jobs[2].bundledIds,['f1','f2']);
  const ready=f.restart();await ready.sendQueued();
  assert.equal(f.uploads.length,2);assert.equal(f.uploads[0].initialComment,undefined);
  assert.equal(f.uploads[1].initialComment,'hello');assert.deepEqual(f.writes,[]);
  const done=f.restart();done.ingest({msgs:[fileMessage('f1'),message({message_id:'instruction'}),fileMessage('next')]});
  await done.sendQueued();assert.equal(f.uploads.length,2);
  assert.deepEqual(done.state.jobs.map(j=>j.phase),['posted','posted','posted','staged']);
});

test('voice without a transcript releases pending files and sends its audio immediately',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[fileMessage('f1'),voiceMessage('v1','')]});
  assert.deepEqual(b.state.jobs.map(j=>j.phase),['bundled','queued']);
  await f.restart().sendQueued();assert.equal(f.uploads.length,2);assert.ok(isWav(f.uploads[1].bytes));
  assert.deepEqual(f.writes,[]);assert.ok(f.restart().state.jobs.every(j=>j.phase==='posted'));
});

test('a bundle resumes after a later upload fails without resending an earlier file',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[fileMessage('f1'),fileMessage('f2'),message({message_id:'instruction'})]});
  let calls=0;f.connector.uploadFile=async args=>{
    calls++;if(calls===2)throw Object.assign(Error('connector_upload_post_failed'),{safeBeforeSend:true});
    f.uploads.push(args);return{fileId:calls===1?'F1':'F2'};
  };
  await b.sendQueued();assert.equal(f.uploads.length,1);assert.deepEqual(f.writes,[]);
  const resumed=f.restart();resumed.state.jobs[2].deferUntil=0;await resumed.sendQueued();
  assert.equal(f.uploads.length,2);assert.equal(f.uploads[1].initialComment,'hello');
  assert.ok(resumed.state.jobs.every(j=>j.phase==='posted'));
  const shares=[{user:'U',ts:'1.0',files:[{id:'F1'}],reactions:[{name:'eyes',users:['A']}]},
    {user:'U',ts:'2.0',files:[{id:'F2'}],reactions:[{name:'eyes',users:['A']}]}];
  resumed.indexSlackReferences(shares);resumed.indexSlackReferences([...shares].reverse());
  assert.equal(resumed.state.jobs[2].threadTs,'2.0');
  assert.equal(resumed.state.references.find(r=>r.key==='wx:f1').threadTs,'2.0');
  resumed.collectReactions(shares);assert.equal(resumed.state.outbox.length,1);assert.equal(resumed.state.outbox[0].ts,'2.0');
  await f.restart().sendQueued();assert.equal(calls,3);
});

test('bundled source quotes resolve to the delivered task and acknowledge only once',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[fileMessage('f1'),message({message_id:'instruction'})]});
  await b.sendQueued();
  b.indexSlackReferences([{user:'U',ts:'1.0',files:[{id:'F1'}]}]);
  const quoted=message({message_id:'followup'});quoted.item_list[0].ref_msg={svr_id:'f1'};
  b.ingest({msgs:[quoted]});const calls=[];f.connector.post=async(text,args)=>{calls.push(args);return{channel:'D',ts:'2.0'};};
  await b.sendQueued();assert.equal(calls[0].threadTs,'1.0');
  b.collectReactions([{user:'U',ts:'1.0',files:[{id:'F1'}],reactions:[{name:'eyes',users:['A']}]}]);
  assert.equal(b.state.outbox.filter(o=>o.kind==='eyes_ack').length,1);
});

test('a quoted pending file is not absorbed into an unrelated instruction',async()=>{
  const f=fixture(),b=f.restart();const file=fileMessage('f1');file.item_list[0].ref_msg={svr_id:'old-topic'};
  b.ingest({msgs:[file,message({message_id:'unrelated'})]});await b.sendQueued();
  assert.equal(b.state.jobs[0].phase,'staged');assert.equal(f.uploads.length,0);assert.deepEqual(f.writes,['hello']);
});

test('a persisted sharing checkpoint without its final job phase cannot replay after a crash',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[voiceMessage('crash')]});
  b.state.jobs[0].mediaUploads={0:{stage:'sharing',fileId:'F123'}};b.save();
  const again=f.restart();await again.sendQueued();assert.equal(f.uploads.length,0);assert.equal(again.state.jobs[0].phase,'sending');
});

test('uncertain outgoing reply does not block unrelated replies, but preserves topic order',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[message()]});
  b.collectSlackMessages([{user:'A',ts:'2.0',thread_ts:'1.0',text:'first'},
    {user:'A',ts:'3.0',thread_ts:'1.0',text:'same topic'}, {user:'A',ts:'4.0',thread_ts:'9.0',text:'different topic'}]);
  const send=f.weixin.send;f.weixin.send=async(...args)=>{if(args[2]==='first')throw Error('transport_outcome_unknown');return send(...args);};
  await b.returnQueued();await f.restart().returnQueued();
  assert.deepEqual(f.returns.map(x=>x[2]),['different topic']);assert.deepEqual(b.state.outbox.map(o=>o.phase),['sending','queued','sent']);
});

test('an exact Slack file receipt resolves an uncertain share without uploading or sharing again',async()=>{
  const f=fixture(),b=f.restart();b.ingest({msgs:[voiceMessage('recover')]});
  b.state.jobs[0].phase='sending';b.state.jobs[0].mediaUploads={0:{stage:'sharing',fileId:'F123',filename:'voice.wav',contentType:'audio/wav',bytes:9600}};
  b.indexSlackReferences([{user:'U',ts:'1.0',files:[{id:'FOTHER',name:'voice.wav'}]}]);assert.equal(b.state.jobs[0].phase,'sending');
  b.indexSlackReferences([{user:'OTHER',ts:'1.0',files:[{id:'F123'}]}]);assert.equal(b.state.jobs[0].phase,'sending');
  b.indexSlackReferences([{user:'U',ts:'1.0',files:[{id:'F123'}]}]);assert.equal(b.state.jobs[0].phase,'queued');
  f.connector.uploadFile=async args=>{assert.equal(args.checkpoint.stage,'shared');assert.equal(args.bytes.length,0);return {fileId:args.checkpoint.fileId};};
  await b.sendQueued();assert.equal(b.state.jobs[0].phase,'posted');assert.deepEqual(f.writes,[]);
});

test('late-arriving attachments within a few seconds of a posted text follow into its Slack thread',async()=>{
  const f=fixture();let now=1000;
  const make=()=>new Relay({config,store:f.store,connector:f.connector,weixin:f.weixin,fetcher:f.fetcher,activeFrom:100,now:()=>now});
  const b=make();
  b.ingest({msgs:[message({message_id:'t1',create_time_ms:1000})]});
  await b.sendQueued();
  assert.deepEqual(f.writes,['hello']);assert.equal(b.state.jobs[0].slackTs,'1.000001');
  now=3500;
  let seq=1;f.connector.uploadFile=async args=>{f.uploads.push(args);return{fileId:`F${seq++}`};};
  b.ingest({msgs:[
    {...fileMessage('f-late-1'),create_time_ms:3000},
    {...fileMessage('f-late-2'),create_time_ms:3400}
  ]});
  assert.deepEqual(b.state.jobs.map(j=>j.phase),['posted','queued','queued']);
  assert.equal(b.state.jobs[1].followUpTo,'t1');
  assert.equal(b.state.jobs[2].followUpTo,'t1');
  assert.deepEqual(b.state.jobs[2].dependsOn,['t1','f-late-1']);
  await b.sendQueued();
  assert.equal(f.uploads.length,2);
  assert.equal(f.uploads[0].threadTs,'1.000001');
  assert.equal(f.uploads[1].threadTs,'1.000001');
  assert.deepEqual(b.state.jobs.map(j=>j.phase),['posted','posted','posted']);
  // Reply and reactions in the same topic do not duplicate acknowledgements or add a spurious quote.
  b.collectSlackMessages([
    eyesMessage({ts:'1.000001'}),
    eyesMessage({ts:'1.000002',files:[{id:'F1'}]}),
    {user:'A',ts:'2.000001',thread_ts:'1.000001',text:'图文回复'}
  ]);
  await b.returnQueued();
  assert.deepEqual(f.returns.map(args=>args[2]),['稍等','图文回复']);
  assert.equal(f.returns[1][4],undefined);
  // A file arriving after the follow-up window still stages for the next instruction.
  now=25000;
  b.ingest({msgs:[{...fileMessage('f-later-topic'),create_time_ms:25000}]});
  await b.sendQueued();
  assert.equal(b.state.jobs.at(-1).phase,'staged');
  assert.equal(f.uploads.length,2);
});

test('attachment arriving right after text before send bundles into a single upload; in-flight text queues follow-up in its thread',async()=>{
  const f=fixture(),b=f.restart();
  b.ingest({msgs:[message({message_id:'t-fast',create_time_ms:101}),fileMessage('f-fast')]});
  assert.deepEqual(b.state.jobs.map(j=>j.phase),['queued','bundled']);
  await b.sendQueued();
  assert.deepEqual(f.writes,[]);
  assert.equal(f.uploads.length,1);
  assert.equal(f.uploads[0].initialComment,'hello');
  assert.deepEqual(b.state.jobs.map(j=>j.phase),['posted','posted']);

  // Now test attachment arriving while text post is already in-flight.
  const f2=fixture(),b2=f2.restart();
  let finishPost;f2.connector.post=text=>{f2.writes.push(text);return new Promise(r=>{finishPost=r;});};
  b2.ingest({msgs:[message({message_id:'t-inflight',create_time_ms:101})]});
  const sending=b2.sendQueued();await Promise.resolve();
  b2.ingest({msgs:[fileMessage('f-inflight')]});
  assert.equal(b2.state.jobs[1].phase,'queued');
  assert.equal(b2.state.jobs[1].followUpTo,'t-inflight');
  finishPost({channel:'D',ts:'9.000001'});await sending;
  await b2.sendQueued();
  assert.equal(f2.uploads.length,1);
  assert.equal(f2.uploads[0].threadTs,'9.000001');
  assert.deepEqual(b2.state.jobs.map(j=>j.phase),['posted','posted']);
});
