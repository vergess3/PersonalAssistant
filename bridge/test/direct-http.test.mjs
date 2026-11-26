import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {DirectHttp} from '../src/direct-http.mjs';
const net={interfaceIndex:18,localAddress:'10.1.0.15',dnsServers:['183.60.83.19']};
function fixture(handler){
 const requests=[];let starts=0;
 const c=new DirectHttp(net,{spawnProcess:()=>{
  starts++;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  child.stdin=new Writable({write(chunk,encoding,done){const m=JSON.parse(chunk.toString('utf8'));requests.push(m);done();if(m.cancel)return;
   handler(m,value=>child.stdout.write(JSON.stringify({id:m.id,...value})+'\n'));
  }});return child;
 }});return {c,requests,starts:()=>starts};
}
test('physical HTTP IPC preserves Chinese and arbitrary bytes and never routes through proxy settings',async()=>{
 const bytes=Buffer.from([0,255,13,10,128]),{c,requests}=fixture((m,reply)=>reply({status:200,headers:[['content-type','application/octet-stream']],body:m.body}));
 const text='中文消息。';
 assert.equal(await (await c.fetch('https://slack.com/api/auth.test',{method:'POST',body:text})).text(),text);
 assert.deepEqual(Buffer.from(await (await c.fetch('https://files.slack.com/a',{method:'POST',body:bytes})).arrayBuffer()),bytes);
 assert.deepEqual(requests[0].network,net);assert.equal(Buffer.from(requests[0].body,'base64').toString(),text);await c.close();
});
test('independent requests complete out of order; cancelling one does not cancel another',async()=>{
 const waiting=new Map(),{c,requests,starts}=fixture((m,reply)=>waiting.set(m.id,reply));
 const controller=new AbortController();const a=c.fetch('https://slack.com/a',{signal:controller.signal}),b=c.fetch('https://slack.com/b');
 waiting.get(2)({status:200,headers:[],body:Buffer.from('second').toString('base64')});assert.equal(await (await b).text(),'second');
 controller.abort();await assert.rejects(a);assert.equal(starts(),1);assert.ok(requests.some(r=>r.cancel===1));await c.close();
});
test('direct requests reject untrusted destinations and redirects without forwarding credentials',async()=>{
 const {c,requests}=fixture((m,reply)=>reply({status:302,headers:[['location','https://evil.example']],body:''}));
 for(const url of ['http://slack.com/a','https://slack.com.evil.example/a','https://user@slack.com/a'])await assert.rejects(c.fetch(url),e=>e.safeBeforeSend);
 assert.equal(requests.length,0);await assert.rejects(c.fetch('https://slack.com/a',{redirect:'error'}));assert.equal(requests.length,1);await c.close();
});
test('known pre-send failures retain classification and expose no remote payloads',async()=>{
 const {c}=fixture((m,reply)=>reply({error:'direct_request_failed',safeBeforeSend:true,stage:'connect',causeCode:'TimeoutError'}));
 await assert.rejects(c.fetch('https://slack.com/a'),e=>e.safeBeforeSend&&e.stage==='connect');await c.close();
});
