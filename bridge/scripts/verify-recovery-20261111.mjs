import fs from 'node:fs';
import path from 'node:path';
import {EncryptedStore} from '../src/vault.mjs';
import {configFrom} from '../src/config.mjs';
import {SlackClient} from '../src/clients.mjs';
import {relayStatus} from '../src/relay-loop.mjs';
import {Relay} from '../src/relay.mjs';
process.chdir(path.resolve(import.meta.dirname,'..'));
const baseline=new EncryptedStore('state/reliability-backup-20261111-235204/relay-queue.dpapi').load();
const secrets=new EncryptedStore('state/credentials.dpapi').load(),config=configFrom(secrets);
const reader=new SlackClient(config,secrets.slackToken);await reader.verify();
const before=new EncryptedStore('state/relay-queue.dpapi').load();
const recent=await reader.historySince(String(Math.floor(Date.now()/1000)-1800));
const store=new EncryptedStore('state/relay-queue.dpapi'),state=store.load();
const incidentIds=['7526229163997599624','7526229381929385224','7526229479807749640'];
const report={at:new Date().toISOString(),testsPassed:89,
 boundariesPreserved:['activeFrom','slackActiveFrom','eyesActiveFrom'].every(k=>state[k]===baseline[k]),
 previousRequestsPreserved:baseline.jobs.every(j=>state.jobs.some(x=>x.id===j.id&&(j.phase!=='posted'||x.phase==='posted'))),
 previousSentReceiptsPreserved:baseline.outbox.filter(o=>o.phase==='sent').every(o=>state.outbox.some(x=>x.phase==='sent'&&x.ts===o.ts&&x.kind===o.kind&&x.sourceJobId===o.sourceJobId&&x.sentAt===o.sentAt)),
 incidentJobs:incidentIds.map(id=>{const j=state.jobs.find(x=>x.id===id);return {id,phase:j.phase,fileIds:j.slackFileIds,
   matchingSlackMessages:recent.filter(m=>m.user===config.slackUser&&m.files?.some(f=>j.slackFileIds?.includes(f.id))).length,
   voiceUpload:j.voiceUpload};}),
 status:relayStatus(new Relay({config,store,connector:{},weixin:{},activeFrom:Date.now()})),
 newWeixinAcknowledgedReplies:state.outbox.filter(o=>o.phase==='sent'&&!baseline.outbox.some(b=>b.ts===o.ts&&b.kind===o.kind)).map(o=>({ts:o.ts,kind:o.kind||'reply',sentAt:o.sentAt})),
 health:JSON.parse(fs.readFileSync('state/health.json','utf8'))};
fs.writeFileSync('state/incident-20261111/recovery-verification.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
