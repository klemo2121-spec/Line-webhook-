import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import handler from '../api/browser-events.js';
test('event stream refuses disabled feature, wrong key and wrong HTTP method before contacting Redis',async()=>{
  const original={enabled:process.env.BROWSER_WORKER_ENABLED,key:process.env.BROWSER_WORKER_KEY_SHA256};
  const token='a'.repeat(43),res=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},end(){return this;}});
  try{
    delete process.env.BROWSER_WORKER_ENABLED;let r=res();await handler({method:'GET',headers:{}},r);assert.equal(r.code,404);
    process.env.BROWSER_WORKER_ENABLED='true';process.env.BROWSER_WORKER_KEY_SHA256=createHash('sha256').update(token).digest('hex');
    r=res();await handler({method:'GET',headers:{authorization:'Bearer '+'b'.repeat(43)}},r);assert.equal(r.code,401);
    r=res();await handler({method:'POST',headers:{authorization:'Bearer '+token}},r);assert.equal(r.code,405);
  }finally{for(const [key,value] of [['BROWSER_WORKER_ENABLED',original.enabled],['BROWSER_WORKER_KEY_SHA256',original.key]])if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
