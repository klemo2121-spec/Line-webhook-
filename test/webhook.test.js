import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import handler from '../api/webhook.js';
function response() { return { statusCode: null, value: null, status(code) { this.statusCode=code; return this; }, json(value) { this.value=value; return this; }, send(value) { this.value=value; return this; } }; }
test('disabled receipt feature preserves valid empty webhook response',async()=>{
  process.env.RECEIPTS_ENABLED='false'; const req=Readable.from([Buffer.from('{"events":[]}')]); req.method='POST'; req.headers={};
  const res=response(); await handler(req,res); assert.equal(res.statusCode,200); assert.deepEqual(res.value,{ok:true});
});
test('enabled receipt feature rejects unsigned events before any processing',async()=>{
  process.env.RECEIPTS_ENABLED='true'; process.env.LINE_CHANNEL_SECRET='test'; const req=Readable.from([Buffer.from('{"events":[]}')]); req.method='POST'; req.headers={};
  const res=response(); await handler(req,res); assert.equal(res.statusCode,401);
});
test('health check remains available without credentials',async()=>{
  const res=response(); await handler({method:'GET',query:{},headers:{}},res); assert.equal(res.statusCode,200); assert.equal(res.value,'OK');
});
test('missing cron secret fails closed rather than treating empty key as authorized',async()=>{
  process.env.LEGACY_BOTS_ENABLED='true';
  const res=response(); await handler({method:'GET',query:{action:'start'},headers:{}},res); assert.equal(res.statusCode,401);
  delete process.env.LEGACY_BOTS_ENABLED;
});

test('legacy bots remain off when a new deployment has no legacy flag',async()=>{
  delete process.env.LEGACY_BOTS_ENABLED;
  const res=response();await handler({method:'GET',query:{action:'start'},headers:{}},res);assert.equal(res.value.sent,false);
});
test('expense-only mode keeps old text bots and scheduled reminders disabled',async()=>{
  process.env.LEGACY_BOTS_ENABLED='false'; process.env.RECEIPTS_ENABLED='false';
  const req=Readable.from([Buffer.from(JSON.stringify({events:[{type:'message',source:{groupId:'group'},message:{type:'text',text:'test'},replyToken:'reply'}]}))]); req.method='POST'; req.headers={};
  const original=globalThis.fetch; globalThis.fetch=async()=>{throw new Error('Old bot unexpectedly called a provider');};
  try { const res=response(); await handler(req,res); assert.deepEqual(res.value,{ok:true}); const cron=response();await handler({method:'GET',query:{action:'start'},headers:{}},cron);assert.equal(cron.value.sent,false); } finally { globalThis.fetch=original;delete process.env.LEGACY_BOTS_ENABLED; }
});
