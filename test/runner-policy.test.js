import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAwaiting,assertCompanyUrl,receiptPlan,wakeFrames,attachmentReceipt} from '../lib/runner-policy.js';
const current={companyId:'7',job:{override:{month:'2026-10'}}};
const receipt={kind:'receipt',readable:true,currency:'THB',total:31,date:'2026-11-02',vendor:'KEX',expenseOnly:true,category:'Messenger/Postage',bucket:'petty_cash',withholding:0,uncertainties:[]};
test('arrival month override wins over printed date and month end is deterministic',()=>{const p=receiptPlan(receipt,current);assert.equal(p.month,'2026-10');assert.equal(p.date,'2026-10-31');assert.equal(p.receipt.date,'2026-11-02');});
test('unreadable, mixed purpose, unknown category and invalid dates cannot plan',()=>{for(const patch of [{uncertainties:['unclear']},{category:'unknown'},{expenseOnly:false},{date:'2026-02-30'},{currency:'USD'}])assert.throws(()=>receiptPlan({...receipt,...patch},current));});
test('paid/approved/unknown targets and foreign company/browser origins fail closed',()=>{for(const text of ['ชำระเงินแล้ว','paid','approved','unknown'])assert.throws(()=>assertAwaiting(text));assertAwaiting('รอดำเนินการ');assert.throws(()=>assertCompanyUrl('https://evil.test/N270466/business/expenses','N270466'));assert.throws(()=>assertCompanyUrl('https://advance.flowaccount.com/N2/business/expenses','N270466'));});
test('SSE fragments preserve wakes and ignore unrelated frames',()=>{const a=wakeFrames('','data: sub');assert.equal(a.wake,false);const b=wakeFrames(a.tail,'scribe,channel,1\n\n');assert.equal(b.wake,true);assert.equal(wakeFrames('','event: ping\n\n').wake,false);});
test('owner group permits attachment-only bank proof, never dismissing amount or date uncertainty',()=>{
  const c={companyId:'7',job:{override:{bucket:'online'}}};
  const slip={...receipt,kind:'payment_slip',expenseOnly:false,category:'unknown',uncertainties:['unknown_purpose','unknown_category']};
  const normalized=attachmentReceipt(slip,c.job);assert.equal(receiptPlan(normalized,c).bucket,'online');assert.equal(normalized.expenseOnly,false);
  for(const code of ['unknown_amount','unknown_date','unclear_image'])assert.throws(()=>receiptPlan(attachmentReceipt({...slip,uncertainties:[code]},c.job),c));
  assert.throws(()=>receiptPlan(attachmentReceipt(slip,{override:{}}),{companyId:'7',job:{override:{}}}));
});
