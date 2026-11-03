import { createHash, timingSafeEqual } from 'node:crypto';
export const maxDuration = 60;
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];
  const expected=Buffer.from(process.env.BROWSER_WORKER_KEY_SHA256||'','hex');
  const actual=createHash('sha256').update(token||'').digest();
  if(process.env.BROWSER_WORKER_ENABLED!=='true')return res.status(404).end();
  if(!token||expected.length!==32||!timingSafeEqual(expected,actual))return res.status(401).end();
  if(req.method!=='GET')return res.status(405).end();
  const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),50000);
  res.on('close',()=>stop.abort());
  try {
    const url=new URL('/subscribe/line-expenses:browser:v1:wake',process.env.UPSTASH_REDIS_REST_URL);
    if(url.protocol!=='https:'||!url.hostname.endsWith('.upstash.io'))throw Error('Invalid event source');
    const upstream=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,Accept:'text/event-stream'},signal:stop.signal});
    if(!upstream.ok)throw Error('Event source unavailable');
    res.setHeader('Content-Type','text/event-stream');res.flushHeaders?.();
    // Subscribe acknowledgements wake the local worker too: no reconnect race.
    for await(const chunk of upstream.body){if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));}
  } catch {if(!res.headersSent)res.status(503);}
  finally {clearTimeout(timer);res.end();}
}
