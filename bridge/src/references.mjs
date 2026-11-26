// Stored inside the existing encrypted queue. Never infer a thread from a
// substring: duplicate text and unresolved references must not cross topics.
export const validTs = ts => typeof ts==='string' && /^\d+\.\d+$/.test(ts);
export const exactId = id => typeof id==='string'&&id ? id : Number.isSafeInteger(id)?String(id):undefined;
export const itemText = item => item?.text_item?.text || item?.voice_item?.text || '';
const normalize = text => typeof text==='string'?text.replace(/\r\n/g,'\n').trim():'';
export const topicOf = ref => ref?.threadTs || ref?.slackTs || ref?.key;
export function putReference(state,record){
  state.references ||= [];
  const old=state.references.find(r=>r.key===record.key);
  if(old)Object.assign(old,record);else state.references.push(record);
  return old||record;
}
export function resolveReference(state,quote){
  if(!quote)return;
  const refs=state.references||[],id=exactId(quote.svr_id)||exactId(quote.message_item?.msg_id);
  if(id){
    const matches=refs.filter(r=>r.weixinIds?.includes(id));
    if(matches.length===1)return matches[0];
    if(matches.length>1)return;
  }
  const body=normalize(itemText(quote.message_item));
  if(!body)return;
  const matches=refs.filter(r=>normalize(r.text)===body);
  if(matches.length===1)return matches[0];
}
export function nativeQuote(ref){
  if(!ref)return;
  const id=ref.weixinIds?.[0],text=ref.text;
  if(!id&&!text)return;
  return {...(id?{svr_id:id}:{}),title:ref.role==='assistant'?'hilly':'你',
    ...(text?{message_item:{type:1,text_item:{text}}}:{})};
}
