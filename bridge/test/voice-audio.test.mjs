import test from 'node:test';
import assert from 'node:assert/strict';
import {encode,isWav,getWavFileInfo} from 'silk-wasm';
import {pcmToWav,prepareVoiceUpload} from '../src/voice-audio.mjs';

const pcm=Buffer.alloc(16000*2);
for(let i=0;i<16000;i++)pcm.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/16000)*12000),i*2);
const silk=Buffer.from((await encode(pcm,16000)).data);

test('SILK mislabeled as Speex becomes a playable WAV with preserved duration and signal',async()=>{
  const original=Buffer.from(silk),result=await prepareVoiceUpload(silk,{encode_type:4,sample_rate:16000},'123');
  assert.equal(result.filename,'weixin-voice-123.wav');assert.equal(result.contentType,'audio/wav');
  assert.deepEqual(silk,original);assert.ok(isWav(result.bytes));
  const {fmt,chunkInfo}=getWavFileInfo(result.bytes),data=chunkInfo.find(c=>c.chunkId==='data');
  assert.equal(fmt.formatCode,1);assert.equal(fmt.sampleRate,24000);assert.equal(fmt.numberOfChannels,1);
  assert.equal(fmt.bitsPerSample,16);assert.equal(result.bytes.readUInt32LE(4),result.bytes.length-8);
  assert.ok(Math.abs(data.dataLength/fmt.bytesPerSec-1)<0.1);
  let energy=0;for(let i=44;i<result.bytes.length;i+=2)energy+=result.bytes.readInt16LE(i)**2;
  assert.ok(Math.sqrt(energy/((result.bytes.length-44)/2))>1000);
});

test('existing WAV and declared raw PCM use real audio bytes and valid containers',async()=>{
  const wav=pcmToWav(pcm,16000),r=await prepareVoiceUpload(wav,{},'sample');
  assert.deepEqual(r.bytes,wav);
  const raw=await prepareVoiceUpload(pcm,{encode_type:1,bits_per_sample:16,sample_rate:16000},'sample');
  assert.deepEqual(raw.bytes,wav);assert.equal(raw.contentType,'audio/wav');
});

test('corrupt, truncated and unknown voice data cannot masquerade as WAV',async()=>{
  for(const bytes of [Buffer.from('not audio'),Buffer.from('#!SILK_V3'),silk.subarray(0,silk.length-1),
    Buffer.from('RIFFinvalid'),Buffer.alloc(0)])
    await assert.rejects(prepareVoiceUpload(bytes,{encode_type:4},'bad'),/voice_(audio_invalid|format_unsupported|transcode_failed)/);
  assert.throws(()=>pcmToWav(Buffer.from([1]),16000),/voice_audio_invalid/);
  assert.throws(()=>pcmToWav(pcm,12345),/voice_audio_invalid/);
});
