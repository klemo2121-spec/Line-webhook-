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

test('server refuses a bank reading whose legacy payee fields substitute the sender for the observed recipient',()=>{
  const receipt={...directReceipt(),readerVersion:2,kind:'payment_slip',senderName:'Alex Example',recipientName:'Demo supplier',vendor:'Alex Example',payeeName:'Alex Example',purpose:'Salary',category:'Salary/Wages'};
  assert.throws(()=>buildDirectExpensePlan(receipt,directCurrent(),directConfig()),/recipient reading/);
  const current=directCurrent();current.job.override.bucket='online';
  const valid={...receipt,vendor:'Demo supplier',payeeName:'Demo supplier',purpose:null,category:'unknown'};
  assert.equal(buildDirectExpensePlan(valid,current,directConfig()).document.contact_name,'Demo supplier');
  assert.equal(recognizeExpense(valid,directConfig()),null);
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
  assert.equal(moved.date,'2026-10-31');assert.match(moved.document.internal_notes,/Receipt: 2026-11-02/);
});

test('company, original-photo consent, currency, uncertain amounts, tax and assets remain guarded',()=>{
  for(const patch of [{currency:'USD'},{date:'2026-02-30'},{total:NaN},{withholding:null},{withholding:3},{expenseOnly:false},{uncertainties:['inventory_or_asset']},{descriptionEnglish:'הוצאה'}])assert.throws(()=>buildDirectExpensePlan({...directReceipt(),...patch},directCurrent(),directConfig()));
  for(const patch of [{companyId:'8'},{attachmentPolicy:'not_confirmed'},{ownerConsent:{originalsInLine:false}}])assert.throws(()=>buildDirectExpensePlan(directReceipt(),directCurrent(),{...directConfig(),...patch}));
  const badSource=directConfig();badSource.payeeRules[0].contactRecordId=999;
  assert.throws(()=>buildDirectExpensePlan(directReceipt(),directCurrent(),badSource),/verified historical expense/);
  assert.throws(()=>buildDirectExpensePlan({...directReceipt(),kind:'payment_slip',category:'unknown'},directCurrent(),directConfig()));
});

test('existing contact resolution must match the recognized name',()=>{
  const r={...directReceipt(),vendor:'Alex Example',category:'unknown'};
  const plan=buildDirectExpensePlan(r,directCurrent(),directConfig(),{id:'123',name:'Mr. Alex Example'});
  assert.equal(plan.document.contact_id,'123');assert.equal(plan.document.contact_name,undefined);
  assert.throws(()=>buildDirectExpensePlan(r,directCurrent(),directConfig(),{id:'123',name:'Other person'}));
});

test('owner product-heading policy uses the expense label as contact while preserving source recipient and dedup facts',()=>{
  const config={...directConfig(),expenseHeading:'product'};
  config.purposeRules.push({id:'gas',aliases:['CO2'],categoryId:11,categoryName:'General expenses',englishDescription:'CO2 supply',sourceRecords:[106]});
  const receipt={...directReceipt(),kind:'payment_slip',vendor:'Example Gas Recipient',category:'unknown',expenseOnly:false,descriptionEnglish:'Bank transfer',uncertainties:['unknown_purpose','unknown_category']};
  const current=directCurrent();current.job.override.purpose='CO2';
  const plan=buildDirectExpensePlan(receipt,current,config);
  assert.equal(plan.document.contact_name,'CO2 supply');assert.equal(plan.document.items[0].name,'CO2 supply');
  assert.equal(plan.sourcePayee,'Example Gas Recipient');assert.equal(plan.receipt.vendor,receipt.vendor);
  assert.ok(plan.document.internal_notes.includes('Payee: Example Gas Recipient'));assert.equal(plan.total,receipt.total);
  assert.throws(()=>buildDirectExpensePlan(receipt,current,config,{id:'55',name:'Example Gas Recipient'}),/does not match/);
  const resolved=buildDirectExpensePlan(receipt,current,config,{id:'56',name:'CO2 SUPPLY'});
  assert.equal(resolved.document.contact_id,'56');assert.equal(resolved.sourcePayee,plan.sourcePayee);
  assert.equal(buildDirectExpensePlan(receipt,current,{...config,expenseHeading:'payee'}).document.contact_name,receipt.vendor);
});

test('a saved product-heading expense must retain the actual recipient in notes',()=>{
  const plan=buildDirectExpensePlan(directReceipt(),directCurrent(),{...directConfig(),expenseHeading:'product'});
  const d={companyId:7,recordId:22,documentSerial:'EXP2026110004',status:1,statusString:'awaiting',collected:0,isForeignCurrency:false,publishedOn:plan.date,total:250,reference:plan.reference,contactName:plan.document.contact_name,internalNotes:plan.document.internal_notes,vatValue:0,withholdingTaxAmount:0,discount:0,productItems:[{expenseDescription:plan.document.items[0].name,quantity:1,pricePerUnit:250,total:250,expenseCategoryId:11}]};
  assert.equal(directEvidenceFromDocument(plan,{data:d}).sourcePayee,'Demo supplier');
  assert.throws(()=>directEvidenceFromDocument(plan,{data:{...d,internalNotes:plan.document.internal_notes.replace('Payee: Demo supplier','Payee: Different recipient')}}),/lost the original payee/);
  const resolved={...plan,document:{...plan.document,contact_id:'77'}};
  assert.throws(()=>directEvidenceFromDocument(resolved,{data:{...d,contactId:77,contactName:'Demo supplier'}}),/product heading differs/);
});

test('read-back verifies exact line, company, price, category, reference, taxes and unpaid state',()=>{
  const plan=buildDirectExpensePlan(directReceipt(),directCurrent(),directConfig());
  const d={companyId:7,recordId:22,documentSerial:'EXP2026110004',status:1,statusString:'awaiting',collected:0,isForeignCurrency:false,publishedOn:plan.date+'T00:00:00',total:250,reference:plan.reference,contactName:plan.document.contact_name,internalNotes:plan.document.internal_notes,vatValue:0,withholdingTaxAmount:0,discount:0,productItems:[{expenseDescription:plan.document.items[0].name,quantity:1,pricePerUnit:250,total:250,expenseCategoryId:11}]};
  assert.equal(plan.document.items[0].name,'Office operating supplies');assert.ok(!plan.document.items[0].name.includes('[LINE:'));
  assert.equal(directEvidenceFromDocument(plan,{data:d}).total,250);
  for(const patch of [{companyId:8},{status:2},{collected:250},{reference:'other'},{internalNotes:''},{withholdingTaxAmount:3},{productItems:[{...d.productItems[0],pricePerUnit:0}]},{productItems:[...d.productItems,...d.productItems]}])assert.throws(()=>directEvidenceFromDocument(plan,{data:{...d,...patch}}));
  const legacy={...plan,markerLocation:undefined,document:{...plan.document,items:[{...plan.document.items[0],name:`Office operating supplies ${plan.marker}`}]}};
  assert.equal(directEvidenceFromDocument(legacy,{data:{...d,internalNotes:'',productItems:[{...d.productItems[0],expenseDescription:legacy.document.items[0].name}]}}).markerCount,1);
});
