import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {saveSlackAuthorization,SetupAuthorizationError,requiredSlackScopes} from '../src/setup-slack.mjs';

const target={slackUser:'U',slackTeam:'T'};
const token='xoxp-synthetic-test-secret';
function fixture(scopes,{data={ok:true,user_id:'U',team_id:'T'},failure}={}){
  let stored={slackToken:'old-token',weixin:{userId:'bound-user'}},writes=0;
  const diagnostics=[];
  return {diagnostics,get stored(){return stored;},get writes(){return writes;},args:{token,target,now:()=>100,
    vault:{load:()=>structuredClone(stored),save:value=>{stored=value;writes++;}},onDiagnostic:d=>diagnostics.push(d),
    fetcher:async(url,options)=>{
      assert.equal(url,'https://slack.com/api/auth.test');assert.equal(options.headers.Authorization,'Bearer '+token);
      if(failure)throw Error(failure);
      return new Response(JSON.stringify(data),{headers:{'x-oauth-scopes':scopes.join(',')}});
    }}};
}
test('submitted text-only token reports both missing file scopes and preserves the working grant',async()=>{
  const f=fixture(['identify','im:history','chat:write']);
  await assert.rejects(saveSlackAuthorization(f.args),e=>e instanceof SetupAuthorizationError&&
    e.message.includes('files:read')&&e.message.includes('files:write')&&e.message.includes('Reinstall'));
  assert.equal(f.writes,0);assert.equal(f.stored.slackToken,'old-token');
  assert.deepEqual(f.diagnostics[0].missingScopes,['files:read','files:write']);
  assert.ok(!JSON.stringify(f.diagnostics).includes(token));
});
test('a fully authorized user token is saved with its verification time, preserving WeChat binding',async()=>{
  const f=fixture(['identify',...requiredSlackScopes]);
  const result=await saveSlackAuthorization({...f.args,token:'  '+token+'  '});
  assert.equal(result.ok,true);assert.equal(f.writes,1);assert.equal(f.stored.slackToken,token);
  assert.deepEqual(f.stored.weixin,{userId:'bound-user'});assert.equal(f.stored.slackAuthorization.verifiedAt,100);
  assert.equal(f.diagnostics.at(-1).saved,true);assert.ok(!JSON.stringify(result).includes(token));
});
test('wrong identity, bot tokens and revoked tokens cannot replace the stored grant',async()=>{
  for(const options of [{data:{ok:true,user_id:'OTHER',team_id:'T'}},
    {data:{ok:true,user_id:'U',team_id:'T',bot_id:'B'}},{data:{ok:false,error:'private-remote-detail'}}]){
    const f=fixture(requiredSlackScopes,options);
    await assert.rejects(saveSlackAuthorization(f.args),e=>e instanceof SetupAuthorizationError&&!e.message.includes('private-remote-detail'));
    assert.equal(f.writes,0);
  }
});
test('existing additional user scopes do not reject a valid grant; identity and required scopes still apply',async()=>{
  const scopes=['identify',...requiredSlackScopes,'canvases:read','channels:history','lists:write'];
  const f=fixture(scopes);assert.equal((await saveSlackAuthorization(f.args)).ok,true);
  assert.equal(f.writes,1);assert.deepEqual(f.stored.slackAuthorization.scopes,scopes);
  const wrongUser=fixture(scopes,{data:{ok:true,user_id:'OTHER',team_id:'T'}});
  await assert.rejects(saveSlackAuthorization(wrongUser.args),/用户不匹配/);assert.equal(wrongUser.writes,0);
  const missingFiles=fixture(scopes.filter(s=>s!=='files:read'));
  await assert.rejects(saveSlackAuthorization(missingFiles.args),/files:read/);assert.equal(missingFiles.writes,0);
});
test('network failures give safe actionable feedback without leaking remote details or saving',async()=>{
  const f=fixture([],{failure:'private '+token});
  await assert.rejects(saveSlackAuthorization(f.args),e=>e instanceof SetupAuthorizationError&&e.message.includes('超时')&&!e.message.includes(token));
  assert.equal(f.writes,0);
});
test('save button immediately shows progress, suppresses duplicate submits, then displays rejection or success beside it',async()=>{
  const source=fs.readFileSync(new URL('../src/setup.mjs',import.meta.url),'utf8');
  const handler=source.match(/document\.querySelector\('#slack'\)\.onsubmit=async e=>\{[\s\S]*?\n\};/)[0];
  for(const reject of [true,false]){
    const nodes={'#slack':{},'#token':{value:token},'#slack-submit':{disabled:false},'#slack-feedback':{hidden:true,dataset:{}}};
    let finish,calls=0,refreshed=false;
    const promise=new Promise((resolve,rejectPromise)=>{finish=()=>reject?rejectPromise(Error('尚未保存：缺少 files:read、files:write')):resolve({ok:true});});
    const context={document:{querySelector:s=>nodes[s]},status:{textContent:''},
      api:()=>{calls++;return promise;},refresh:async()=>{refreshed=true;}};
    vm.runInNewContext(handler,context);
    const active=nodes['#slack'].onsubmit({preventDefault(){}});
    assert.equal(nodes['#slack-submit'].disabled,true);assert.equal(nodes['#slack-feedback'].hidden,false);
    assert.equal(nodes['#slack-feedback'].dataset.state,'pending');assert.equal(nodes['#token'].value,'');
    await nodes['#slack'].onsubmit({preventDefault(){}});assert.equal(calls,1);
    finish();await active;assert.equal(nodes['#slack-submit'].disabled,false);
    assert.equal(nodes['#slack-feedback'].dataset.state,reject?'error':'success');
    assert.ok(!nodes['#slack-feedback'].textContent.includes(token));
    assert.equal(refreshed,!reject);
    if(reject)assert.ok(nodes['#slack-feedback'].textContent.includes('files:write'));
  }
});
