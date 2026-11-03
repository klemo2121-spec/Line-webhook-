import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { parseMonthInstruction } from '../lib/months.js';
import { parseLineRequest, validateReceipt } from '../lib/receipts.js';
import { createMonthlyHandler, monthlyPayload, receiptErrors, parseBucket } from '../lib/monthly-expenses.js';

test('online shopping accepts the owner spelling with spaces and hyphens',()=>{
  for(const text of ['קניות און ליין','קניות אונליין','קניות און-ליין','קניות און־ליין'])assert.equal(parseBucket(text),'online');
});

const category = { systemCode: 1038, categoryId: 100, nameLocal: 'ทั่วไป', nameForeign: 'General', creditId: 101, creditCode: '21399', creditCategory: 2, creditNameLocal: 'เจ้าหนี้', creditNameForeign: 'Payables', debitId: 102, debitCode: '59910', debitCategory: 5, debitNameLocal: 'ค่าใช้จ่าย', debitNameForeign: 'Expenses' };
const receipt = { kind: 'receipt', readable: true, vendor: 'Supplier', invoiceNumber: 'R1', date: '2026-11-02', currency: 'THB', total: 107, net: 100, vat: 7, taxTreatment: 'standard7', withholding: 0, expenseOnly: true, description: 'Courier', category: 'General', bucket: 'petty_cash', uncertainties: [] };
function setup() {
  Object.assign(process.env, { RECEIPTS_ENABLED: 'true', FLOWACCOUNT_WRITE_ENABLED: 'true', EXPENSE_GROUP_IDS: 'G1', EXPENSE_USER_IDS: 'U1', UPSTASH_REDIS_REST_URL: 'https://private.example', UPSTASH_REDIS_REST_TOKEN: 'test', FLOWACCOUNT_COMPANY_ID: '7', FLOWACCOUNT_EXPENSE_CATEGORIES_JSON: JSON.stringify({ General: category }), FLOWACCOUNT_RECORDING_POLICY: 'gross_no_input_vat', FLOWACCOUNT_MONTHLY_DOCUMENTS_JSON: '{}' });
  const kv = new Map(), hashes = new Map(), docs = new Map(), calls = [], replies = [];
  let currentReceipt = structuredClone(receipt), imageId = 0, nextId = 1, failWrite = false, failAttach = false;
  async function redis([cmd,...args]) {
    if (cmd === 'GET') return kv.get(args[0]) ?? null;
    if (cmd === 'SET') { if (args.includes('NX') && kv.has(args[0])) return null; kv.set(args[0],args[1]); return 'OK'; }
    if (cmd === 'DEL') { args.forEach(k=>kv.delete(k)); return 1; }
    if (cmd === 'HSET') { if (!hashes.has(args[0])) hashes.set(args[0],new Map()); hashes.get(args[0]).set(args[1],args[2]); return 1; }
    if (cmd === 'HVALS') return [...(hashes.get(args[0])?.values() || [])];
    if (cmd === 'EVAL') {
      const [script, count,...rest] = args, keys = rest.slice(0,Number(count)), value = rest[Number(count)];
      if (script.includes('EXISTS')) { if (keys.some(k=>kv.has(k))) return 0; keys.forEach(k=>kv.set(k,value)); return 1; }
      if (kv.get(keys[0]) === value) { kv.delete(keys[0]); return 1; } return 0;
    }
    throw new Error(`Unsupported ${cmd}`);
  }
  async function flow(path, options = {}) {
    calls.push([path,options]);
    if (path === '/company/info') return { data: { companyId: 7 } };
    if (path === '/expenses/categories/business') return { data: [category] };
    if (path.startsWith('/expenses?')) return { data: { list: [...docs.values()], count: docs.size } };
    if (path.includes('/attachment')) { if (failAttach) throw new Error('Attachment failed'); return { status: true }; }
    if (options.method === 'POST' || options.method === 'PUT') {
      if (failWrite) throw new Error('Timeout after send');
      const data = JSON.parse(options.body), id = options.method === 'POST' ? nextId++ : Number(path.split('/').pop());
      docs.set(id, { ...data, recordId: id, documentSerial: `EXP-${id}`, statusString: 'awaiting' });
      return { data: docs.get(id) };
    }
    return { data: docs.get(Number(path.split('/').pop())) };
  }
  const handle = createMonthlyHandler({ redis, flow, extract: async()=>structuredClone(currentReceipt), downloadLineImage: async()=>({ contentType: 'image/jpeg', base64: Buffer.from(`image-${++imageId}`).toString('base64') }), replyText: async(...args)=>replies.push(args), now: ()=>new Date('2026-11-02T12:00:00Z') });
  const image = id => ({ type: 'message', source: { groupId: 'G1', userId: 'U1' }, replyToken: 'token', message: { type: 'image', id, quoteToken: `quote-${id}` } });
  const text = (value, extra={}) => ({ ...image('text'), message: { type: 'text', text: value, ...extra } });
  return { handle, image, text, kv, docs, calls, replies, setReceipt:r=>currentReceipt=r, failWrite:v=>failWrite=v, failAttach:v=>failAttach=v };
}

test('Hebrew/English/Thai relative and explicit months use Bangkok, including year rollover',()=>{
  const now = new Date('2026-11-02T12:00:00Z');
  for (const t of ['צרף את זה לחודש שעבר','last month','เดือนที่แล้ว']) assert.equal(parseMonthInstruction(t,now),'2026-10');
  assert.equal(parseMonthInstruction('צרף לאוקטובר 2025',now),'2025-10');
  assert.equal(parseMonthInstruction('לחודש 10/2026',now),'2026-10');
  assert.equal(parseMonthInstruction('לחודש 2026-10',now),'2026-10');
  assert.equal(parseMonthInstruction('לדצמבר',now),'2025-12');
  assert.equal(parseMonthInstruction('last month',new Date('2026-01-01T00:00:00Z')),'2025-12');
  assert.equal(parseMonthInstruction('החודש',new Date('2026-10-31T18:00:00Z')),'2026-11');
});
test('bad OCR dates, currency, total, WHT and inventory never become expenses',()=>{
  for (const patch of [{ date:'2026-02-30' },{ date:'invalid' },{ currency:'USD' },{ total:-3 },{ total:'107' },{ withholding:3 },{ expenseOnly:false },{ vendor:42 }]) assert.ok(receiptErrors({...receipt,...patch},{General:category}).length);
  assert.deepEqual(validateReceipt(receipt,{General:category}),[]);
});
test('monthly payload uses full gross amount under explicit company policy',()=>{
  const p=monthlyPayload('2026-10','petty_cash',[{id:'a'.repeat(24),receipt}],{General:category},'gross_no_input_vat');
  assert.equal(p.grandTotal,107); assert.equal(p.isVat,false); assert.equal(p.expenseCategoryView,3); assert.equal(p.publishedOn,'2026-10-31');
  assert.match(p.items[0].description,/2026-11-02/);
});
test('signed raw webhook is accepted, forged signature rejected',async()=>{
  setup(); process.env.LINE_CHANNEL_SECRET='test-secret'; const raw=JSON.stringify({events:[]});
  const req=Readable.from([Buffer.from(raw)]); req.headers={'x-line-signature':createHmac('sha256','test-secret').update(raw).digest('base64')};
  assert.deepEqual(await parseLineRequest(req),{events:[]});
  const bad=Readable.from([Buffer.from(raw)]); bad.headers={'x-line-signature':'forged'};
  await assert.rejects(parseLineRequest(bad),/signature/);
});
test('two receipts append to one monthly draft, attach images, acknowledge quoted image only on success',async()=>{
  const s=setup(); await s.handle(s.image('1')); s.setReceipt({...receipt,invoiceNumber:'R2',total:50}); await s.handle(s.image('2'));
  assert.equal(s.docs.size,1); assert.equal(s.docs.get(1).items.length,2); assert.equal(s.docs.get(1).grandTotal,157);
  assert.equal(s.calls.filter(([p])=>p.endsWith('/attachment')).length,2);
  assert.equal(s.replies.at(-1)[1],'👍🏻'); assert.equal(s.replies.at(-1)[3],'quote-2');
});
test('pre-upload next-month instruction scopes to sender and is consumed once',async()=>{
  const s=setup(); await s.handle(s.text('צרף את הקבלה הבאה לחודש שעבר')); await s.handle(s.image('1'));
  assert.equal(s.docs.get(1).publishedOn,'2026-10-31');
  s.setReceipt({...receipt,invoiceNumber:'R2'}); await s.handle(s.image('2')); assert.equal(s.docs.get(2).publishedOn,'2026-11-30');
});
test('after-upload instruction relocates sole bot receipt without duplicating or changing receipt date',async()=>{
  const s=setup(); await s.handle(s.image('1')); await s.handle(s.text('צרף את זה לחודש שעבר'));
  assert.equal(s.docs.size,1); assert.equal(s.docs.get(1).publishedOn,'2026-10-31'); assert.match(s.docs.get(1).items[0].description,/2026-11-02/);
  assert.equal(s.calls.filter(([p,o])=>p==='/expenses'&&o.method==='POST').length,1);
});
test('redelivery and rephotographed same receipt create no duplicate',async()=>{
  const s=setup(); await s.handle(s.image('1')); await s.handle(s.image('1')); await s.handle(s.image('2'));
  assert.equal(s.docs.get(1).items.length,1); assert.equal(s.calls.filter(([,o])=>o.method==='POST'&&o.headers?.['Content-Type']==='application/json').length,1);
});
test('paid monthly documents and manually edited drafts are never overwritten',async()=>{
  const s=setup(); await s.handle(s.image('1')); s.docs.get(1).statusString='paid'; s.setReceipt({...receipt,invoiceNumber:'R2'}); await s.handle(s.image('2'));
  assert.equal(s.docs.get(1).items.length,1); assert.match(s.replies.at(-1)[1],/approved\/paid/);
  const t=setup(); await t.handle(t.image('1')); t.docs.get(1).items[0].total=999; t.setReceipt({...receipt,invoiceNumber:'R2'}); await t.handle(t.image('2')); assert.match(t.replies.at(-1)[1],/changed outside/);
});
test('unknown writes hold permanent lock and are not retried',async()=>{
  const s=setup(); s.failWrite(true); await s.handle(s.image('1')); const before=s.calls.length;
  s.failWrite(false); await s.handle(s.text('expense sync'));
  assert.ok(s.kv.has('line-expenses:v2:writer-lock')); assert.equal(s.docs.size,0);
  assert.equal(s.calls.slice(before).filter(([,o])=>o.method==='POST').length,0);
  assert.notEqual(s.replies.at(-1)[1],'👍🏻');
});
test('attachment failure yields no success emoji; retry only uploads attachment',async()=>{
  const s=setup(); s.failAttach(true); await s.handle(s.image('1')); assert.notEqual(s.replies.at(-1)[1],'👍🏻');
  const writes=s.calls.filter(([,o])=>o.headers?.['Content-Type']==='application/json').length;
  s.failAttach(false); await s.handle(s.text('expense sync')); assert.equal(s.replies.at(-1)[1],'👍🏻');
  assert.equal(s.calls.filter(([,o])=>o.headers?.['Content-Type']==='application/json').length,writes);
});
test('bank slip only attaches; it never creates an expense or payment',async()=>{
  const s=setup(); await s.handle(s.image('1')); s.setReceipt({...receipt,kind:'payment_slip',invoiceNumber:'SLIP1'}); await s.handle(s.image('2'));
  assert.equal(s.docs.size,1); assert.equal(s.docs.get(1).items.length,1); assert.equal(s.replies.at(-1)[1],'👍🏻');
  assert.equal(s.calls.filter(([p])=>p.includes('/payment')).length,0);
});
test('cashier report passes through and unrelated group/user cannot write expenses',async()=>{
  const s=setup(); s.setReceipt({...receipt,kind:'cashier_report'}); assert.equal(await s.handle(s.image('1')),false);
  const event=s.image('2'); event.source.groupId='OTHER'; assert.equal(await s.handle(event),false);
  const denied=s.image('3'); denied.source.userId='OTHER'; await s.handle(denied); assert.equal(s.docs.size,0);
});
test('reviewed missing monthly group can be supplied in a later message',async()=>{
  const s=setup(); s.setReceipt({...receipt,bucket:null}); await s.handle(s.image('1')); assert.equal(s.docs.size,0);
  await s.handle(s.text('קופה קטנה')); assert.equal(s.docs.size,1); assert.equal(s.replies.at(-1)[1],'👍🏻');
});
test('preview mode creates no external expense',async()=>{
  const s=setup(); process.env.FLOWACCOUNT_WRITE_ENABLED='false'; await s.handle(s.image('1')); assert.equal(s.docs.size,0); assert.equal(s.calls.length,0); assert.match(s.replies.at(-1)[1],/בדיקה/);
});
test('a correction quoting an older image targets it rather than the latest upload',async()=>{
  const s=setup(); await s.handle(s.image('1')); s.setReceipt({...receipt,invoiceNumber:'R2'}); await s.handle(s.image('2'));
  await s.handle(s.text('צרף את זה לחודש שעבר',{quotedMessageId:'1'}));
  assert.equal(s.docs.size,2); assert.equal(s.docs.get(1).grandTotal,107); assert.equal(s.docs.get(2).grandTotal,107);
  assert.equal(s.replies.at(-1)[3],'quote-1');
});
test('wrong company aborts before financial writes',async()=>{
  const s=setup(); process.env.FLOWACCOUNT_COMPANY_ID='OTHER'; await s.handle(s.image('1'));
  assert.equal(s.docs.size,0); assert.match(s.replies.at(-1)[1],/company does not match/);
});
test('missing quote token never emits an unlinked success thumb',async()=>{
  const s=setup(); const event=s.image('1'); delete event.message.quoteToken; await s.handle(event);
  assert.equal(s.docs.size,1); assert.notEqual(s.replies.at(-1)[1],'👍🏻');
});
test('other sender cannot retarget a quoted receipt',async()=>{
  const s=setup(); await s.handle(s.image('1')); process.env.EXPENSE_USER_IDS='U1,U2';
  const event=s.text('צרף את זה לחודש שעבר',{quotedMessageId:'1'}); event.source.userId='U2'; await s.handle(event);
  assert.equal(s.docs.get(1).publishedOn,'2026-11-30'); assert.match(s.replies.at(-1)[1],/בעצמך/);
});
test('disabled feature passes all events through without API calls',async()=>{
  const s=setup(); process.env.RECEIPTS_ENABLED='false'; assert.equal(await s.handle(s.image('1')),false); assert.equal(s.calls.length,0);
});

