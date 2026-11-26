// Unauthenticated public transport probes only. No conversation data.
for(const url of ['https://slack.com/api/api.test','https://ilinkai.weixin.qq.com','https://raw.githubusercontent.com/Tencent/openclaw-weixin/main/package.json']) {
  try {
    const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});
    console.log(JSON.stringify({host:new URL(url).hostname,httpStatus:r.status}));
  } catch(e) { console.log(JSON.stringify({host:new URL(url).hostname,error:e.cause?.code||e.name})); }
}

