import { EncryptedStore } from '../src/vault.mjs';
// Read-only queue metadata (no message bodies) for incident inspection.
const state=new EncryptedStore('state/relay-queue.dpapi').load();
console.log(JSON.stringify({version:state.version,activeFrom:state.activeFrom,slackActiveFrom:state.slackActiveFrom??null,
  jobs:state.jobs.map(j=>({id:j.id,phase:j.phase,created:j.created})),
  outbox:state.outbox.map(o=>({ts:o.ts,phase:o.phase,hasText:!!o.text?.trim(),
    files:(o.files||[]).map(f=>({id:f.id,name:f.name,mimetype:f.mimetype}))}))},null,2));
