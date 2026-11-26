import {fetch} from './network.mjs';
import {beforeSend,fatalStateError} from './recovery.mjs';
const ENDPOINT='https://mcp.slack.com/mcp';
const MAX_RPC_BYTES=2*1024*1024;
function validUploadUrl(raw){
  try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&u.hostname.endsWith('.slack.com');}catch{return false;}
}
function parsedTexts(result){
  const out=[];
  for(const item of result?.content||[])if(item.type==='text'&&typeof item.text==='string'){
    try{out.push(JSON.parse(item.text));}catch{}
  }
  return out;
}
function uploadStartDetails(result){
  let uploadUrl,fileId;
  const scanText=text=>{
    if(typeof text!=='string')return;
    fileId=fileId||text.match(/\bFile ID:\s*(F[A-Z0-9]+)/)?.[1];
    uploadUrl=uploadUrl||text.match(/\bUpload URL:\s*(https:\/\/\S+)/)?.[1];
  };
  for(const item of result?.content||[])if(item.type==='text')scanText(item.text);
  for(const p of parsedTexts(result)){
    uploadUrl=uploadUrl||p.upload_url||p.uploadUrl||p.url||p.upload?.url;
    fileId=fileId||p.file_id||p.fileId||p.id||p.file?.id||p.file?.file_id;
    scanText(p.result);scanText(p.message);
  }
  return {uploadUrl,fileId};
}
function sharedFileId(result,fallback){
  for(const item of result?.content||[])if(item.type==='text'){
    const tagged=item.text?.match?.(/\bFile ID:\s*(F[A-Z0-9]+)/)?.[1];
    if(tagged)return tagged;
  }
  for(const p of parsedTexts(result)){
    const tagged=typeof p.result==='string'?p.result.match(/\bFile ID:\s*(F[A-Z0-9]+)/)?.[1]:null;
    const found=tagged||p.file_id||p.fileId||p.id||p.file?.id||p.file?.file_id;
    if(found)return found;
  }
  return fallback;
}
export class SlackMcpConnector {
  constructor(config,{token,reader,timeoutMs=45000,fetcher=fetch,onDiagnostic=()=>{}}={}){
    Object.assign(this,{config,token,reader,timeoutMs,fetcher,onDiagnostic});
    this.sequence=0;this.protocolVersion='2025-03-26';this.controller=new AbortController();
  }
  async rpc(method,params={},notification=false){
    if(this.controller.signal.aborted)throw beforeSend(Error('connector_closed'),'connector_dispatch');
    const id=notification?undefined:++this.sequence;
    let response,data,raw='';
    try{
      response=await this.fetcher(ENDPOINT,{method:'POST',redirect:'error',
        headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',
          ...(this.session?{'Mcp-Session-Id':this.session}:{}),...(method!=='initialize'?{'MCP-Protocol-Version':this.protocolVersion}:{})},
        body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params}),
        signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(this.timeoutMs)])});
      if(Number(response.headers.get('content-length'))>MAX_RPC_BYTES)throw Error('connector_response_too_large');
      raw=await response.text();if(Buffer.byteLength(raw)>MAX_RPC_BYTES)throw Error('connector_response_too_large');
    }catch(e){
      const err=Object.assign(Error('connector_transport_error'),{rpcMethod:method,tool:params.name});
      if(e.safeBeforeSend)beforeSend(err,'connector_dispatch');
      throw err;
    }
    this.session=response.headers.get('mcp-session-id')||this.session;
    if(notification&&response.status===202)return;
    try{data=JSON.parse(raw);}catch{
      for(const line of raw.split('\n'))if(line.startsWith('data:')){
        try{const candidate=JSON.parse(line.slice(5));if(candidate.id===id)data=candidate;}catch{}
      }
    }
    const meta={rpcMethod:method,...(params.name?{tool:params.name}:{}),remoteCode:response.status,
      ...(Number.isSafeInteger(data?.error?.code)?{rpcCode:data.error.code}:{})};
    const failure=(code,safe=false)=>{
      try{this.onDiagnostic({at:Date.now(),...meta,data,raw});}catch{}
      const err=Object.assign(Error(code),meta);if(safe)beforeSend(err,'connector_dispatch');return err;
    };
    if(response.status===429)throw Object.assign(failure('rate_limited',true),{retryAfter:Math.min(3600,Math.max(1,Number(response.headers.get('retry-after'))||60))*1000});
    if(response.status===401||response.status===403)throw failure('connector_authorization_required',true);
    if(response.status===404)throw failure('connector_session_expired',true);
    if(data?.error)throw failure('connector_rpc_error',[-32600,-32601,-32602].includes(data.error.code));
    if(!response.ok)throw failure('connector_rpc_error');
    if(data?.id!==id||!Object.hasOwn(data||{},'result'))throw failure('connector_response_invalid');
    return data.result;
  }
  async start(){
    await this.reader.verify();
    const started=await this.rpc('initialize',{protocolVersion:this.protocolVersion,capabilities:{},
      clientInfo:{name:'hilly-weixin-bridge',version:'0.2.0'}});
    if(typeof started?.protocolVersion!=='string')throw Error('connector_response_invalid');
    this.protocolVersion=started.protocolVersion;
    await this.rpc('notifications/initialized',{},true);
    const tools=[];let cursor;
    for(let page=0;page<20;page++){
      const list=await this.rpc('tools/list',cursor?{cursor}:{});
      if(!Array.isArray(list?.tools))throw Error('connector_response_invalid');
      tools.push(...list.tools);cursor=list.nextCursor;if(!cursor)break;
    }
    if(cursor)throw Error('connector_response_invalid');
    this.tools=new Map(tools.map(t=>[t.name,t]));
    if(!this.tools.has('slack_send_message'))throw Error('connector_tool_missing');
    return this.capabilities={transport:'slack-mcp',sendToolAvailable:true,
      fileUploadAvailable:this.tools.has('slack_get_file_upload_url')&&this.tools.has('slack_complete_file_upload'),
      fileReadAvailable:this.tools.has('slack_read_file')};
  }
  async verifyRead(){
    const messages=await this.reader.replies('1793784946.032539');
    if(!messages.some(m=>m.user===this.config.slackUser&&m.text?.includes('TEST-7314'))||
      !messages.some(m=>m.user===this.config.slackAssistantUser))throw Error('connector_read_identity_unverified');
    return true;
  }
  async call(tool,args){
    if(!this.tools?.has(tool))throw beforeSend(Error(tool.includes('file')?'connector_file_permission_required':'connector_tool_missing'),'connector_dispatch');
    const result=await this.rpc('tools/call',{name:tool,arguments:args});
    if(result?.isError){
      try{this.onDiagnostic({at:Date.now(),tool,result});}catch{}
      throw Error('connector_tool_denied_or_failed');
    }
    return result;
  }
  async post(text,{threadTs}={}){
    if(threadTs!==undefined&&!/^\d+\.\d+$/.test(threadTs))throw beforeSend(Error('connector_thread_invalid'),'connector_dispatch');
    const result=await this.call('slack_send_message',{channel_id:threadTs?this.config.slackChannel:this.config.slackAssistantUser,
      message:text,unfurl_app_links:false,...(threadTs?{thread_ts:threadTs,reply_broadcast:false}:{})});
    const receipt=[result?.structuredContent,...parsedTexts(result)].find(x=>x?.message_context)?.message_context;
    if(receipt?.channel_id!==this.config.slackChannel||!/^\d+\.\d+$/.test(receipt?.message_ts||''))throw Error('connector_receipt_invalid');
    return {channel:receipt.channel_id,ts:receipt.message_ts};
  }
  // Two-step Slack upload: signed URL -> POST raw bytes -> complete+share in the fixed DM.
  async uploadFile({filename,bytes,contentType,initialComment,threadTs,checkpoint={},onCheckpoint=()=>{}}){
    if(threadTs!==undefined&&!/^\d+\.\d+$/.test(threadTs))throw Error('connector_thread_invalid');
    if(checkpoint.stage==='shared'&&/^F[A-Z0-9]+$/.test(checkpoint.fileId||''))return {fileId:checkpoint.fileId};
    if(checkpoint.stage==='sharing')throw Object.assign(Error('connector_share_outcome_unknown'),{stage:'upload_share'});
    let stage='upload_init';
    try{
      if(!checkpoint.fileId){
        const started=await this.call('slack_get_file_upload_url',{filename,content_length:bytes.length});
        const {uploadUrl,fileId}=uploadStartDetails(started);
        if(!validUploadUrl(uploadUrl)||!/^F[A-Z0-9]+$/.test(fileId||''))throw Error('connector_upload_start_invalid');
        checkpoint={stage:'prepared',uploadUrl,fileId};onCheckpoint(checkpoint);
      }
      if(checkpoint.stage!=='uploaded'){
        stage='upload_binary';
        checkpoint={...checkpoint,stage:'uploading'};onCheckpoint(checkpoint);
        let posted;
        try{posted=await this.fetcher(checkpoint.uploadUrl,{method:'POST',body:bytes,redirect:'error',
          headers:{'Content-Type':contentType||'application/octet-stream','Content-Length':String(bytes.length)},
          signal:AbortSignal.timeout(120000)});}
        catch(e){throw Object.assign(Error('connector_upload_outcome_unknown'),{causeCode:e.cause?.code||e.code||e.name});}
        if(!posted.ok){
          // No share was attempted; an expired/rejected URL can be replaced safely.
          onCheckpoint({});
          throw Object.assign(Error(posted.status===429?'rate_limited':'connector_upload_post_failed'),
            {remoteCode:posted.status,retryAfter:Math.min(3600,Number(posted.headers?.get?.('retry-after'))||30)*1000});
        }
        await posted.body?.cancel();
        checkpoint={stage:'uploaded',fileId:checkpoint.fileId};onCheckpoint(checkpoint);
      }
      stage='upload_share';checkpoint={...checkpoint,stage:'sharing'};onCheckpoint(checkpoint);
      const done=await this.call('slack_complete_file_upload',
        {file_id:checkpoint.fileId,channel_id:this.config.slackChannel,title:filename,
          ...(threadTs?{thread_ts:threadTs}:{}),...(initialComment?{initial_comment:initialComment}:{})});
      const fileId=sharedFileId(done,checkpoint.fileId);
      onCheckpoint({stage:'shared',fileId});return {fileId};
    }catch(e){
      if(fatalStateError(e))throw e;
      if(stage==='upload_share'&&e.safeBeforeSend){checkpoint={stage:'uploaded',fileId:checkpoint.fileId};onCheckpoint(checkpoint);stage='upload_ready';}
      e.stage=stage;e.safeBeforeSend=stage!=='upload_share';throw e;
    }
  }
  async readFileBytes(fileId){
    if(!/^F[A-Z0-9]+$/.test(fileId||''))throw Error('connector_file_identity_mismatch');
    const data=await this.reader.call('files.info',{file:fileId},true);
    if(data.file?.id!==fileId)throw Error('connector_file_identity_mismatch');
    return this.reader.downloadFile(data.file);
  }
  close(){this.controller.abort();}
}
