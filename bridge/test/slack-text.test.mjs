import test from 'node:test';
import assert from 'node:assert/strict';
import { slackMessageText } from '../src/slack-text.mjs';
const text=(value,style)=>({type:'text',text:value,...(style?{style}:{})});
const section=(...elements)=>({type:'rich_text_section',elements});
const rich=(...elements)=>[{type:'rich_text',elements}];

test('flattened hotel fallback is replaced by display paragraphs, list items and a link reference',()=>{
  const message={text:'酒店：<https://hotel.example/|Hôtel 34B>  • 不可退 €724.77。 • 可退 €799.77。  尚未确认。',
    blocks:rich(section(text('酒店：'),{type:'link',url:'https://hotel.example/',text:'Hôtel 34B'},text('\n\n')),
      {type:'rich_text_list',style:'bullet',elements:[
        section(text('不可退 '),text('€724.77',{bold:true}),text('。')),
        section(text('可退 '),text('€799.77',{bold:true}),text('。'))]},
      section(text('\n'),text('尚未确认。',{bold:true})))};
  assert.equal(slackMessageText(message),
    '酒店：Hôtel 34B[1]\n\n• 不可退 €724.77。\n• 可退 €799.77。\n\n尚未确认。\n\n链接：\n[1] https://hotel.example/');
});

test('block-only messages, explicit paragraph breaks, Unicode and literal formatting characters survive',()=>{
  assert.equal(slackMessageText({blocks:rich(section(text('第一段\n\n第二段 😀\n逐行\n'),
    text('literal * _ ~ &amp;',{code:true})))}),
    '第一段\n\n第二段 😀\n逐行\nliteral * _ ~ &amp;');
});

test('ordered lists keep offsets, nested indentation and multiline item continuation',()=>{
  const blocks=rich(section(text('步骤：')),
    {type:'rich_text_list',style:'ordered',offset:2,elements:[section(text('第三步\n继续')),section(text('第四步'))]},
    {type:'rich_text_list',style:'bullet',indent:1,elements:[section(text('子项'))]},
    section(text('结束')));
  assert.equal(slackMessageText({blocks}), '步骤：\n\n3. 第三步\n   继续\n4. 第四步\n  • 子项\n\n结束');
});

test('quotes and code preserve lines and operators; emoji converts from Unicode',()=>{
  const blocks=rich({type:'rich_text_quote',elements:[text('引用\n第二行')]},
    {type:'rich_text_preformatted',elements:[text('  a_b = 2 * 3\n\n  c = "<x>"')]},
    section({type:'emoji',name:'wave',unicode:'1f44b-1f3fd'},text(' '),{type:'emoji',name:'custom'}));
  assert.equal(slackMessageText({blocks}), '│ 引用\n│ 第二行\n\n  a_b = 2 * 3\n\n  c = "<x>"\n\n👋🏽 :custom:');
});

test('links deduplicate without losing query parameters; bare links and email retain their address',()=>{
  const url='https://example.com/a_b?x=1&y=2';
  assert.equal(slackMessageText({blocks:rich(section(
    {type:'link',url,text:'官网'},text('、'),{type:'link',url,text:'选票页'},text('\n'),
    {type:'link',url:'https://bare.example/'},text('\n'),
    {type:'link',url:'mailto:user@example.com',text:'user@example.com'}))}),
    `官网[1]、选票页[1]\nhttps://bare.example/\nuser@example.com\n\n链接：\n[1] ${url}`);
});

test('mrkdwn-only fallback removes Slack syntax while preserving newlines, code and URL punctuation',()=>{
  const value='*重点*\n\n• 语音*可以处理*，_强调_。\n<https://example.com/a_b_c?x=1&amp;y=2|官方选票页>\n'+
    'https://bare.example/a_b_c\n`x_y_z * 2`\n```\n  a_b = 2 * 3\n```\n&lt;literal&gt;';
  assert.equal(slackMessageText({text:value}),
    '重点\n\n• 语音可以处理，强调。\n官方选票页[1]\nhttps://bare.example/a_b_c\nx_y_z * 2\n  a_b = 2 * 3\n\n<literal>\n\n链接：\n[1] https://example.com/a_b_c?x=1&y=2');
});

test('unsupported content uses the complete fallback and discards partial link references',()=>{
  const blocks=rich(section({type:'link',url:'https://unused.example/',text:'部分'}),
    {type:'future_element',text:'future content'});
  assert.equal(slackMessageText({blocks,text:'完整消息\n<https://used.example/|链接>'}),
    '完整消息\n链接[1]\n\n链接：\n[1] https://used.example/');
  assert.equal(slackMessageText({text:'hello\n\n世界 😀'}),'hello\n\n世界 😀');
  assert.equal(slackMessageText({text:'',files:[{id:'F1'}]}),'');
});

test('Block Kit text sections retain fields and plain text without interpreting its markup',()=>{
  const blocks=[{type:'header',text:{type:'plain_text',text:'*标题*'}},
    {type:'section',text:{type:'mrkdwn',text:'*重点*'},fields:[
      {type:'plain_text',text:'字段一'}, {type:'mrkdwn',text:'<https://example.com|详情>'}]}];
  assert.equal(slackMessageText({blocks,text:'flat'}),'*标题*\n\n重点\n字段一\n详情[1]\n\n链接：\n[1] https://example.com');
});
