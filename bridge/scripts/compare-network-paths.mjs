// Read-only paired probes. Fresh Node processes, same URLs, same fetch options.
import fs from 'node:fs';
import http from 'node:http';
import dc from 'node:diagnostics_channel';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.argv[2]==='--child'){
 const started=Date.now(),events=[];
 for(const name of ['beforeConnect','connected','connectError'])dc.channel('undici:client:'+name).subscribe(m=>events.push({name,ms:Date.now()-started,host:m.connectParams?.hostname,code:m.error?.code}));
 try{const r=await fetch(process.argv[3],{redirect:'manual',signal:AbortSignal.timeout(20000)});await r.arrayBuffer();console.log(JSON.stringify({status:r.status,ms:Date.now()-started,events}));}
 catch(e){console.log(JSON.stringify({error:e.cause?.code||e.name,ms:Date.now()-started,events}));}
}else{
 const cfg=fs.readFileSync('C:/Users/Administrator/AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml','utf8');
 const secret=(cfg.match(/^secret:\s*(.*)$/m)?.[1]?.trim()||'').replace(/^['"]|['"]$/g,'');
 function api(path){return new Promise((resolve,reject)=>{
  const q=http.get({socketPath:'\\\\.\\pipe\\verge-mihomo',path,headers:secret?{Authorization:'Bearer '+secret}:{}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{resolve(JSON.parse(b));}catch{reject(Error('invalid_api_response'));}});});
  q.setTimeout(3000,()=>q.destroy(Error('timeout')));q.on('error',reject);
 });}
 const rows=[],routes=new Map();
 async function probe(mode,url,round){
  const env={...process.env};for(const k of Object.keys(env))if(/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(k))delete env[k];
  if(mode==='explicit-proxy')env.HTTPS_PROXY='http://127.0.0.1:7897';
  const args=[...(mode==='explicit-proxy'?['--use-env-proxy']:[]),fileURLToPath(import.meta.url),'--child',url];
  const result=await new Promise(resolve=>{
   const p=spawn(process.execPath,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',c=>out+=c);p.stderr.resume();
   const timer=setTimeout(()=>{p.kill();},25000);
   p.on('close',code=>{clearTimeout(timer);try{resolve(JSON.parse(out.trim()));}catch{resolve({error:'probe_exit_'+code});}});
  });
  const row={round,mode,url,...result};rows.push(row);console.log(JSON.stringify(row));
 }
 const sampler=setInterval(async()=>{try{const a=await api('/connections');for(const c of a.connections||[]){if(!['files.slack.com','slack.com'].includes(c.metadata?.host))continue;const r={host:c.metadata.host,type:c.metadata.type,chains:c.chains,rule:c.rule};routes.set(JSON.stringify(r),r);}}catch{}},200);
 for(let round=1;round<=6;round++){
  for(const url of ['https://files.slack.com/','https://slack.com/api/api.test'])await Promise.all(['original-tun','explicit-proxy'].map(mode=>probe(mode,url,round)));
 }
 clearInterval(sampler);
 const summary=['original-tun','explicit-proxy'].map(mode=>{const a=rows.filter(x=>x.mode===mode),ok=a.filter(x=>!x.error);return {mode,total:a.length,httpResponses:ok.length,networkFailures:a.length-ok.length,http429:ok.filter(x=>x.status===429).length,minMs:Math.min(...ok.map(x=>x.ms)),maxMs:Math.max(...ok.map(x=>x.ms))};});
 const report={at:new Date().toISOString(),node:process.version,summary,routes:[...routes.values()],rows};
 fs.writeFileSync(new URL('../state/incident-20261111/paired-network-tests.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify({summary,routes:report.routes}));
}
