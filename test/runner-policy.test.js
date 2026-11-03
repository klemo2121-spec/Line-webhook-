import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAwaiting,assertCompanyUrl,receiptPlan,wakeFrames,attachmentReceipt} from '../lib/runner-policy.js';
import {normalizedReceipt} from '../lib/live-receipt-engine.mjs';
const current={companyId:'7',job:{override:{month:'2026-10'}}};
const receipt={kind:'receipt',readable:true,currency:'THB',total:31,date:'2026-11-02',vendor:'KEX',expenseOnly:true,category:'Messenger/Postage',bucket:'petty_cash',withholding:0,uncertainties:[]};
test('arrival month override wins over printed date and month end is deterministic',()=>{const p=receiptPlan(receipt,current);assert.equal(p.month,'2026-10');assert.equal(p.date,'2026-10-31');assert.equal(p.receipt.date,'2026-11-02');});
test('unreadable, mixed purpose, unknown category and invalid dates cannot plan',()=>{for(const patch of [{uncertainties:['unclear']},{category:'unknown'},{expenseOnly:false},{date:'2026-02-30'},{currency:'USD'}])assert.throws(()=>receiptPlan({...receipt,...patch},current));});
test('paid/approved/unknown targets and foreign company/browser origins fail closed',()=>{for(const text of ['ชำระเงินแล้ว','paid','approved','unknown'])assert.throws(()=>assertAwaiting(text));assertAwaiting('รอดำเนินการ');assert.throws(()=>assertCompanyUrl('https://evil.test/N270466/business/expenses','N270466'));assert.throws(()=>assertCompanyUrl('https://advance.flowaccount.com/N2/business/expenses','N270466'));});
test('SSE fragments preserve wakes and ignore unrelated frames',()=>{const a=wakeFrames('','data: sub');assert.equal(a.wake,false);const b=wakeFrames(a.tail,'scribe,channel,1\n\n');assert.equal(b.wake,true);assert.equal(wakeFrames('','event: ping\n\n').wake,false);});
test('owner group permits attachment-only bank proof, never dismissing amount or date uncertainty',()=>{
  const c={companyId:'7',job:{override:{bucket:'online'},attachmentOnly:true}};
  const slip={...receipt,kind:'payment_slip',expenseOnly:false,category:'unknown',uncertainties:['unknown_purpose','unknown_category']};
  const normalized=attachmentReceipt({...slip,currency:'Baht'},c.job);assert.equal(receiptPlan(normalized,c).bucket,'online');assert.equal(normalized.expenseOnly,false);assert.equal(normalized.currency,'THB');
  for(const code of ['unknown_amount','unknown_date','unclear_image'])assert.throws(()=>receiptPlan(attachmentReceipt({...slip,uncertainties:[code]},c.job),c));
  assert.throws(()=>receiptPlan(attachmentReceipt(slip,{override:{}}),{companyId:'7',job:{override:{}}}));
});

test('explicit owner expense purpose records a slip amount as an unpaid expense without inventing a tax invoice',()=>{
  const job={override:{bucket:'online'},confirmedExpense:{bucket:'online',purpose:'online business purchases'}};
  const slip={...receipt,kind:'payment_slip',expenseOnly:false,category:'unknown',currency:'Baht',uncertainties:['unknown_purpose','unknown_category']};
  const r=attachmentReceipt(slip,job),p=receiptPlan(r,{companyId:'7',job});
  assert.equal(r.kind,'receipt');assert.equal(r.sourceKind,'payment_slip');assert.equal(r.ownerConfirmedExpense,true);
  assert.equal(r.category,'General expenses');assert.equal(r.total,31);assert.equal(p.paid,0);assert.equal(p.status,'awaiting');
  assert.throws(()=>receiptPlan(attachmentReceipt({...slip,uncertainties:['inventory_or_asset']},job),{companyId:'7',job}));
  assert.equal(attachmentReceipt(slip,{override:{bucket:'online'},confirmedExpense:{bucket:'electricity',purpose:'wrong bucket'}}).kind,'payment_slip');
  assert.throws(()=>receiptPlan(attachmentReceipt(slip,{override:{bucket:'online'}}),{companyId:'7',job:{override:{bucket:'online'}}}));
});

test('attachment-only correction reuses the verified slip fields instead of charging AI or changing identity',async()=>{
  const prior={...receipt,kind:'payment_slip',category:'unknown',expenseOnly:false,invoiceNumber:'BANK-REF-1'};
  const job={override:{bucket:'online'},confirmedExpense:{bucket:'online',purpose:'online business purchases'},attachmentOnlyCompletion:{plan:{receipt:prior}}};
  const result=await normalizedReceipt({job});
  assert.equal(result.kind,'receipt');assert.equal(result.total,prior.total);assert.equal(result.vendor,prior.vendor);
  assert.equal(result.invoiceNumber,'BANK-REF-1');assert.equal(result.date,prior.date);
});
