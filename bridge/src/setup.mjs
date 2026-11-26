import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EncryptedStore,acquireLock } from './vault.mjs';
import { target } from './config.mjs';
import {saveSlackAuthorization,SetupAuthorizationError} from './setup-slack.mjs';
import {configureHttp,fetch} from './network.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),port=37641,origin='http://127.0.0.1:'+port;
const httpTransport=configureHttp(JSON.parse(fs.readFileSync(path.join(root,'relay-runtime.json'),'utf8')).network);
const vault=new EncryptedStore(path.join(root,'state','credentials.dpapi'));
const release=acquireLock(path.join(root,'state','setup.lock'));
const csrf=randomBytes(24).toString('hex'),version='2.4.10',versionInt=String(0x02040a);
let login=null;
function allowedOrigin(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.pathname!=='/'||
    !(u.hostname==='ilinkai.weixin.qq.com'||u.hostname.endsWith('.ilinkai.weixin.qq.com'))) throw new Error('Weixin origin needs review');
  return u.origin;
}
async function wx(url,opts={}) {
  const r=await fetch(url,{...opts,redirect:'error',signal:AbortSignal.timeout(40000),
    headers:{'iLink-App-Id':'bot','iLink-App-ClientVersion':versionInt,...opts.headers}});
  if(!r.ok)throw new Error('Weixin request failed');
  return r.json();
}
const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Hilly 微信桥接 · 本机授权</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{max-width:740px;margin:40px auto;padding:0 20px;font:16px system-ui;line-height:1.7;background:#f5f7fa;color:#172435}
section{background:white;border-radius:14px;padding:24px;margin:20px 0}button,input{padding:10px;font:inherit}input{width:90%}button{cursor:pointer;margin:8px 0}pre{white-space:pre-wrap}#qr svg{max-width:300px;height:300px}
.feedback{padding:12px;border-radius:8px;white-space:pre-wrap}.feedback[data-state="pending"]{background:#eaf2ff}.feedback[data-state="error"]{background:#fff0ef;color:#8b211c}.feedback[data-state="success"]{background:#e8f6ee;color:#175c35}button:disabled{cursor:wait;opacity:.7}
</style><h1>Hilly 微信桥接</h1><p>此页面只在这台电脑的 127.0.0.1 上运行。令牌由 Windows 当前用户加密保存，不进入聊天或日志。</p>
<section><h2>1. Slack 用户授权</h2><p>在 Hilly 工作区打开现有 Hilly Weixin Bridge 应用，开启 Slack MCP Server。User Token Scopes 需要：<b>chat:write</b>、<b>im:history</b>、<b>files:read</b>、<b>files:write</b>，用于文字、图片、语音和文件双向转发，不添加 Bot Scopes。完成 Slack 自身的重新安装授权后，将该应用的 User OAuth Token 粘贴到下方本机密码框。</p>
<p>读取权限本身可能覆盖其他私聊；桥接只访问已指定的 hilly 私聊。不要提交浏览器 Cookie、其他应用的令牌或客户端密钥。</p>
<a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">打开 Slack 应用管理</a>
<form id="slack"><label>User OAuth Token <input id="token" type="password" autocomplete="off" required></label><br><button id="slack-submit" type="submit">验证并加密保存</button><p id="slack-feedback" class="feedback" role="status" aria-live="polite" hidden></p></form></section>
<section><h2>2. 微信扫码绑定</h2><p>用你自己的微信扫描，只绑定扫码用户和此机器人会话。不会转发其他联系人、群聊或启用以前的消息。</p>
<button id="start">生成微信授权二维码</button><div id="qr"></div><form id="verify" hidden><label>如手机提示配对码，在本机输入：<input id="code" type="password" autocomplete="off"></label><button>提交配对码</button></form></section>
<section><h2>状态</h2><pre id="status">读取状态中</pre><p>绑定完成不等于双向测试完成。请返回聊天告知已完成；助手会继续测试。</p></section>
<script nonce="${csrf}">
const csrf='${csrf}',status=document.querySelector('#status');let code='',polling=false;
async function api(action,data={}){let r,x;try{r=await fetch('/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data),signal:AbortSignal.timeout(30000)});x=await r.json();}catch{throw Error('连接失败或等待超时，请刷新页面后重试。');}if(!r.ok)throw Error(x.error||'操作失败');return x;}
async function refresh(){try{status.textContent=JSON.stringify(await api('status'),null,2);}catch(e){status.textContent=e.message;}}
document.querySelector('#slack').onsubmit=async e=>{
e.preventDefault();const input=document.querySelector('#token'),button=document.querySelector('#slack-submit'),feedback=document.querySelector('#slack-feedback');
if(button.disabled)return;const token=input.value.trim();if(!token){feedback.hidden=false;feedback.dataset.state='error';feedback.textContent='请先输入 User OAuth Token。';return;}
input.value='';button.disabled=true;button.textContent='正在验证，请稍候…';feedback.hidden=false;feedback.dataset.state='pending';feedback.textContent='正在连接 Slack 核验用户和文件权限，通常需要几秒钟…';
try{await api('slack',{token});feedback.dataset.state='success';feedback.textContent='验证通过，已加密保存。请返回聊天告知助手，继续核验文件转发。';await refresh();}
catch(e){feedback.dataset.state='error';feedback.textContent=e.message;status.textContent=e.message;}
finally{button.disabled=false;button.textContent='验证并加密保存';}
};
document.querySelector('#start').onclick=async()=>{try{const x=await api('weixin-start');document.querySelector('#qr').innerHTML=x.svg;polling=true;poll();}catch(e){status.textContent=e.message;}};
document.querySelector('#verify').onsubmit=e=>{e.preventDefault();code=document.querySelector('#code').value;document.querySelector('#code').value='';};
async function poll(){if(!polling)return;try{const x=await api('weixin-poll',{code});code='';status.textContent=x.status;
document.querySelector('#verify').hidden=x.status!=='need_verifycode';
if(x.status==='confirmed'){polling=false;document.querySelector('#qr').replaceChildren();await refresh();return;}
if(['expired','verify_code_blocked','binded_redirect'].includes(x.status)){polling=false;return;}
}catch(e){status.textContent=e.message;polling=false;return;}setTimeout(poll,2000);}
refresh();
</script></html>`;
async function readBody(req) {
  let n=0,chunks=[];for await(const c of req){n+=c.length;if(n>8192)throw new Error('Request too large');chunks.push(c);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'nonce-"+csrf+"'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'");
  try {
    if(req.headers.host!=='127.0.0.1:'+port)throw new Error('Invalid host');
    if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
    if(req.method!=='POST'||req.headers.origin!==origin||req.headers['x-csrf-token']!==csrf)throw new Error('Local authorization required');
    const body=await readBody(req);let result;
    if(req.url==='/status'){const saved=vault.load()||{};result={Slack:saved.slackAuthorization?'文字及文件权限已验证并加密保存':saved.slackToken?'已保存授权，文件权限尚未验证':'等待授权',Weixin:saved.weixin?'已绑定并加密保存':'等待扫码',EndToEnd:'等待桥接核验'};}
    else if(req.url==='/slack'){
      result=await saveSlackAuthorization({token:body.token,fetcher:fetch,vault,target,
        onDiagnostic:d=>fs.writeFileSync(path.join(root,'authorization-diagnostic.json'),JSON.stringify(d))});
    } else if(req.url==='/weixin-start'){
      if((vault.load()||{}).weixin)throw new Error('已经绑定，不自动覆盖');
      const q=await wx('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3',{
        method:'POST',headers:{'Content-Type':'application/json',AuthorizationType:'ilink_bot_token',
          'X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')},
        body:JSON.stringify({local_token_list:[]})});
      if(typeof q.qrcode!=='string'||typeof q.qrcode_img_content!=='string'||q.qrcode_img_content.length>2048)throw new Error('Invalid QR response');
      login={code:q.qrcode,origin:'https://ilinkai.weixin.qq.com',until:Date.now()+300000};
      const svg=execFileSync('C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python314\\python.exe',[path.join(root,'scripts','render-qr.py'),path.join(root,'state','weixin-login-qr.png')],
        {input:q.qrcode_img_content,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']});
      result={svg};
    } else if(req.url==='/weixin-poll'){
      if(!login||Date.now()>login.until){result={status:'expired'};}
      else {
        const u=new URL('/ilink/bot/get_qrcode_status',login.origin);u.searchParams.set('qrcode',login.code);
        if(body.code){if(!/^\d{1,12}$/.test(body.code))throw new Error('配对码格式不正确');u.searchParams.set('verify_code',body.code);}
        const r=await wx(u);
        if(r.status==='scaned_but_redirect'&&r.redirect_host){login.origin=allowedOrigin('https://'+r.redirect_host.replace(/^https:\/\//,''));}
        if(r.status==='confirmed'){
          if(!r.bot_token||!r.ilink_bot_id||!r.ilink_user_id)throw new Error('Incomplete login response');
          const saved=vault.load()||{};saved.weixin={token:r.bot_token,botId:r.ilink_bot_id,userId:r.ilink_user_id,origin:allowedOrigin(r.baseurl),version,boundAt:Date.now()};
          vault.save(saved);login=null;
        }
        const statuses=['wait','scaned','confirmed','expired','need_verifycode','verify_code_blocked','scaned_but_redirect','binded_redirect'];
        result={status:statuses.includes(r.status)?r.status:'unknown'};
      }
    } else {throw new Error('Unknown operation');}
    res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(result));
  }catch(e){
    // Only our messages are safe; never render remote response bodies.
    const safe=['已经绑定，不自动覆盖','配对码格式不正确','Weixin origin needs review','Incomplete login response'];
    res.statusCode=400;res.setHeader('Content-Type','application/json; charset=utf-8');
    res.end(JSON.stringify({error:e instanceof SetupAuthorizationError||safe.includes(e.message)?e.message:e.message==='Local authorization required'?'页面已过期，请刷新页面后重新输入。':'操作未完成，请重试或联系助手核对；未显示任何凭证'}));
  }
});
server.listen(port,'127.0.0.1',()=>console.log('Secure local setup ready: '+origin));
server.on('error',()=>{release();console.error('setup_server_failed');process.exitCode=1;});
function stop(){server.close();httpTransport.close();release();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);




