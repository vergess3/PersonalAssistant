import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {configureHttp} from './network.mjs';
import {ManagedConnector} from './managed-connector.mjs';
import {runBridge} from './runner.mjs';
import { EncryptedStore,acquireLock } from './vault.mjs';
import { configFrom } from './config.mjs';
import { SlackClient,WeixinClient } from './clients.mjs';
import { SlackMcpConnector } from './connector.mjs';
import { Relay } from './relay.mjs';
import { receiveOnce,relayStatus } from './relay-loop.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),stateDir=path.join(root,'state');
const mode=process.argv[2]||'--status';
let release=()=>{},connector,http,running=true;
process.on('SIGINT',()=>{running=false;});process.on('SIGTERM',()=>{running=false;});
try{
  if(!['--status','--check','--receive-once','--receive','--forward'].includes(mode))throw Error('invalid_mode');
  const runtime=JSON.parse(fs.readFileSync(path.join(root,'relay-runtime.json'),'utf8'));
  if(mode!=='--status'&&fs.existsSync(path.join(stateDir,'relay.stop')))throw Error('relay_stopped');
  if(mode==='--forward'&&!runtime.forwardingEnabled)throw Error('forwarding_not_enabled');
  if(mode==='--receive'&&!runtime.receiveLoopEnabled)throw Error('receive_loop_not_enabled');
  if(mode!=='--status')release=acquireLock(path.join(stateDir,'bridge.lock'));
  const secrets=new EncryptedStore(path.join(stateDir,'credentials.dpapi')).load();
  if(!secrets?.slackToken||!secrets.weixin?.token||!secrets.weixin.userId||!secrets.weixin.botId)throw Error('authorization_incomplete');
  if(runtime.transport!=='slack-mcp'||runtime.network?.mode!=='physical-direct')throw Error('invalid_transport_config');
  const config={...configFrom(secrets),cwd:root};
  http=configureHttp(runtime.network);
  const reader=new SlackClient(config,secrets.slackToken),weixin=new WeixinClient(config,secrets.weixin.token);
  const diagnostics=new EncryptedStore(path.join(stateDir,'connector-errors.dpapi'));
  const factory=()=>new SlackMcpConnector(config,{token:secrets.slackToken,reader,onDiagnostic:event=>{
    const previous=diagnostics.load()||[];diagnostics.save([...previous.slice(-19),event]);
  }});
  connector=mode==='--check'?factory():new ManagedConnector(config,{factory,verify:()=>reader.verify()});
  const queue=new EncryptedStore(path.join(stateDir,'relay-queue.dpapi'));
  const relay=new Relay({config,store:queue,connector,weixin,reader,activeFrom:Date.now()});
  const summary=()=>({mode,activeFrom:relay.state.activeFrom,...relayStatus(relay)});
  if(mode==='--status'){console.log(JSON.stringify(summary()));}
  else if(mode==='--check'){
    await reader.verify();const capabilities=await connector.start();await connector.verifyRead();
    console.log(JSON.stringify({readOnlyCheckPassed:true,...capabilities,network:runtime.network.mode,channel:config.slackChannel,
      forwardingEnabled:runtime.forwardingEnabled,receiveLoopEnabled:runtime.receiveLoopEnabled}));
  }else{
    // Persist activation boundary before first network read, including across restarts.
    relay.save();

    if(mode==='--receive-once'){await receiveOnce(relay,weixin);console.log(JSON.stringify(summary()));}
    else{
      let lastLog='';
      await runBridge({relay,reader,weixin,connector,forwarding:mode==='--forward',
        shouldStop:()=>!running||fs.existsSync(path.join(stateDir,'relay.stop')),
        log:entry=>console.log(JSON.stringify(entry)),
        onHealth:health=>{
          health.network={mode:runtime.network.mode,interfaceIndex:runtime.network.interfaceIndex};
          health.pendingErrors=[...relay.state.jobs.filter(j=>j.phase!=='posted').map(j=>({id:j.id,phase:j.phase,error:j.lastError||j.lastPreparationError})),
            ...relay.state.outbox.filter(o=>o.phase!=='sent').map(o=>({id:o.ts,phase:o.phase,error:o.lastDeliveryError||o.lastError}))].slice(0,20);
          const file=path.join(stateDir,'health.json'),tmp=file+'.tmp';
          fs.writeFileSync(tmp,JSON.stringify(health,null,2));fs.renameSync(tmp,file);
          const line=JSON.stringify(summary());if(line!==lastLog){console.log(line);lastLog=line;}
        }});
    }
  }
}catch(e){
  const allowed=/^(connector_[a-z_]+|weixin_[a-z_]+|slack_[a-z_]+|forwarding_not_enabled|receive_loop_not_enabled|relay_stopped|invalid_mode|authorization_incomplete|bridge_already_running|uncertain_delivery_requires_review|encrypted_state_unreadable|state_binding_mismatch|state_capacity_reached|dpapi_operation_failed|rate_limited|transport_outcome_unknown|remote_http_error|unexpected_destination|unapproved_[a-z_]+|invalid_[a-z_]+)$/;
  console.error(allowed.test(e.message)?e.message:'relay_stopped_review_required');process.exitCode=1;
}finally{connector?.close();await http?.close();release();}
