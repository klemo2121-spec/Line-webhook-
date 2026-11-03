import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDirectExpensePlan,normalizePayee,recognizeExpense,directEvidenceFromDocument} from '../lib/direct-expense-policy.js';
import {directConfig,directReceipt,directCurrent} from './direct-expense-fixture.js';

test('historical names, observed variants and titles map to English payroll without amount matching',()=>{
  const r={...directReceipt(),kind:'payment_slip',vendor:'MR ALEX EXAMPEL',category:'unknown',expenseOnly:false,uncertainties:['unknown_purpose','unknown_category']};
  const plan=buildDirectExpensePlan(r,directCurrent(),directConfig());
  assert.equal(plan.document.contact_name,'Alex Example');assert.equal(plan.document.items[0].category_id,12);
  assert.match(plan.document.items[0].name,/Salary/);assert.equal(plan.total,250);assert.equal(plan.paid,0);
  assert.equal(recognizeExpense({...r,vendor:'Alex Exampelx'},directConfig()),null);
  assert.notEqual(normalizePayee('กา'),normalizePayee('ก่า'));
});

test('known social-security recipient maps to its own category',()=>{
  const r={...directReceipt(),kind:'payment_slip',vendor:'Casey Example',category:'unknown',uncertainties:['unknown_category']};
  assert.equal(buildDirectExpensePlan(r,directCurrent(),directConfig()).document.items[0].category_id,13);
});

test('contradictory purpose, ambiguous aliases and category conflicts require review',()=>{
  const r={...directReceipt(),vendor:'Alex Example',category:'unknown'};
  for(const patch of [{purpose:'employee reimbursement'},{purpose:'rent'},{category:'General expenses'}])assert.throws(()=>buildDirectExpensePlan({...r,...patch},directCurrent(),directConfig()));
  const config=directConfig();config.payeeRules.push({...config.payeeRules[0],id:'different-person'});
  assert.throws(()=>buildDirectExpensePlan(r,directCurrent(),config),/ambiguous/);
  const current=directCurrent();current.job.override.bucket='online';assert.throws(()=>buildDirectExpensePlan(r,current,directConfig()),/Owner classification conflicts/);
});

test('individual documents preserve the receipt date and apply an explicit month override only once',()=>{
  const current=directCurrent(),r=directReceipt();
  const p=buildDirectExpensePlan(r,current,directConfig());
  assert.equal(p.document.document_date,'2026-11-02');assert.equal(p.document.items.length,1);
  assert.equal(p.document.items[0].unit_price,250);assert.equal(p.document.payment,undefined);
  current.job.override.month='2026-10';const moved=buildDirectExpensePlan(r,current,directConfig());
  assert.equal(moved.date,'2026-10-31');assert.match(moved.document.items[0].name,/2026-11-02/);
});

test('company, original-photo consent, currency, uncertain amounts, tax and assets remain guarded',()=>{
  for(const patch of [{currency:'USD'},{date:'2026-02-30'},{total:NaN},{withholding:null},{withholding:3},{expenseOnly:false},{uncertainties:['inventory_or_asset']},{descriptionEnglish:'הוצאה'}])assert.throws(()=>buildDirectExpensePlan({...directReceipt(),...patch},directCurrent(),directConfig()));
  for(const patch of [{companyId:'8'},{attachmentPolicy:'not_confirmed'},{ownerConsent:{originalsInLine:false}}])assert.throws(()=>buildDirectExpensePlan(directReceipt(),directCurrent(),{...directConfig(),...patch}));
  assert.throws(()=>buildDirectExpensePlan({...directReceipt(),kind:'payment_slip',category:'unknown'},directCurrent(),directConfig()));
});

test('existing contact resolution must match the recognized name',()=>{
  const r={...directReceipt(),vendor:'Alex Example',category:'unknown'};
  const plan=buildDirectExpensePlan(r,directCurrent(),directConfig(),{id:'123',name:'Mr. Alex Example'});
  assert.equal(plan.document.contact_id,'123');assert.equal(plan.document.contact_name,undefined);
  assert.throws(()=>buildDirectExpensePlan(r,directCurrent(),directConfig(),{id:'123',name:'Other person'}));
});

test('read-back verifies exact line, company, price, category, reference, taxes and unpaid state',()=>{
  const plan=buildDirectExpensePlan(directReceipt(),directCurrent(),directConfig());
  const d={companyId:7,recordId:22,documentSerial:'EXP2026110004',status:1,statusString:'awaiting',collected:0,isForeignCurrency:false,publishedOn:plan.date+'T00:00:00',total:250,reference:plan.reference,contactName:plan.document.contact_name,vatValue:0,withholdingTaxAmount:0,discount:0,productItems:[{expenseDescription:plan.document.items[0].name,quantity:1,pricePerUnit:250,total:250,expenseCategoryId:11}]};
  assert.equal(directEvidenceFromDocument(plan,{data:d}).total,250);
  for(const patch of [{companyId:8},{status:2},{collected:250},{reference:'other'},{withholdingTaxAmount:3},{productItems:[{...d.productItems[0],pricePerUnit:0}]},{productItems:[...d.productItems,...d.productItems]}])assert.throws(()=>directEvidenceFromDocument(plan,{data:{...d,...patch}}));
});
