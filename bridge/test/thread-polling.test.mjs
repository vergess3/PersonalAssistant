import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchSlackMessages} from '../src/relay-loop.mjs';
import {Relay} from '../src/relay.mjs';

const NOW=1794606100000;
const ROOT='1794526268.314639';
const config={slackTeam:'T',slackUser:'U',slackChannel:'D',slackAssistantUser:'A',weixinUserId:'W',weixinBotId:'B'};
const historicalJobs=()=>Array.from({length:165},(_,i)=>({id:'old-'+i,phase:'posted',slackTs:String(1794400000+i)+'.000001'}));

test('a quoted old topic is polled immediately among 165 historical topics, including after restart',async()=>{
  let saved=null;const delivered=[];
  const store={load:()=>saved&&structuredClone(saved),save:s=>{saved=structuredClone(s);}};
  const restore=()=>new Relay({config,store,connector:{},weixin:{send:async(...args)=>{
    delivered.push(args[2]);return {message_id:String(delivered.length)};
  }},activeFrom:1794400000000,now:()=>NOW});
  const relay=restore();relay.state.jobs=historicalJobs();
  relay.state.jobs[100].slackTs=ROOT;
  relay.state.jobs.push({id:'follow-up',phase:'posted',threadTs:ROOT,slackTs:'1794604907.035519',receivedAt:1794604904923});
  relay.state.slackWatermark=1794605878133.809;
  // It was checked just before the follow-up; background rotation would wait
  // for almost all 165 other topics before checking it again.
  relay.threadReads=new Map([[ROOT,1794604800000]]);
  const replies=['1794604922.288509','1794604945.962499','1794605011.660199'].map((ts,i)=>({user:'A',ts,thread_ts:ROOT,text:'missing-'+i}));
  const calls=[];
  const reader={historySince:async()=>[],replies:async root=>{
    calls.push(root);return root===ROOT?replies:[];
  }};
  const result=await fetchSlackMessages(relay,reader);
  assert.equal(calls[0],ROOT);
  relay.collectSlackMessages(result.messages);await relay.returnQueued();
  assert.deepEqual(delivered,['missing-0','missing-1','missing-2']);
  calls.length=0;const restarted=restore();
  const again=await fetchSlackMessages(restarted,reader);
  assert.equal(calls[0],ROOT);
  restarted.collectSlackMessages(again.messages);await restarted.returnQueued();
  assert.equal(delivered.length,3);
});

test('active topics rotate within a bounded poll while historical topics keep making progress',async()=>{
  let now=NOW;const jobs=historicalJobs();
  const active=Array.from({length:8},(_,i)=>({id:'active-'+i,phase:'posted',threadTs:String(1794500000+i)+'.000001',
    slackTs:String(NOW/1000-10+i)+'.000001'}));
  jobs.push(...active,{...active[7],id:'same-topic',slackTs:String(NOW/1000-1)+'.000001'});
  const relay={state:{jobs,slackActiveFrom:1794400000000,slackWatermark:NOW},now:()=>now};
  const visited=new Set(),historical=new Set();
  for(let pass=0;pass<3;pass++){
    const calls=[];
    await fetchSlackMessages(relay,{historySince:async()=>[],replies:async root=>{calls.push(root);return [];}});
    assert.ok(calls.length<=4);
    assert.equal(new Set(calls).size,calls.length);
    for(const root of calls){if(active.some(j=>j.threadTs===root))visited.add(root);else historical.add(root);}
    now+=10000;
  }
  assert.equal(visited.size,8);
  assert.equal(historical.size,3);
});

test('new activity in a recently checked old topic takes priority over other active topics',async()=>{
  const jobs=historicalJobs();
  jobs.push(...Array.from({length:4},(_,i)=>({id:'active-'+i,phase:'posted',threadTs:String(1794500000+i)+'.000001',slackTs:String(NOW/1000-60)+'.000001'})));
  jobs.push({id:'revived',phase:'posted',threadTs:ROOT,slackTs:String(NOW/1000-1)+'.000001'});
  const threadReads=new Map(jobs.map(j=>[j.threadTs||j.slackTs,NOW-2000]));
  const calls=[];
  await fetchSlackMessages({state:{jobs,slackActiveFrom:1794400000000,slackWatermark:NOW},threadReads,now:()=>NOW},
    {historySince:async()=>[],replies:async root=>{calls.push(root);return [];}});
  assert.equal(calls[0],ROOT);
});
