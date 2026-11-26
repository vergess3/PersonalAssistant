import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagedConnector} from '../src/managed-connector.mjs';
import {errorMetadata,retryDelay} from '../src/recovery.mjs';
import {runBridge} from '../src/runner.mjs';

test('connector initialization failures defer safely and reconnect without replaying writes',async()=>{
  let now=100,instances=0,writes=0,closed=0;
  const c=new ManagedConnector({}, {now:()=>now,factory:()=>{
    const n=++instances;return {start:async()=>{if(n===1)throw Error('connector_rpc_error');},verifyRead:async()=>{},
      close:()=>closed++,post:async()=>{writes++;return 'sent';}};
  }});
  await assert.rejects(c.post('one'),e=>e.safeBeforeSend&&e.stage==='connector_start');
  await assert.rejects(c.post('one'),/connector_reconnect_deferred/);assert.equal(writes,0);assert.equal(instances,1);
  now=10000;assert.equal(await c.post('one'),'sent');assert.equal(writes,1);assert.equal(instances,2);assert.equal(closed,1);c.close();
});

test('ambiguous RPC writes are not automatically retried; the next independent operation reconnects',async()=>{
  let now=0,instances=0;const writes=[];
  const c=new ManagedConnector({}, {now:()=>now,factory:()=>{
    const n=++instances;return {start:async()=>{},verifyRead:async()=>{},close:()=>{},
      post:async text=>{writes.push(text);if(n===1)throw Error('connector_rpc_error');return 'ok';}};
  }});
  await assert.rejects(c.post('ambiguous'),e=>!e.safeBeforeSend);now=10000;
  assert.equal(await c.post('independent'),'ok');assert.deepEqual(writes,['ambiguous','independent']);c.close();
});

test('concurrent callers share one verified connector startup',async()=>{
  let instances=0,finish;const wait=new Promise(r=>finish=r);
  const c=new ManagedConnector({}, {factory:()=>{instances++;return {start:()=>wait,verifyRead:async()=>{},close:()=>{},post:async t=>t};}});
  const a=c.post('a'),b=c.post('b');finish();assert.deepEqual(await Promise.all([a,b]),['a','b']);assert.equal(instances,1);c.close();
});

test('confirmation and identity failures block the connector without automatic approval or reconnect',async()=>{
  for(const code of ['connector_confirmation_required','connector_account_mismatch']){
    let now=0,instances=0;const c=new ManagedConnector({}, {now:()=>now,factory:()=>{instances++;return {start:async()=>{throw Error(code);},close:()=>{}};}});
    await assert.rejects(c.post('one'));now=999999;await assert.rejects(c.post('two'));assert.equal(instances,1);assert.equal(c.status.blocked,true);c.close();
  }
});

test('public diagnostics exclude arbitrary remote text, URLs and credentials',()=>{
  const e=Object.assign(Error('private token=secret'),{rpcCode:-32000,stage:'upload_init',tool:'slack.slack_get_file_upload_url',raw:'secret',causeCode:'secret https://example.com'});
  assert.deepEqual(errorMetadata(e,10),{code:'operation_failed',at:10,rpcCode:-32000,stage:'upload_init',tool:'slack.slack_get_file_upload_url'});
  assert.ok(retryDelay(1)>=4250);assert.ok(retryDelay(20)<=345000);assert.ok(retryDelay(1,60000)>=60000);
});

test('missing file tools refresh on a later operation after authorization is updated',async()=>{
  let now=0,instances=0;const c=new ManagedConnector({}, {now:()=>now,factory:()=>{
    const n=++instances;return {start:async()=>{},verifyRead:async()=>{},close:()=>{},
      uploadFile:async()=>{if(n===1)throw Object.assign(Error('connector_file_permission_required'),{safeBeforeSend:true});return {fileId:'F123'};}};
  }});
  await assert.rejects(c.uploadFile({}),e=>e.safeBeforeSend);assert.equal(c.status.ready,false);assert.equal(c.status.blocked,false);
  now=10000;assert.deepEqual(await c.uploadFile({}),{fileId:'F123'});assert.equal(instances,2);c.close();
});

test('slow send and failed receive do not stop reply polling, returns, or health', {timeout:3000},async()=>{
  let stopped=false,polls=0,returns=0,sendDone=false;const health=[];
  const relay={state:{jobs:[],outbox:[],slackActiveFrom:0,slackWatermark:0},now:Date.now,uncertain:false,
    sendQueued:async()=>{await new Promise(r=>setTimeout(r,80));sendDone=true;stopped=true;},
    returnQueued:async()=>{assert.equal(sendDone,false);returns++;},
    collectSlackMessages:()=>{polls++;},save:()=>{}};
  await runBridge({relay,forwarding:true,shouldStop:()=>stopped,connector:{status:{ready:true}},
    reader:{verify:async()=>{},historySince:async()=>[],replies:async()=>[]},
    weixin:{updates:async()=>{throw Error('transport_outcome_unknown');}},
    intervals:{send:1,poll:2,return:2,health:2},onHealth:h=>health.push(h)});
  assert.ok(polls>1);assert.ok(returns>1);assert.ok(health.some(h=>h.lanes.receive?.lastError?.code==='transport_outcome_unknown'));
});
