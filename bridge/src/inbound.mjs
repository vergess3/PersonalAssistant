// Parse one inbound Weixin message from the bound peer into raw text + media refs.
// Keep reference metadata separate from the new message's own text/media.
import { exactId } from './references.mjs';
const MEDIA={2:['image','image_item'],3:['voice','voice_item'],4:['file','file_item'],5:['video','video_item']};
export function parseInbound(m,c,activeFrom,now) {
  if(m.from_user_id!==c.weixinUserId||m.to_user_id!==c.weixinBotId||m.group_id||
    m.message_type!==1||m.message_state!==2||!Number.isSafeInteger(m.create_time_ms)||
    m.create_time_ms<activeFrom||m.create_time_ms>now+60000||!m.context_token||
    !Array.isArray(m.item_list)||!m.item_list.length) return null;
  const id=typeof m.message_id==='string'?m.message_id:Number.isSafeInteger(m.message_id)?String(m.message_id):null;
  if(!id) return null;
  const texts=[],media=[];
  for(const x of m.item_list){
    if(x.type===1&&typeof x.text_item?.text==='string')texts.push(x.text_item.text);
    else if(MEDIA[x.type]){
      const [kind,key]=MEDIA[x.type],item=x[key];
      // WeChat voice items carry their own transcript. It is the spoken
      // message's text form, so a voice message is complete on arrival
      // rather than being staged like a document/image attachment.
      if(kind==='voice'&&typeof item?.text==='string')texts.push(item.text);
      if(item?.media&&(item.media.encrypt_query_param||item.media.full_url))
        media.push({kind,item:structuredClone(item)});
    }
  }
  const text=texts.join('\n');
  if(!text.trim()&&!media.length) return null;
  const quote=m.item_list.find(x=>x.ref_msg)?.ref_msg;
  const weixinIds=[...new Set([id,...m.item_list.map(x=>exactId(x.msg_id)).filter(Boolean)])];
  return {id,text,media,weixinIds,...(quote?{quote:structuredClone(quote)}:{}),
    context:m.context_token,created:m.create_time_ms};
}
