import http from 'node:http';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
const config=fs.readFileSync('C:/Users/Administrator/AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml','utf8');
const raw=config.match(/^secret:\s*(.*)$/m)?.[1]?.trim()||'';
const secret=raw.replace(/^['"]|['"]$/g,'');
function api(path){return new Promise((resolve,reject)=>{
 const q=http.get({socketPath:'\\\\.\\pipe\\verge-mihomo',path,headers:secret?{Authorization:'Bearer '+secret}:{}},r=>{
  let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{resolve(JSON.parse(b));}catch{reject(Error('response_not_json_'+r.statusCode));}});
 });
 q.setTimeout(5000,()=>q.destroy(Error('timeout')));q.on('error',reject);
});}
const output=[];
const emit=o=>{output.push(o);console.log(JSON.stringify(o));};
try{
 const c=await api('/configs');emit({mode:c.mode,logLevel:c['log-level'],tun:c.tun?.enable});
 const r=await api('/rules');emit({slackRules:r.rules?.filter(x=>String(x.payload).includes('slack')),finalRules:r.rules?.slice(-4)});
 for(const mode of ['original-route','explicit-proxy']){
  const t=Date.now();
  const test=mode==='original-route'
   ?fetch('https://files.slack.com/',{redirect:'manual',signal:AbortSignal.timeout(20000)}).then(async r=>{emit({test:mode,status:r.status,ms:Date.now()-t});await r.body?.cancel();}).catch(e=>emit({test:mode,error:e.cause?.code||e.name,ms:Date.now()-t}))
   :new Promise(resolve=>execFile('curl.exe',['--proxy','http://127.0.0.1:7897','--connect-timeout','12','--max-time','20','-sS','-o','NUL','-w','%{http_code}','https://files.slack.com/'],{windowsHide:true},(e,stdout)=>{emit({test:mode,status:stdout.trim(),error:e?.code,ms:Date.now()-t});resolve();}));
  const seen=new Set();
  for(let i=0;i<10;i++){
   await new Promise(r=>setTimeout(r,400));const a=await api('/connections');
   for(const x of (a.connections||[]).filter(x=>x.metadata?.host?.endsWith('slack.com'))){
    if(seen.has(x.id))continue;seen.add(x.id);
    emit({test:mode,connection:{host:x.metadata.host,type:x.metadata.type,network:x.metadata.network,process:x.metadata.process,chains:x.chains,rule:x.rule,rulePayload:x.rulePayload}});
   }
  }
  await test;
 }
}catch(e){emit({error:e.code||e.message});}
fs.writeFileSync(new URL('../state/incident-20261111/network-route.json',import.meta.url),JSON.stringify(output,null,2));
