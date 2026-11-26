import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
const MAX=101*1024*1024;
export class DirectHttp {
  constructor(network,{spawnProcess=spawn}={}){
    if(!Number.isInteger(network?.interfaceIndex)||network.interfaceIndex<1||
      !/^\d+\.\d+\.\d+\.\d+$/.test(network.localAddress)||!network.dnsServers?.length)
      throw Error('invalid_direct_network');
    this.network=network;this.spawnProcess=spawnProcess;this.pending=new Map();this.sequence=0;
  }
  ensureWorker(){
    if(this.closed)throw Error('direct_http_closed');
    if(this.child)return;
    const child=this.spawnProcess(this.network.pythonPath||'python',
      [fileURLToPath(new URL('./direct-http.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child=child;child.stderr.resume();
    const fail=()=>{if(this.child===child)this.child=null;for(const [id,p]of this.pending)if(p.child===child){p.finish();p.reject(Error('direct_worker_closed'));}};
    child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);
    readline.createInterface({input:child.stdout}).on('line',line=>{
      let value;try{value=JSON.parse(line);}catch{return;}
      const p=this.pending.get(value.id);if(!p||p.child!==child)return;p.finish();
      if(value.error){p.reject(Object.assign(Error('direct_request_failed'),{safeBeforeSend:value.safeBeforeSend===true,
        causeCode:value.causeCode,stage:value.stage}));return;}
      try{
        if(value.body.length>Math.ceil(MAX/3)*4)throw Error('direct_response_too_large');
        const bytes=Buffer.from(value.body,'base64');
        const response=new Response([204,205,304].includes(value.status)?null:bytes,{status:value.status,headers:value.headers});
        if(p.redirect==='error'&&value.status>=300&&value.status<400)throw Error('direct_redirect_rejected');
        p.resolve(response);
      }catch{p.reject(Error('direct_response_invalid'));}
    });
  }
  async fetch(url,options={}){
    const u=new URL(url);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||
      !(u.hostname==='slack.com'||u.hostname.endsWith('.slack.com')||u.hostname.endsWith('.qq.com')))
      throw Object.assign(Error('unapproved_direct_host'),{safeBeforeSend:true});
    if(options.signal?.aborted)throw options.signal.reason;
    const bytes=options.body===undefined?Buffer.alloc(0):Buffer.from(options.body);
    if(bytes.length>MAX)throw Object.assign(Error('direct_request_too_large'),{safeBeforeSend:true});
    try{this.ensureWorker();}catch(e){e.safeBeforeSend=true;throw e;}
    const child=this.child,id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const abort=()=>{const p=this.pending.get(id);if(!p)return;p.finish();
        try{child.stdin.write(JSON.stringify({cancel:id})+'\n');}catch{}
        reject(options.signal?.reason||Error('direct_request_timeout'));
      };
      const timer=setTimeout(abort,130000);
      const finish=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);this.pending.delete(id);};
      this.pending.set(id,{child,resolve,reject,finish,redirect:options.redirect});
      options.signal?.addEventListener('abort',abort,{once:true});
      child.stdin.write(JSON.stringify({id,network:this.network,url:String(u),method:options.method||'GET',
        headers:Object.fromEntries(new Headers(options.headers)),body:bytes.toString('base64')})+'\n',err=>{if(err&&this.pending.has(id)){finish();reject(Error('direct_worker_write_failed'));}});
    });
  }
  async close(){this.closed=true;for(const p of [...this.pending.values()]){p.finish();p.reject(Error('direct_http_closed'));}
    this.child?.stdin.end();this.child?.kill();this.child=null;}
}
