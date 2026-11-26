// Public diagnostics are allowlisted metadata only. Remote error text stays encrypted.
export function fatalStateError(e){
  return /^(dpapi_operation_failed|encrypted_state_unreadable|state_binding_mismatch|state_capacity_reached|invalid_lock|bridge_already_running)$/.test(e?.message||'')||
    /^(EACCES|EPERM|ENOSPC|EIO|EROFS|ENOENT)$/.test(e?.code||'');
}
export function errorMetadata(e,at=Date.now()){
  const code=/^(?:(?:connector|weixin|slack|invalid|unapproved|voice)_[a-z_]+|rate_limited|transport_outcome_unknown|remote_http_error|request_timeout|unexpected_destination)$/.test(e?.message||'')?e.message:'operation_failed';
  const out={code,at};
  for(const k of ['rpcCode','remoteCode'])if(Number.isSafeInteger(e?.[k]))out[k]=e[k];
  for(const k of ['stage','rpcMethod','tool','causeCode'])if(typeof e?.[k]==='string'&&/^[a-zA-Z0-9_.:/-]{1,100}$/.test(e[k]))out[k]=e[k];
  return out;
}
export function retryDelay(attempt=1,retryAfter=0){
  const base=Math.min(300000,5000*3**Math.min(Math.max(0,attempt-1),4));
  return Math.max(Math.min(3600000,Math.max(0,Number(retryAfter)||0)),Math.round(base*(0.85+Math.random()*0.3)));
}
export function deferItem(item,e,now){
  item.attempts=(item.attempts||0)+1;item.lastError=errorMetadata(e,now);
  item.deferUntil=now+retryDelay(item.attempts,e.retryAfter);
}
export function beforeSend(e,stage){e.safeBeforeSend=true;e.stage=stage;return e;}
