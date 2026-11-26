// One-time reconciliation for the pre-checkpoint image incident. No messages sent.
import fs from 'node:fs';
import path from 'node:path';
import {EncryptedStore,acquireLock} from '../src/vault.mjs';
import {configFrom} from '../src/config.mjs';
import {SlackClient} from '../src/clients.mjs';
const root=path.resolve(import.meta.dirname,'..');process.chdir(root);
const apply=process.argv.includes('--apply'),release=acquireLock('state/bridge.lock');
try{
 const store=new EncryptedStore('state/relay-queue.dpapi'),state=store.load();
 const job=state.jobs.find(j=>j.id==='7526229163997599624');
 if(!job||job.phase!=='sending'||job.threadTs||job.slackTs||job.slackFileIds?.length||job.media?.length!==1||job.media[0].kind!=='image')throw Error('incident_state_changed');
 const secrets=new EncryptedStore('state/credentials.dpapi').load(),config=configFrom(secrets),reader=new SlackClient(config,secrets.slackToken);
 await reader.verify();
 const oldest=String(Math.floor(job.created/1000)-120),messages=await reader.historySince(oldest);
 const matches=messages.filter(m=>m.user===config.slackUser&&m.files?.some(f=>f.name?.startsWith(`weixin-image-${job.id}.`)));
 if(matches.length>1)throw Error('ambiguous_incident_receipts');
 const report={at:new Date().toISOString(),oldest,readOnlyMessages:messages.length,matchedMessages:matches.length,
   jobId:job.id,action:matches.length?'record_existing_receipt':'requeue_after_history_reconciliation',applied:apply};
 if(apply){
   const stamp=Date.now();fs.copyFileSync('state/relay-queue.dpapi',`state/incident-20261111/pre-recovery-${stamp}.dpapi`);
   new EncryptedStore(`state/incident-20261111/reconciliation-${stamp}.dpapi`).save({report,messages});
   if(matches.length){
     const m=matches[0];job.slackFileIds=m.files.filter(f=>f.name?.startsWith(`weixin-image-${job.id}.`)).map(f=>f.id);
     job.slackTs=m.ts;job.threadTs=m.thread_ts||m.ts;job.phase='posted';delete job.media;delete job.text;delete job.uploadedMedia;
   }else{job.phase='queued';job.recovery=report;}
   // The first voice released this staged image in the original flow.
   const voice=state.jobs.find(j=>j.id==='7526229381929385224');
   if(voice?.phase==='queued')voice.dependsOn=[...new Set([...(voice.dependsOn||[]),job.id])];
   store.save(state);
 }
 fs.writeFileSync('state/incident-20261111/reconciliation-summary.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(e){console.error(/^[a-z_]+$/.test(e.message)?e.message:'incident_recovery_failed');process.exitCode=1;}
finally{release();}
