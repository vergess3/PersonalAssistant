// Read only Slack; restore reference metadata without replaying any messages.
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { EncryptedStore,acquireLock } from '../src/vault.mjs';
import { configFrom } from '../src/config.mjs';
import { SlackClient } from '../src/clients.mjs';
import { Relay } from '../src/relay.mjs';
const queue=new EncryptedStore('state/relay-queue.dpapi');
const cache=new EncryptedStore('state/reply-backup-20261108/reference-messages.dpapi');
const secrets=new EncryptedStore('state/credentials.dpapi').load(),config=configFrom(secrets);
let release=()=>{};
try{
  const mode=process.argv[2];
  if(mode==='--fetch'){
    const state=queue.load(),reader=new SlackClient(config,secrets.slackToken);
    await reader.verify();
    const retry=async fn=>{for(let attempt=0;;attempt++)try{return await fn();}catch(e){
      if(e.message!=='rate_limited'||attempt>=5)throw e;
      let remaining=e.retryAfter||60000;
      while(remaining>0){console.log(JSON.stringify({waitingForRateLimit:true}));
        const ms=Math.min(remaining,30000);await delay(ms);remaining-=ms;}
    }};
    const messages=await retry(()=>reader.historySince(String(Math.floor(state.activeFrom/1000))));
    const roots=new Set([...state.jobs.map(j=>j.threadTs||j.slackTs),
      ...state.outbox.filter(o=>o.kind!=='eyes_ack'&&o.kind!=='thumbsup_ack').map(o=>o.replyTo),
      ...messages.filter(m=>m.reply_count).map(m=>m.ts)].filter(Boolean));
    let count=0;
    for(const root of roots){
      messages.push(...await retry(()=>reader.replies(root)));
      if(++count%10===0)console.log(JSON.stringify({threadsRead:count,totalThreads:roots.size}));
    }
    const unique=[...new Map(messages.map(m=>[m.ts,m])).values()];
    cache.save({binding:state.binding,messages:unique});
    console.log(JSON.stringify({readOnly:true,threads:count,messages:unique.length}));
  }else if(mode==='--apply'){
    release=acquireLock('state/bridge.lock');
    const state=queue.load(),snapshot=cache.load();
    if(snapshot.binding!==state.binding)throw Error('state_binding_mismatch');
    const backup='state/reply-backup-20261108/relay-queue.dpapi';
    if(fs.existsSync(backup))throw Error('backup_already_exists');
    fs.copyFileSync('state/relay-queue.dpapi',backup);
    const relay=new Relay({config,store:queue,connector:{},weixin:{},activeFrom:Date.now()});
    relay.indexSlackReferences(snapshot.messages);relay.save();
    console.log(JSON.stringify({references:relay.state.references.length,jobs:relay.state.jobs.length,
      replies:relay.state.outbox.length,uncertain:relay.uncertain}));
  }else throw Error('invalid_mode');
}catch(e){console.error(/^[a-z_]+$/.test(e.message)?e.message:'reference_rebuild_failed');process.exitCode=1;}
finally{release();}
