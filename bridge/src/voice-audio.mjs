import { decode,isWav } from 'silk-wasm';

const SAMPLE_RATE=24000,MAX_BYTES=100*1024*1024;
const SILK_HEADER=Buffer.from('#!SILK_V3');

// Standard mono PCM WAV; all conversion stays in memory.
export function pcmToWav(pcm,sampleRate){
  if(!Buffer.isBuffer(pcm)||!pcm.length||pcm.length%2||
    ![8000,12000,16000,24000,32000,44100,48000].includes(sampleRate))
    throw Error('voice_audio_invalid');
  if(pcm.length>MAX_BYTES-44)throw Error('voice_audio_too_large');
  const out=Buffer.alloc(44+pcm.length);
  out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVE',8);
  out.write('fmt ',12);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);
  out.writeUInt16LE(1,22);out.writeUInt32LE(sampleRate,24);
  out.writeUInt32LE(sampleRate*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);
  out.write('data',36);out.writeUInt32LE(pcm.length,40);pcm.copy(out,44);
  return out;
}

function silkOffset(bytes){
  const offset=bytes[0]===2?1:0;
  return bytes.subarray(offset,offset+9).equals(SILK_HEADER)?offset+9:0;
}

function validateSilkPackets(bytes,offset){
  let packets=0;
  while(offset<bytes.length){
    if(offset+2>bytes.length)throw Error('voice_audio_invalid');
    const size=bytes.readInt16LE(offset);offset+=2;
    if(size===-1&&offset===bytes.length)break;
    if(size<0||offset+size>bytes.length)throw Error('voice_audio_invalid');
    offset+=size;packets++;
    if(packets>30000)throw Error('voice_audio_too_large');
  }
  if(!packets)throw Error('voice_audio_invalid');
}

export async function prepareVoiceUpload(input,item,id){
  if(!Buffer.isBuffer(input)||!input.length)throw Error('voice_audio_invalid');
  if(input.length>MAX_BYTES)throw Error('voice_audio_too_large');
  let bytes=input,extension,contentType;
  const offset=silkOffset(input);
  // The observed protocol says encode_type=4 (Speex) even though the actual
  // bytes have Tencent's SILK header. Trust the container, not that enum.
  if(offset){
    validateSilkPackets(input,offset);
    let decoded;
    try{decoded=await decode(input,SAMPLE_RATE);}catch{throw Error('voice_transcode_failed');}
    bytes=pcmToWav(Buffer.from(decoded.data),SAMPLE_RATE);
    extension='wav';contentType='audio/wav';
  }else if(input.subarray(0,4).toString('ascii')==='RIFF'){
    if(!isWav(input))throw Error('voice_audio_invalid');
    extension='wav';contentType='audio/wav';
  }else if(input.subarray(0,3).toString('ascii')==='ID3'||
    (input.length>=4&&input[0]===255&&(input[1]&0xe0)===0xe0&&item.encode_type===7)){
    extension='mp3';contentType='audio/mpeg';
  }else if(input.length>=27&&input.subarray(0,4).toString('ascii')==='OggS'){
    extension='ogg';contentType='audio/ogg';
  }else if(item.encode_type===1&&item.bits_per_sample===16){
    bytes=pcmToWav(input,item.sample_rate);extension='wav';contentType='audio/wav';
  }else{
    throw Error('voice_format_unsupported');
  }
  const safeId=String(id).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,100);
  return {bytes,filename:`weixin-voice-${safeId}.${extension}`,contentType};
}
