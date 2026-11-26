export const requiredSlackScopes=['chat:write','im:history','files:read','files:write'];
export class SetupAuthorizationError extends Error {}

// Only the submitted bridge token is checked. Diagnostics never contain it.
export async function saveSlackAuthorization({token,fetcher,vault,target,onDiagnostic=()=>{},now=Date.now}){
  token=typeof token==='string'?token.trim():'';
  if(!/^xoxp-\S+$/.test(token))throw new SetupAuthorizationError('请输入此应用的 User OAuth Token（以 xoxp- 开头）。');
  let response,data;
  try{
    response=await fetcher('https://slack.com/api/auth.test',{method:'POST',headers:{Authorization:'Bearer '+token},
      redirect:'error',signal:AbortSignal.timeout(20000)});
    data=await response.json();
  }catch{throw new SetupAuthorizationError('连接 Slack 验证失败或超时，尚未保存。请稍后重试。');}
  const scopes=(response.headers.get('x-oauth-scopes')||'').split(',').map(s=>s.trim()).filter(Boolean);
  const checkedAt=now(),missingScopes=requiredSlackScopes.filter(s=>!scopes.includes(s));
  const diagnostic={checkedAt,scopes,missingScopes,matchingUser:data?.user_id===target.slackUser,
    matchingTeam:data?.team_id===target.slackTeam,saved:false};
  onDiagnostic(diagnostic);
  if(!response.ok||!data?.ok)throw new SetupAuthorizationError('Slack 未接受此 Token，尚未保存。请从此应用重新复制 User OAuth Token。');
  if(!diagnostic.matchingUser||!diagnostic.matchingTeam||data.bot_id)
    throw new SetupAuthorizationError('Slack 工作区或用户不匹配，尚未保存。请使用 Hilly Weixin Bridge 的 User OAuth Token。');
  if(missingScopes.length)throw new SetupAuthorizationError('尚未保存：Slack 返回此 Token 缺少 '+missingScopes.join('、')+'。如果 User Token Scopes 中已经添加，请完成 Reinstall to Workspace 授权，并核对 Token 来自同一个 Hilly Weixin Bridge 应用。');
  // Scopes already granted by the owner may exceed this relay's minimum.
  // Destination and caller identity remain bound; do not request more scopes.
  const saved=vault.load()||{};
  saved.slackToken=token;saved.slackAuthorization={scopes,verifiedAt:checkedAt};vault.save(saved);
  onDiagnostic({...diagnostic,saved:true,savedAt:checkedAt});
  return {ok:true,scopes,verifiedAt:checkedAt};
}
