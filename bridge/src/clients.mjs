import { randomBytes } from 'node:crypto';
import {fetch} from './network.mjs';
export class SafeError extends Error {
  constructor(code, retryAfter=0) { super(code); this.retryAfter=retryAfter; }
}
async function request(fetcher, url, options, exactMessageIds=false, timeoutMs=45000) {
  let r;
  try { r=await fetcher(url, {...options, redirect:'error', signal:AbortSignal.timeout(timeoutMs)}); }
  catch(e) { throw new SafeError(e?.name==='TimeoutError'?'request_timeout':'transport_outcome_unknown'); }
  if (r.status===429) throw new SafeError('rate_limited', Math.min(3600,Math.max(1,Number(r.headers.get('retry-after'))||60))*1000);
  if (!r.ok) throw new SafeError('remote_http_error');
  try {
    if(exactMessageIds && typeof r.text==='function') return JSON.parse(await r.text(),
      (key,value,context)=>['message_id','msg_id','svr_id'].includes(key)&&typeof value==='number'?context.source:value);
    return await r.json();
  } catch { throw new SafeError('invalid_remote_json'); }
}
export class SlackClient {
  constructor(config, token, fetcher=fetch) { Object.assign(this,{config,token,fetcher}); }
  async call(method, body, read=false) {
    const url=new URL('https://slack.com/api/'+method);
    if(read) for(const [k,v] of Object.entries(body)) url.searchParams.set(k,String(v));
    const r=await request(this.fetcher,url,{method:read?'GET':'POST',
      headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},
      ...(read?{}:{body:JSON.stringify(body)})});
    if(r.ok!==true) throw new SafeError(r.error==='missing_scope'?'slack_permission_required':r.error==='invalid_auth'||r.error==='token_revoked'?'slack_authorization_required':'slack_api_error');
    return r;
  }
  async verify() {
    const r=await this.call('auth.test',{});
    if(r.team_id!==this.config.slackTeam || r.user_id!==this.config.slackUser || r.bot_id) throw new SafeError('slack_identity_mismatch');
  }
  async replies(thread) {
    const result=[]; let cursor='';
    for(let page=0;page<20;page++) {
      const r=await this.call('conversations.replies',{channel:this.config.slackChannel,ts:thread,limit:15,...(cursor?{cursor}:{})},true);
      if(!Array.isArray(r.messages)) throw new SafeError('invalid_slack_messages');
      result.push(...r.messages); cursor=r.response_metadata?.next_cursor||'';
      if(!cursor) { if(r.has_more) throw new SafeError('incomplete_slack_page'); return result; }
    }
    throw new SafeError('slack_pagination_limit');
  }
  async downloadFile(file) {
    const raw=file?.url_private_download||file?.url_private;
    const u=new URL(raw);
    if(u.protocol!=='https:'||!(u.hostname==='files.slack.com'||u.hostname.endsWith('.slack.com')))
      throw new SafeError('unapproved_slack_file_url');
    let r;
    try { r=await this.fetcher(u,{headers:{Authorization:'Bearer '+this.token},redirect:'manual',signal:AbortSignal.timeout(120000)}); }
    catch { throw new SafeError('transport_outcome_unknown'); }
    // A login redirect needs fresh file metadata or file authorization.
    // Never follow it or forward the token to its destination.
    if(r.status>=300&&r.status<400){await r.body?.cancel();throw new SafeError('slack_file_unavailable');}
    if(r.status===429) throw new SafeError('rate_limited',60000);
    if(!r.ok) throw new SafeError('remote_http_error');
    // Slack answers an HTML login page when the token lacks file access.
    if((r.headers?.get?.('content-type')||'').includes('text/html')) throw new SafeError('slack_file_unavailable');
    const declared=Number(r.headers?.get?.('content-length'));
    if(declared>100*1024*1024)throw new SafeError('slack_file_too_large');
    const buf=Buffer.from(await r.arrayBuffer());
    if(buf.length>100*1024*1024) throw new SafeError('slack_file_too_large');
    if(Number.isSafeInteger(file.size)&&buf.length!==file.size)throw new SafeError('slack_file_size_mismatch');
    return buf;
  }
  async historySince(oldest) {
    const messages=[];let cursor='';const latest=String(Date.now()/1000);
    for(let page=0;page<20;page++){
      const r=await this.call('conversations.history',{channel:this.config.slackChannel,oldest,latest,
        inclusive:true,limit:15,...(cursor?{cursor}:{})},true);
      if(!Array.isArray(r.messages))throw new SafeError('invalid_slack_messages');
      messages.push(...r.messages);cursor=r.response_metadata?.next_cursor||'';
      if(!cursor){if(r.has_more)throw new SafeError('incomplete_slack_page');return messages;}
    }
    throw new SafeError('slack_pagination_limit');
  }
}
export class WeixinClient {
  constructor(config,token,fetcher=fetch) {
    Object.assign(this,{config,token,fetcher});
    // The server normally holds a long-poll for up to 35s. Leave time for
    // the response to travel back instead of aborting it as an empty poll.
    this.longPollTimeoutMs=45000;
    this.receiveStatus={responses:0,timeouts:0,consecutiveTimeouts:0,messages:0};
    const u=new URL(config.weixinOrigin);
    if(u.protocol!=='https:' || u.username || u.password || u.port || u.search || u.hash || u.pathname!=='/' ||
      !(u.hostname==='ilinkai.weixin.qq.com' || u.hostname.endsWith('.ilinkai.weixin.qq.com'))) throw new SafeError('unapproved_weixin_origin');
    this.origin=u.origin;
    if(!/^\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(config.channelVersion)) throw new SafeError('invalid_protocol_version');
  }
  async call(method,data,timeoutMs) {
    const [major,minor,patch]=this.config.channelVersion.split('.').map(Number);
    const r=await request(this.fetcher,this.origin+'/ilink/bot/'+method,{
      method:'POST',headers:{'Content-Type':'application/json',AuthorizationType:'ilink_bot_token',
        Authorization:'Bearer '+this.token,'iLink-App-Id':'bot','iLink-App-ClientVersion':String((major<<16)|(minor<<8)|patch),
        'X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')},
      body:JSON.stringify({...data,base_info:{channel_version:this.config.channelVersion,bot_agent:'HillyBridge/0.1.0'}})},true,timeoutMs);
    if((r.ret!==undefined&&r.ret!==0)||(r.errcode!==undefined&&r.errcode!==0)){
      const error=new SafeError(r.ret===-14||r.errcode===-14?'weixin_session_expired':'weixin_api_error');
      // Keep only the numeric backend code for diagnosis, never remote text,
      // which can contain message content or credentials.
      const remoteCode=r.errcode||r.ret;
      if(Number.isSafeInteger(remoteCode))error.remoteCode=remoteCode;
      throw error;
    }
    return r;
  }
  async updates(cursor,timeoutMs=this.longPollTimeoutMs) {
    this.receiveStatus.lastAttempt=Date.now();
    let r;
    try { r=await this.call('getupdates',{get_updates_buf:cursor},timeoutMs); }
    catch(e) {
      // Long-poll timeout means "no messages yet", as in the upstream client.
      // Keep it distinct from an actual server response in health snapshots.
      if(e.message==='request_timeout'){
        this.receiveStatus.timeouts++;this.receiveStatus.consecutiveTimeouts++;
        this.receiveStatus.lastTimeout=Date.now();
        return {msgs:[],get_updates_buf:cursor};
      }
      throw e;
    }
    if(!Array.isArray(r.msgs)) throw new SafeError('invalid_weixin_messages');
    const receivedAt=Date.now();
    Object.assign(this.receiveStatus,{lastResponse:receivedAt,responses:this.receiveStatus.responses+1,
      consecutiveTimeouts:0,messages:this.receiveStatus.messages+r.msgs.length,lastBatchSize:r.msgs.length});
    if(r.msgs.length)this.receiveStatus.lastMessage=receivedAt;
    if(Number.isSafeInteger(r.longpolling_timeout_ms)&&r.longpolling_timeout_ms>0)
      this.longPollTimeoutMs=Math.min(120000,Math.max(45000,r.longpolling_timeout_ms+10000));
    return r;
  }
  sendItems(user,context,items,id) {
    return this.call('sendmessage',{msg:{from_user_id:'',to_user_id:user,client_id:id,message_type:2,
      message_state:2,context_token:context,item_list:items}});
  }
  send(user,context,text,id,quote) {
    return this.sendItems(user,context,[{type:1,text_item:{text},...(quote?{ref_msg:quote}:{})}],id);
  }
  getUploadUrl(body) { return this.call('getuploadurl',body); }
}

