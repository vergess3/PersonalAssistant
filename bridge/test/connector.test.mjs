import test from 'node:test';
import assert from 'node:assert/strict';
import {SlackMcpConnector} from '../src/connector.mjs';
const config={slackTeam:'T',slackUser:'U',slackChannel:'D',slackAssistantUser:'A'};
const names=['slack_send_message','slack_get_file_upload_url','slack_complete_file_upload','slack_read_file'];
function fixture({toolResult,tools=names,override}={}){
 const calls=[],diagnostics=[],reader={verify:async()=>{},replies:async()=>[{user:'U',text:'TEST-7314'},{user:'A',text:'ok'}]};
 const c=new SlackMcpConnector(config,{token:'synthetic-token',reader,onDiagnostic:e=>diagnostics.push(e),fetcher:async(url,opts)=>{
  assert.equal(url,'https://mcp.slack.com/mcp');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer synthetic-token');
  const m=JSON.parse(opts.body);calls.push(m);if(override){const r=override(m);if(r)return r;}
  if(m.method==='notifications/initialized')return new Response(null,{status:202});
  const result=m.method==='initialize'?{protocolVersion:'2025-03-26'}:m.method==='tools/list'?{tools:tools.map(name=>({name}))}:
   toolResult||{content:[{type:'text',text:JSON.stringify({message_context:{channel_id:'D',message_ts:'1.000001'}})}]};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:m.id,result}),{headers:{'mcp-session-id':'synthetic-session'}});
 }});return {c,calls,diagnostics};
}
test('MCP verifies identity and preserves Unicode and thread routing using only Slack HTTPS',async()=>{
 const {c,calls}=fixture();const status=await c.start();await c.verifyRead();assert.equal(status.transport,'slack-mcp');assert.equal(status.fileUploadAvailable,true);
 assert.deepEqual(await c.post('中文\nvoice + image'),{channel:'D',ts:'1.000001'});await c.post('follow up',{threadTs:'1.000001'});
 const sends=calls.filter(x=>x.method==='tools/call');assert.equal(sends[0].params.arguments.channel_id,'A');assert.equal(sends[0].params.arguments.message,'中文\nvoice + image');
 assert.equal(sends[1].params.arguments.channel_id,'D');assert.equal(sends[1].params.arguments.reply_broadcast,false);assert.equal(sends[1].params.arguments.thread_ts,'1.000001');c.close();
});
test('wrong DM, malformed receipts and server tool errors are never accepted as delivery',async()=>{
 for(const result of [{isError:true,content:[]},{structuredContent:{message_context:{channel_id:'OTHER',message_ts:'1.0'}}},{}]){
  const {c,calls}=fixture({toolResult:result});await c.start();await assert.rejects(c.post('test'));assert.equal(calls.filter(m=>m.method==='tools/call').length,1);c.close();
 }
});
test('missing file permissions stop before upload without blocking text',async()=>{
 const {c,calls}=fixture({tools:['slack_send_message']});assert.equal((await c.start()).fileUploadAvailable,false);
 await assert.rejects(c.uploadFile({filename:'a.jpg',bytes:Buffer.from('a')}),e=>e.safeBeforeSend&&e.message==='connector_file_permission_required');
 assert.equal(calls.filter(m=>m.method==='tools/call').length,0);await c.post('still works');c.close();
});
test('HTTP rejection is safely retryable; unexpected errors after dispatch remain ambiguous',async()=>{
 for(const [status,safe,code]of [[429,true,'rate_limited'],[401,true,'connector_authorization_required'],[404,true,'connector_session_expired'],[502,false,'connector_rpc_error']]){
  const {c}=fixture({override:m=>m.method==='tools/call'?new Response('private',{status,headers:{'retry-after':'12'}}):null});await c.start();
  await assert.rejects(c.post('test'),e=>{assert.equal(e.safeBeforeSend===true,safe);assert.equal(e.message,code);if(status===429)assert.equal(e.retryAfter,12000);return true;});c.close();
 }
});
test('RPC error details stay private; only known pre-dispatch failures are safe to retry',async()=>{
 for(const [code,safe]of [[-32602,true],[-32603,false]]){
  const {c,diagnostics}=fixture({override:m=>m.method==='tools/call'?new Response(JSON.stringify({id:m.id,error:{code,message:'private-secret'}})):null});await c.start();
  await assert.rejects(c.post('test'),e=>{assert.equal(e.safeBeforeSend===true,safe);assert.ok(!JSON.stringify(e).includes('private-secret'));return true;});assert.ok(diagnostics[0].raw.includes('private-secret'));c.close();
 }
});
test('connection failure before HTTP write remains safe; lost responses never auto-resend',async()=>{
 for(const safe of [true,false]){
  const {c}=fixture();await c.start();let count=0;c.fetcher=async()=>{count++;throw Object.assign(Error('private'),safe?{safeBeforeSend:true}:{});};
  await assert.rejects(c.post('test'),e=>e.message==='connector_transport_error'&&(e.safeBeforeSend===true)===safe);assert.equal(count,1);c.close();
 }
});
test('reader mismatch stops verification; file fallback uses Slack-authorized original bytes',async()=>{
 const {c}=fixture();c.reader.replies=async()=>[{user:'OTHER',text:'TEST-7314'}];await assert.rejects(c.verifyRead(),/identity/);const bytes=Buffer.from([0,255,13,10,128]);
 c.reader.call=async(method,args,read)=>{assert.equal(method,'files.info');assert.deepEqual(args,{file:'F123'});assert.equal(read,true);return {file:{id:'F123'}};};
 c.reader.downloadFile=async file=>{assert.equal(file.id,'F123');return bytes;};assert.deepEqual(await c.readFileBytes('F123'),bytes);
 c.reader.call=async()=>({file:{id:'FOTHER'}});await assert.rejects(c.readFileBytes('F123'),/identity/);c.close();
});
function uploadFixture(fetcher){
 const c=new SlackMcpConnector(config,{fetcher}),calls=[];c.call=async(tool,args)=>{calls.push({tool,args});return {content:[{type:'text',text:JSON.stringify(tool==='slack_get_file_upload_url'?{file_id:'F123',upload_url:'https://files.slack.com/upload/synthetic'}:{file_id:'F123'})}]};};return {c,calls};
}
test('binary upload preserves bytes, sends no OAuth header, and shares in quoted thread',async()=>{
 const bytes=Buffer.from([0,255,13,10,128]);let observed;const {c,calls}=uploadFixture(async(url,opts)=>{observed={url,opts};return new Response('');});
 assert.deepEqual(await c.uploadFile({filename:'voice.wav',bytes,threadTs:'1.000001',initialComment:'中文'}),{fileId:'F123'});
 assert.deepEqual(observed.opts.body,bytes);assert.equal(observed.opts.headers.Authorization,undefined);assert.equal(calls[1].args.thread_ts,'1.000001');assert.equal(calls[1].args.initial_comment,'中文');c.close();
});
test('upload start rejects non-Slack URLs before transferring file bytes',async()=>{
 for(const url of ['http://files.slack.com/a','https://files.slack.com.evil.example/a','https://user@files.slack.com/a']){
  const {c}=uploadFixture(()=>assert.fail('untrusted destination'));c.call=async()=>({content:[{type:'text',text:JSON.stringify({file_id:'F123',upload_url:url})}]});
  await assert.rejects(c.uploadFile({filename:'a',bytes:Buffer.from('x')}),e=>e.safeBeforeSend);c.close();
 }
});
test('binary timeout resumes same file; a completed share is never repeated',async()=>{
 let checkpoint={},uploads=0;const {c,calls}=uploadFixture(async()=>{if(++uploads===1)throw Error('timeout');return new Response('');});
 const args=()=>({filename:'a',bytes:Buffer.from('x'),checkpoint,onCheckpoint:p=>checkpoint=structuredClone(p)});
 await assert.rejects(c.uploadFile(args()),e=>e.safeBeforeSend);assert.equal(checkpoint.stage,'uploading');await c.uploadFile(args());await c.uploadFile(args());assert.equal(uploads,2);
 assert.equal(calls.filter(x=>x.tool==='slack_get_file_upload_url').length,1);assert.equal(calls.filter(x=>x.tool==='slack_complete_file_upload').length,1);c.close();
});
test('unknown share outcome retains checkpoint; explicit rejection returns to uploaded',async()=>{
 for(const safe of [false,true]){
  let checkpoint={stage:'uploaded',fileId:'F123'},calls=0;const {c}=uploadFixture(()=>assert.fail('no new bytes'));
  c.call=async()=>{calls++;assert.equal(checkpoint.stage,'sharing');throw Object.assign(Error('rate_limited'),safe?{safeBeforeSend:true}:{});};
  const args=()=>({filename:'a',bytes:Buffer.alloc(0),checkpoint,onCheckpoint:p=>checkpoint=structuredClone(p)});await assert.rejects(c.uploadFile(args()),e=>(e.safeBeforeSend===true)===safe);
  assert.equal(checkpoint.stage,safe?'uploaded':'sharing');if(!safe){await assert.rejects(c.uploadFile(args()),/outcome_unknown/);assert.equal(calls,1);}c.close();
 }
});
