import { createCipheriv,createDecipheriv,createHash,randomBytes } from 'node:crypto';
import {fetch} from './network.mjs';
// Weixin CDN media per Tencent openclaw-weixin protocol: AES-128-ECB/PKCS7,
// download via full_url or <cdn>/download?encrypted_query_param=..., upload via
// getuploadurl -> POST ciphertext -> x-encrypted-param response header.
export const CDN_BASE='https://novac2c.cdn.weixin.qq.com/c2c';
export const MAX_MEDIA_BYTES=100*1024*1024;
export const encryptAesEcb=(buf,key)=>{const c=createCipheriv('aes-128-ecb',key,null);return Buffer.concat([c.update(buf),c.final()]);};
export const decryptAesEcb=(buf,key)=>{const d=createDecipheriv('aes-128-ecb',key,null);return Buffer.concat([d.update(buf),d.final()]);};
export const aesEcbPaddedSize=n=>Math.ceil((n+1)/16)*16;
// aes_key is base64 of either the raw 16-byte key or its 32-char hex string.
export function parseAesKey(aesKeyBase64){
  const decoded=Buffer.from(aesKeyBase64,'base64');
  if(decoded.length===16)return decoded;
  if(decoded.length===32&&/^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii')))
    return Buffer.from(decoded.toString('ascii'),'hex');
  throw Error('invalid_weixin_aes_key');
}
function cdnUrl(media){
  if(media.full_url){
    const u=new URL(media.full_url);
    if(u.protocol!=='https:'||!(u.hostname.endsWith('.weixin.qq.com')||u.hostname.endsWith('.qq.com')))
      throw Error('unapproved_weixin_cdn_url');
    return u.toString();
  }
  return `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
}
async function fetchBytes(fetcher,url){
  let r;try{r=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(120000)});}
  catch{throw Error('transport_outcome_unknown');}
  if(!r.ok)throw Error('remote_http_error');
  const declared=Number(r.headers?.get?.('content-length'));
  if(declared>MAX_MEDIA_BYTES+1024*1024)throw Error('weixin_media_too_large');
  const buf=Buffer.from(await r.arrayBuffer());
  if(buf.length>MAX_MEDIA_BYTES+1024*1024)throw Error('weixin_media_too_large');
  return buf;
}
// Returns plaintext bytes for one inbound media item ({kind,item} from parseInbound).
export async function downloadInboundMedia({kind,item},fetcher=fetch){
  const media=item.media;
  const hexKey=kind==='image'&&typeof item.aeskey==='string'&&/^[0-9a-fA-F]{32}$/.test(item.aeskey)?item.aeskey:null;
  const encrypted=await fetchBytes(fetcher,cdnUrl(media));
  if(hexKey)return decryptAesEcb(encrypted,Buffer.from(hexKey,'hex'));
  if(media.aes_key)return decryptAesEcb(encrypted,parseAesKey(media.aes_key));
  if(kind==='image')return encrypted; // Unencrypted image bytes are used as-is upstream.
  throw Error('weixin_media_key_missing');
}
const UPLOAD_TYPE={image:1,video:2,file:3,voice:4};
// Uploads plaintext via client.getUploadUrl + CDN POST; returns the sendmessage item.
export async function uploadOutboundMedia(client,{bytes,kind,name,toUserId},fetcher=fetch){
  if(!bytes.length||bytes.length>MAX_MEDIA_BYTES)throw Error('weixin_media_too_large');
  const filekey=randomBytes(16).toString('hex'),aeskey=randomBytes(16);
  const resp=await client.getUploadUrl({filekey,media_type:UPLOAD_TYPE[kind],to_user_id:toUserId,
    rawsize:bytes.length,rawfilemd5:createHash('md5').update(bytes).digest('hex'),
    filesize:aesEcbPaddedSize(bytes.length),no_need_thumb:true,aeskey:aeskey.toString('hex')});
  const url=typeof resp.upload_full_url==='string'&&resp.upload_full_url.trim()?resp.upload_full_url.trim()
    :resp.upload_param?`${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(resp.upload_param)}&filekey=${encodeURIComponent(filekey)}`
    :null;
  if(!url)throw Error('weixin_upload_url_missing');
  let downloadParam,lastError;
  for(let attempt=0;attempt<3&&!downloadParam;attempt++){
    try{
      const r=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},
        body:encryptAesEcb(bytes,aeskey),redirect:'error',signal:AbortSignal.timeout(120000)});
      if(r.status>=400&&r.status<500)throw Error('weixin_cdn_upload_rejected');
      if(r.status!==200)throw Error('remote_http_error');
      downloadParam=r.headers?.get?.('x-encrypted-param');
      if(!downloadParam)throw Error('weixin_cdn_upload_incomplete');
    }catch(e){lastError=e;if(e.message==='weixin_cdn_upload_rejected')throw e;}
  }
  if(!downloadParam)throw lastError||Error('weixin_cdn_upload_incomplete');
  const media={encrypt_query_param:downloadParam,aes_key:Buffer.from(aeskey.toString('hex')).toString('base64'),encrypt_type:1};
  const ciphertextSize=aesEcbPaddedSize(bytes.length);
  if(kind==='image')return {type:2,image_item:{media,mid_size:ciphertextSize}};
  if(kind==='video')return {type:5,video_item:{media,video_size:ciphertextSize}};
  return {type:4,file_item:{media,file_name:name,len:String(bytes.length)}};
}
export function sniffExtension(buf){
  if(buf.length>=3&&buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff)return 'jpg';
  if(buf.length>=8&&buf.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'png';
  if(buf.length>=6&&buf.subarray(0,6).toString('ascii').startsWith('GIF8'))return 'gif';
  if(buf.length>=12&&buf.subarray(0,4).toString('ascii')==='RIFF'&&buf.subarray(8,12).toString('ascii')==='WEBP')return 'webp';
  if(buf.length>=4&&buf.subarray(0,4).toString('ascii')==='%PDF')return 'pdf';
  return 'bin';
}
export function inboundFileName({kind,item},bytes,id){
  if(kind==='file'&&typeof item.file_name==='string'&&item.file_name.trim())
    return item.file_name.replace(/[\\/:*?"<>|]/g,'_').slice(0,200);
  if(kind==='image')return `weixin-image-${id}.${sniffExtension(bytes)==='bin'?'jpg':sniffExtension(bytes)}`;
  if(kind==='video')return `weixin-video-${id}.mp4`;
  if(kind==='voice')return `weixin-voice-${id}.${({4:'spx',5:'amr',6:'silk',7:'mp3',8:'ogg'})[item.encode_type]||'silk'}`;
  return `weixin-file-${id}.${sniffExtension(bytes)}`;
}
export function outboundKind(mimetype){
  if(typeof mimetype!=='string')return 'file';
  if(mimetype.startsWith('image/'))return 'image';
  if(mimetype.startsWith('video/'))return 'video';
  return 'file'; // Audio and everything else travel as file attachments.
}
