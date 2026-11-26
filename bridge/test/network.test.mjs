import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {getGlobalDispatcher,setGlobalDispatcher} from 'undici';
import {configureHttp,fetch} from '../src/network.mjs';

test('production HTTP client supports real binary uploads with explicit Content-Length',async()=>{
  const requests=[];
  const server=http.createServer((req,res)=>{const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
    requests.push({length:req.headers['content-length'],bytes:Buffer.concat(chunks)});res.end('ok');
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const previous=getGlobalDispatcher(),agent=configureHttp(),bytes=Buffer.from([0,1,128,255]);
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/',{method:'POST',body:bytes,
      headers:{'Content-Type':'image/jpeg','Content-Length':String(bytes.length)},signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);assert.equal(await response.text(),'ok');
    assert.equal(requests.length,1);assert.equal(requests[0].length,'4');assert.deepEqual(requests[0].bytes,bytes);
  }finally{setGlobalDispatcher(previous);await agent.close();await new Promise(resolve=>server.close(resolve));}
});
