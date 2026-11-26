import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
// DPAPI CurrentUser: raw input travels only over anonymous pipes, never argv/logs.
export function dpapi(input, decrypt=false) {
  if(process.platform!=='win32') throw new Error('windows_dpapi_required');
  const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[System.Security.Cryptography.ProtectedData]::${decrypt?'Unprotect':'Protect'}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  try {
    return Buffer.from(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
      {input:Buffer.from(input).toString('base64'),encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe'],maxBuffer:32*1024*1024}).trim(),'base64');
  } catch { throw new Error('dpapi_operation_failed'); }
}
export class EncryptedStore {
  constructor(file,codec={seal:b=>dpapi(b),open:b=>dpapi(b,true)}) { this.file=path.resolve(file);this.codec=codec; }
  load() {
    if(!fs.existsSync(this.file)) return null;
    try { return JSON.parse(this.codec.open(fs.readFileSync(this.file)).toString('utf8')); }
    catch { throw new Error('encrypted_state_unreadable'); }
  }
  save(value) {
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    const tmp=this.file+'.'+randomUUID()+'.tmp';
    const data=this.codec.seal(Buffer.from(JSON.stringify(value),'utf8'));
    const fd=fs.openSync(tmp,'wx');
    try { fs.writeFileSync(fd,data);fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp,this.file);
  }
}
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try { const fd=fs.openSync(file,'wx');fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd); }
  catch(e) {
    if(e.code!=='EEXIST') throw e;
    const pid=Number(fs.readFileSync(file,'utf8'));
    if(!Number.isInteger(pid)||pid<1) throw new Error('invalid_lock');
    try { process.kill(pid,0); throw new Error('bridge_already_running'); }
    catch(err) { if(err.code!=='ESRCH') throw err; }
    // Only our exact stale lock, after checking that its process no longer exists.
    fs.unlinkSync(file); return acquireLock(file);
  }
  return ()=>{if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file);};
}

