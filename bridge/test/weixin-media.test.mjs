import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptAesEcb,decryptAesEcb,parseAesKey,downloadInboundMedia,uploadOutboundMedia } from '../src/weixin-media.mjs';
const KEY=Buffer.from('00112233445566778899aabbccddeeff','hex');
test('AES-128-ECB roundtrip and both aes_key encodings parse to the same key',()=>{
  const plain=Buffer.from('native file bytes');
  assert.deepEqual(decryptAesEcb(encryptAesEcb(plain,KEY),KEY),plain);
  assert.deepEqual(parseAesKey(KEY.toString('base64')),KEY);
  assert.deepEqual(parseAesKey(Buffer.from(KEY.toString('hex')).toString('base64')),KEY);
});
test('inbound media downloads and decrypts via constructed CDN URL',async()=>{
  const item={kind:'file',item:{file_name:'a.bin',media:{encrypt_query_param:'P A',
    aes_key:Buffer.from(KEY.toString('hex')).toString('base64')}}};
  const fetcher=async(url)=>{assert.match(String(url),/novac2c\.cdn\.weixin\.qq\.com\/c2c\/download\?encrypted_query_param=P%20A/);
    return new Response(encryptAesEcb(Buffer.from('data'),KEY));};
  assert.equal((await downloadInboundMedia(item,fetcher)).toString(),'data');
});
test('outbound upload requests a URL, posts decryptable ciphertext and builds a file item',async()=>{
  let posted;
  const client={getUploadUrl:async body=>{assert.equal(body.media_type,3);assert.equal(body.rawsize,4);return{upload_param:'UP'};}};
  const fetcher=async(url,opts)=>{posted=opts.body;return new Response('',{headers:{'x-encrypted-param':'DOWN'}});};
  const item=await uploadOutboundMedia(client,{bytes:Buffer.from('data'),kind:'file',name:'a.bin',toUserId:'W'},fetcher);
  assert.equal(item.type,4);assert.equal(item.file_item.file_name,'a.bin');assert.equal(item.file_item.len,'4');
  assert.equal(item.file_item.media.encrypt_query_param,'DOWN');
  assert.equal(decryptAesEcb(posted,parseAesKey(item.file_item.media.aes_key)).toString(),'data');
});
