import {SlackMcpConnector} from './connector.mjs';
import {beforeSend,errorMetadata,fatalStateError,retryDelay} from './recovery.mjs';
// Reconnect the transport between operations; never replay a failed write here.
export class ManagedConnector{
  constructor(config,{factory=()=>new SlackMcpConnector(config),verify=async()=>{},now=Date.now}={}){
    Object.assign(this,{factory,verify,now});this.current=null;this.connecting=null;this.attempts=0;this.nextAttempt=0;this.closed=false;
  }
  get status(){return {transport:'slack-mcp',ready:!!this.current,blocked:!!this.blocked,nextAttempt:this.nextAttempt,lastError:this.lastError,capabilities:this.current?.capabilities};}
  async ready(){
    if(this.closed)throw beforeSend(Error('connector_closed'),'connector_start');
    if(this.blocked)throw beforeSend(Error(this.blocked),'connector_start');
    if(this.current)return this.current;
    if(this.connecting)return this.connecting;
    if(this.nextAttempt>this.now())throw beforeSend(Object.assign(Error('connector_reconnect_deferred'),{retryAfter:this.nextAttempt-this.now()}),'connector_start');
    this.connecting=(async()=>{
      const c=this.factory();this.starting=c;
      try{await this.verify();await c.start();await c.verifyRead();
        if(this.closed)throw Error('connector_closed');
        this.current=c;this.attempts=0;this.nextAttempt=0;delete this.lastError;return c;
      }catch(e){c.close();this.failed(e);throw beforeSend(e,'connector_start');}
      finally{this.starting=null;}
    })();
    try{return await this.connecting;}finally{this.connecting=null;}
  }
  failed(e){
    if(fatalStateError(e))throw e;
    this.lastError=errorMetadata(e,this.now());
    if(/^(connector_(authorization_required|confirmation_required|account_mismatch|read_identity_unverified|tool_missing)|slack_identity_mismatch)$/.test(e.message))this.blocked=e.message;
    this.nextAttempt=this.now()+retryDelay(++this.attempts,e.retryAfter);
  }
  async invoke(method,args){
    const c=await this.ready();
    try{return await c[method](...args);}catch(e){
      if(/^connector_(rpc_error|transport_error|session_expired|response_invalid|authorization_required|file_permission_required|process_failed|process_closed|timeout_outcome_unknown|confirmation_required|closed)$/.test(e.message)){
        if(this.current===c){this.current=null;c.close();this.failed(e);}
      }
      throw e;
    }
  }
  start(){return this.ready();}
  verifyRead(){return this.ready();}
  post(...args){return this.invoke('post',args);}
  uploadFile(...args){return this.invoke('uploadFile',args);}
  readFileBytes(...args){return this.invoke('readFileBytes',args);}
  close(){this.closed=true;this.current?.close();this.starting?.close();this.current=null;}
}
