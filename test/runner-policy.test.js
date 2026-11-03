import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAwaiting,assertCompanyUrl,receiptPlan,wakeFrames} from '../lib/runner-policy.js';
const current={companyId:'7',job:{override:{month:'2026-10'}}};
const receipt={kind:'receipt',readable:true,currency:'THB',total:31,date:'2026-11-02',vendor:'KEX',expenseOnly:true,category:'Messenger/Postage',bucket:'petty_cash',withholding:0,uncertainties:[]};
test('arrival month override wins over printed date and month end is deterministic',()=>{const p=receiptPlan(receipt,current);assert.equal(p.month,'2026-10');assert.equal(p.date,'2026-10-31');assert.equal(p.receipt.date,'2026-11-02');});
test('unreadable, mixed purpose, unknown category and invalid dates cannot plan',()=>{for(const patch of [{uncertainties:['unclear']},{category:'unknown'},{expenseOnly:false},{date:'2026-02-30'},{currency:'USD'}])assert.throws(()=>receiptPlan({...receipt,...patch},current));});
test('paid/approved/unknown targets and foreign company/browser origins fail closed',()=>{for(const text of ['ชำระเงินแล้ว','paid','approved','unknown'])assert.throws(()=>assertAwaiting(text));assertAwaiting('รอดำเนินการ');assert.throws(()=>assertCompanyUrl('https://evil.test/N270466/business/expenses','N270466'));assert.throws(()=>assertCompanyUrl('https://advance.flowaccount.com/N2/business/expenses','N270466'));});
test('SSE fragments preserve wakes and ignore unrelated frames',()=>{const a=wakeFrames('','data: sub');assert.equal(a.wake,false);const b=wakeFrames(a.tail,'scribe,channel,1\n\n');assert.equal(b.wake,true);assert.equal(wakeFrames('','event: ping\n\n').wake,false);});
