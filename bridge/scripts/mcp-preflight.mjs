// Read-only capability check; safe to run alongside the active receiver.
import fs from 'node:fs';
import {EncryptedStore} from '../src/vault.mjs';
import {configFrom} from '../src/config.mjs';
import {SlackClient} from '../src/clients.mjs';
import {SlackMcpConnector} from '../src/connector.mjs';
import {configureHttp,fetch} from '../src/network.mjs';
const runtime=JSON.parse(fs.readFileSync('relay-runtime.json','utf8'));
const http=configureHttp(runtime.network),secrets=new EncryptedStore('state/credentials.dpapi').load();
const config=configFrom(secrets),reader=new SlackClient(config,secrets.slackToken);
const diagnostic=new EncryptedStore('state/mcp-preflight-diagnostic.dpapi');
const c=new SlackMcpConnector(config,{token:secrets.slackToken,reader,onDiagnostic:e=>diagnostic.save(e)});
try{
 const auth=await fetch('https://slack.com/api/auth.test',{method:'POST',headers:{Authorization:'Bearer '+secrets.slackToken},redirect:'error',signal:AbortSignal.timeout(30000)});
 console.log(JSON.stringify({scopes:auth.headers.get('x-oauth-scopes')?.split(',')}));await auth.body.cancel();
 const capabilities=await c.start();await c.verifyRead();
 console.log(JSON.stringify({readOnlyCheckPassed:true,network:runtime.network.mode,...capabilities,
  fileTools:[...c.tools.values()].filter(t=>/file/.test(t.name)).map(t=>({name:t.name,inputSchema:t.inputSchema}))}));
}catch(e){console.log(JSON.stringify({error:/^[a-z_]+$/.test(e.message)?e.message:'preflight_failed',stage:e.stage}));process.exitCode=1;}
finally{c.close();await http.close();}
