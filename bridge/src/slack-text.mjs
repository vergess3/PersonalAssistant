// Slack's top-level text may be a flattened accessibility fallback. Render the
// display blocks instead; Weixin text items do not render Slack rich text.
const decode = text => text.replace(/&(amp|lt|gt);/g,(_,name)=>({amp:'&',lt:'<',gt:'>'})[name]);
const trimNewlines = text => text.replace(/^\n+|\n+$/g,'');

function linkContext(){
  const urls=[];
  return {
    link(url,label=''){
      if(!url)return label;
      if(!label||label===url||url===`mailto:${label}`)return label||url;
      let index=urls.indexOf(url);
      if(index<0){index=urls.length;urls.push(url);}
      return `${label}[${index+1}]`;
    },
    finish(text){
      return text+(urls.length?'\n\n链接：\n'+urls.map((url,i)=>`[${i+1}] ${url}`).join('\n'):'');
    }
  };
}

function mrkdwn(text,links){
  // Protect code, links and bare URLs from emphasis removal (e.g. underscores
  // in a URL or multiplication in code). Decode only Slack's three entities.
  const tokens=/(```[\s\S]*?(?:```|$)|`[^`\n]+`|<(?:https?:\/\/|mailto:)[^>]+>|https?:\/\/[^\s<>]+)/g;
  return text.split(tokens).map((part,i)=>{
    if(i%2){
      if(part.startsWith('```'))return decode(part.replace(/^```\n?|```$/g,''));
      if(part.startsWith('`'))return decode(part.slice(1,-1));
      if(part.startsWith('<')){
        const [url,...label]=part.slice(1,-1).split('|');
        return links.link(decode(url),decode(label.join('|')));
      }
      return decode(part);
    }
    return decode(part
      .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g,(_,id,name)=>'@'+(name||id))
      .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g,(_,id,name)=>'#'+(name||id))
      .replace(/<!(here|channel|everyone)>/g,'@$1')
      .replace(/(?<![A-Za-z0-9])([*_~])(?=\S)([^\n]*?\S)\1(?![A-Za-z0-9])/g,'$2'));
  }).join('');
}

function inline(elements,links){
  if(!Array.isArray(elements))return null;
  const parts=elements.map(e=>{
    switch(e?.type){
      case 'text': return typeof e.text==='string'?e.text:null;
      case 'link': return typeof e.url==='string'?links.link(e.url,e.text):null;
      case 'emoji': {
        const points=typeof e.unicode==='string'?e.unicode.split('-').map(p=>parseInt(p,16)):[];
        return points.length&&points.every(p=>Number.isInteger(p)&&p>=0&&p<=0x10ffff)
          ?String.fromCodePoint(...points):e.name?`:${e.name}:`:null;
      }
      case 'user': return e.user_id?'@'+e.user_id:null;
      case 'channel': return e.channel_id?'#'+e.channel_id:null;
      case 'usergroup': return e.usergroup_id?'@'+e.usergroup_id:null;
      case 'broadcast': return e.range?'@'+e.range:null;
      case 'date': return typeof e.fallback==='string'?links.link(e.url,e.fallback):null;
      default: return null;
    }
  });
  return parts.includes(null)?null:parts.join('');
}

function richElement(element,links){
  switch(element?.type){
    case 'rich_text_section':
    case 'rich_text_preformatted': return inline(element.elements,links);
    case 'rich_text_quote': {
      const text=inline(element.elements,links);
      return text===null?null:text.split('\n').map(line=>'│ '+line).join('\n');
    }
    case 'rich_text_list': {
      if(!Array.isArray(element.elements)||!['bullet','ordered'].includes(element.style))return null;
      const indent='  '.repeat(Math.min(8,Math.max(0,Math.trunc(element.indent)||0)));
      const offset=Number.isSafeInteger(element.offset)?element.offset:0;
      const items=element.elements.map((item,i)=>{
        if(item?.type!=='rich_text_section')return null;
        const text=inline(item.elements,links);
        const prefix=element.style==='ordered'?`${offset+i+1}. `:'• ';
        return text===null?null:indent+prefix+text.replace(/\n/g,'\n'+indent+' '.repeat(prefix.length));
      });
      return items.includes(null)?null:items.join('\n');
    }
    default: return null;
  }
}

function richText(block,links){
  if(!Array.isArray(block.elements))return null;
  let result='',previous;
  for(const element of block.elements){
    const text=richElement(element,links);
    if(text===null)return null; // Use the full fallback rather than drop unknown content.
    if(!text.trim())continue;
    const gap=previous==='rich_text_list'&&element.type==='rich_text_list'?'\n':'\n\n';
    result+=(result?gap:'')+trimNewlines(text);
    previous=element.type;
  }
  return result;
}

function textObject(object,links){
  if(typeof object?.text!=='string')return null;
  return object.type==='plain_text'?object.text:object.type==='mrkdwn'?mrkdwn(object.text,links):null;
}

function blocksText(blocks,links){
  if(!Array.isArray(blocks)||!blocks.length)return null;
  const parts=blocks.map(block=>{
    switch(block?.type){
      case 'rich_text': return richText(block,links);
      case 'header': return textObject(block.text,links);
      case 'section': {
        const values=[...(block.text?[textObject(block.text,links)]:[]),
          ...(block.fields||[]).map(field=>textObject(field,links))];
        return values.includes(null)?null:values.join('\n');
      }
      case 'context': {
        const values=(block.elements||[]).map(e=>e.type==='image'?e.alt_text||'':textObject(e,links));
        return values.includes(null)?null:values.join('\n');
      }
      case 'divider': return '────────';
      case 'image': return block.alt_text||'';
      default: return null;
    }
  });
  return parts.includes(null)?null:parts.filter(p=>p.trim()).map(trimNewlines).join('\n\n');
}

export function slackMessageText(message){
  let links=linkContext();
  const rich=blocksText(message.blocks,links);
  if(rich?.trim())return links.finish(rich);
  // Discard references accumulated by an unsupported/empty block render.
  links=linkContext();
  const text=typeof message.text==='string'?message.text:'';
  return links.finish(mrkdwn(text,links));
}
