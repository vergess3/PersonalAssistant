import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackClient,WeixinClient } from '../src/clients.mjs';
const config={weixinUserId:'wx-user',weixinBotId:'wx-bot',slackChannel:'DTEST',slackAssistantUser:'UASSIST',
  slackUser:'UOWNER',slackTeam:'TTEAM',weixinOrigin:'https://ilinkai.weixin.qq.com',channelVersion:'2.4.8'};
const reply=()=>({user:'UASSIST',thread_ts:'1000.100000',ts:'1001.100000',text:'hello back'});
const response=data=>new Response(JSON.stringify(data),{status:200});

test('Weixin long-polls allow server hold time and expose timeouts separately from responses',async()=>{
  const deadlines=[],originalTimeout=AbortSignal.timeout;
  AbortSignal.timeout=ms=>{deadlines.push(ms);return originalTimeout(ms);};
  let calls=0;
  const w=new WeixinClient(config,'synthetic-token',async()=>{
    if(++calls===1)throw new DOMException('sensitive','TimeoutError');
    return response({ret:0,msgs:calls===2?[{message_id:'one'}]:[],get_updates_buf:'next',
      longpolling_timeout_ms:50000,errmsg:'private text'});
  });
  try{
    assert.deepEqual(await w.updates('cursor'),{msgs:[],get_updates_buf:'cursor'});
    assert.equal(w.receiveStatus.responses,0);assert.equal(w.receiveStatus.timeouts,1);
    assert.equal(w.receiveStatus.consecutiveTimeouts,1);assert.equal(w.receiveStatus.lastResponse,undefined);
    await w.updates('cursor');
    assert.equal(w.receiveStatus.responses,1);assert.equal(w.receiveStatus.messages,1);
    assert.equal(w.receiveStatus.consecutiveTimeouts,0);assert.ok(w.receiveStatus.lastMessage);
    await w.updates('next');
    assert.deepEqual(deadlines,[45000,45000,60000]);
    assert.equal(w.receiveStatus.lastBatchSize,0);assert.equal(w.receiveStatus.responses,2);
    assert.ok(!JSON.stringify(w.receiveStatus).includes('private'));
    assert.ok(!JSON.stringify(w.receiveStatus).includes('cursor'));
  }finally{AbortSignal.timeout=originalTimeout;}
});

test('Weixin native quotes remain separate from text and preserve uint64 reference/receipt IDs',async()=>{
  let body;
  const w=new WeixinClient(config,'synthetic-token',async(url,opts)=>{
    body=JSON.parse(opts.body);
    return new Response('{"ret":0,"message_id":18446744073709551615,"msgs":[{"item_list":[{"msg_id":18446744073709551614,"ref_msg":{"svr_id":18446744073709551613}}]}]}');
  });
  const quote={svr_id:'18446744073709551613',message_item:{type:1,text_item:{text:'hotel question'}}};
  const receipt=await w.send('wx-user','ctx','hotel answer','client',quote);
  assert.deepEqual(body.msg.item_list,[{type:1,text_item:{text:'hotel answer'},ref_msg:quote}]);
  assert.equal(receipt.message_id,'18446744073709551615');
  assert.equal(receipt.msgs[0].item_list[0].msg_id,'18446744073709551614');
  assert.equal(receipt.msgs[0].item_list[0].ref_msg.svr_id,'18446744073709551613');
});

test('direct file downloads preserve raw bytes and reject HTML, oversized headers and size mismatch',async()=>{
  const bytes=Buffer.from([0,255,13,10,128]);
  const file={url_private_download:'https://files.slack.com/synthetic',size:bytes.length};
  const s=new SlackClient(config,'synthetic-token',async()=>new Response(bytes));
  assert.deepEqual(await s.downloadFile(file),bytes);
  for(const r of [new Response('<html>login</html>',{headers:{'content-type':'text/html'}}),
    new Response(bytes,{headers:{'content-length':String(101*1024*1024)}}),new Response(Buffer.from([1]))]){
    const c=new SlackClient(config,'synthetic-token',async()=>r);
    await assert.rejects(c.downloadFile(file),/slack_file_(unavailable|too_large|size_mismatch)/);
  }
});
test('Slack login redirects select connector fallback without following or leaking credentials',async()=>{
  let calls=0;
  const client=new SlackClient(config,'synthetic-token',async(url,options)=>{
    calls++;assert.equal(options.redirect,'manual');assert.equal(new URL(url).hostname,'files.slack.com');
    return new Response(null,{status:302,headers:{location:'https://workspace.slack.com/login'}});
  });
  await assert.rejects(client.downloadFile({url_private_download:'https://files.slack.com/private'}),
    e=>e.message==='slack_file_unavailable');
  assert.equal(calls,1);
});

test('Slack validates exact user and workspace and rejects bot identity',async()=>{
  for(const data of [{ok:true,team_id:'OTHER',user_id:'UOWNER'},
    {ok:true,team_id:'TTEAM',user_id:'UOWNER',bot_id:'BOTHER'}]) {
    await assert.rejects(new SlackClient(config,'synthetic-token',async()=>response(data)).verify(),/identity/);
  }
  await new SlackClient(config,'synthetic-token',async()=>response({ok:true,team_id:'TTEAM',user_id:'UOWNER'})).verify();
});
test('Slack reads only known thread with pagination',async()=>{
  const calls=[];
  const s=new SlackClient(config,'synthetic-token',async(url,opts)=>{
    calls.push({url:String(url),opts});
    return response(calls.length===1?{ok:true,messages:[reply()],response_metadata:{next_cursor:'NEXT'}}:{ok:true,messages:[]});
  });
  assert.equal((await s.replies('1000.100000')).length,1); assert.equal(calls.length,2);
  assert.equal(new URL(calls[1].url).searchParams.get('cursor'),'NEXT');
  assert.equal(new URL(calls[0].url).searchParams.get('channel'),'DTEST');
  assert.equal(calls[0].opts.method,'GET');
});
test('Weixin payload uses inbound context and no media; redirects cannot leak token',async()=>{
  let capture;
  const w=new WeixinClient(config,'synthetic-token',async(url,opts)=>{capture={url,opts};return response({ret:0});});
  const text='行程：\n\n• 奥赛\n• 卢浮宫\n\n链接：\n[1] https://example.com/?a=1&b=2';
  await w.send('wx-user','synthetic-context',text,'id');
  const data=JSON.parse(capture.opts.body);
  assert.equal(data.msg.context_token,'synthetic-context'); assert.equal(data.msg.to_user_id,'wx-user');
  assert.equal(data.msg.item_list[0].type,1); assert.equal(capture.opts.redirect,'error');
  assert.equal(data.msg.item_list[0].text_item.text,text);
  assert.equal(capture.opts.headers['iLink-App-ClientVersion'],String(0x020408));
  for(const url of ['http://ilinkai.weixin.qq.com','https://evil.example','https://ilinkai.weixin.qq.com.evil.example','https://user@ilinkai.weixin.qq.com'])
    assert.throws(()=>new WeixinClient({...config,weixinOrigin:url},'x'),/origin/);
});
test('Weixin application errors and Slack rate limits are surfaced without remote secrets',async()=>{
  const w=new WeixinClient(config,'synthetic-token',async()=>response({ret:-14,errmsg:'sensitive'}));
  await assert.rejects(w.updates(''),e=>e.message==='weixin_session_expired'&&e.remoteCode===-14);
  const rejected=new WeixinClient(config,'synthetic-token',async()=>response({ret:-2,errmsg:'sensitive'}));
  await assert.rejects(rejected.send('wx-user','synthetic-context','hello','id'),e=>{
    assert.equal(e.message,'weixin_api_error');assert.equal(e.remoteCode,-2);
    assert.ok(!JSON.stringify(e).includes('sensitive'));return true;
  });
  const s=new SlackClient(config,'synthetic-token',async()=>new Response('sensitive',{status:429,headers:{'retry-after':'120'}}));
  await assert.rejects(s.replies('1000.1'),e=>e.message==='rate_limited'&&e.retryAfter===120000);
});
