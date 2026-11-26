// Explicit migration diagnostics. Persist intent before writes; never replay an
// uncertain or already posted test. Uses exactly the production connector/HTTP.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {EncryptedStore} from '../src/vault.mjs';
import {configFrom} from '../src/config.mjs';
import {SlackClient} from '../src/clients.mjs';
import {SlackMcpConnector} from '../src/connector.mjs';
import {configureHttp} from '../src/network.mjs';
const path='state/mcp-migration-20261112-163252/smoke.json';
const report=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):{};
const save=()=>fs.writeFileSync(path,JSON.stringify(report,null,2)+'\n');
const runtime=JSON.parse(fs.readFileSync('relay-runtime.json','utf8'));
const http=configureHttp(runtime.network),secrets=new EncryptedStore('state/credentials.dpapi').load();
const config=configFrom(secrets),reader=new SlackClient(config,secrets.slackToken);
const c=new SlackMcpConnector(config,{token:secrets.slackToken,reader,onDiagnostic:e=>new EncryptedStore('state/mcp-migration-20261112-163252/diagnostic.dpapi').save(e)});
try{
 const mode=process.argv[2];if(!['text','thread','verify','files'].includes(mode))throw Error('invalid_mode');
 const caps=await c.start();await c.verifyRead();report.capabilities=caps;save();
 if(mode==='text'){
  if(report.text)throw Error('already_attempted');
  report.text={phase:'sending',at:Date.now(),marker:'MIGRATE-MCP-1112-1655'};save();
  const result=await c.post('微信桥接迁移连通测试，由程序发送。请只回复：'+report.text.marker+' 已收到。');
  Object.assign(report.text,{phase:'posted',...result});save();console.log(JSON.stringify(report.text));
 }
 if(mode==='thread'){
  if(report.thread)throw Error('already_attempted');if(!report.text?.ts)throw Error('text_test_required');
  report.thread={phase:'sending',at:Date.now(),marker:'MIGRATE-MCP-THREAD-1112'};save();
  const result=await c.post('桥接切换后的线程和微信回传测试。请只回复：'+report.thread.marker+' 已收到。',{threadTs:report.text.ts});
  Object.assign(report.thread,{phase:'posted',...result});save();console.log(JSON.stringify(report.thread));
 }
 if(mode==='files'){
  if(!caps.fileUploadAvailable||!caps.fileReadAvailable)throw Error('file_permission_required');
  if(!report.text?.ts)throw Error('text_test_required');
  // Valid 1x1 PNG and a short valid mono PCM WAV. No personal media is used.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW0cAAAAASUVORK5CYII=','base64');
  const wav=Buffer.alloc(44+4800);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4800,40);
  for(const [kind,bytes,type]of [['png',png,'image/png'],['wav',wav,'audio/wav']]){
   if(report[kind])continue;
   report[kind]={phase:'sending',at:Date.now()};save();
   const sent=await c.uploadFile({filename:'bridge-migration-test.'+kind,bytes,contentType:type,threadTs:report.text.ts,
     initialComment:'附件迁移测试（合成'+kind+'文件），请只回复：MIGRATE-FILE-'+kind.toUpperCase()+' 已收到。',onCheckpoint:p=>{
       new EncryptedStore('state/mcp-migration-20261112-163252/'+kind+'-upload.dpapi').save(p);
     }});
   Object.assign(report[kind],{phase:'posted',fileId:sent.fileId});save();
   const downloaded=await c.readFileBytes(sent.fileId);
   report[kind].downloadMatches=downloaded.equals(bytes);report[kind].bytes=bytes.length;report[kind].sha256=createHash('sha256').update(bytes).digest('hex');save();
   console.log(JSON.stringify({kind,...report[kind]}));
  }
 }
 if(mode==='verify'&&report.text?.ts){
  const messages=await reader.replies(report.text.ts);
  new EncryptedStore('state/mcp-migration-20261112-163252/thread.dpapi').save(messages);
  report.verifiedAt=Date.now();report.replies=messages.filter(m=>m.user===config.slackAssistantUser).map(m=>({ts:m.ts,matchedText:m.text?.includes(report.text.marker),matchedThread:!!report.thread&&m.text?.includes(report.thread.marker),matchedPng:m.text?.includes('MIGRATE-FILE-PNG'),matchedWav:m.text?.includes('MIGRATE-FILE-WAV')}));
  const queue=new EncryptedStore('state/relay-queue.dpapi').load();
  report.returned=queue.outbox.filter(o=>report.replies.some(r=>r.ts===o.ts)).map(o=>({ts:o.ts,phase:o.phase,sentAt:o.sentAt}));save();console.log(JSON.stringify({replies:report.replies,returned:report.returned}));
 }
}catch(e){console.log(JSON.stringify({error:/^[a-z_]+$/.test(e.message)?e.message:'check_failed'}));process.exitCode=1;}
finally{c.close();await http.close();}
