import {monthEnd} from './months.js';

const supportedCategories=new Set(['General expenses','Messenger/Postage','Electricity','Salary/Wages','Social security funds','Rent','Internet','WaterPlumbing','Freight/Courier/Logistics','General services/Freelance','Accounting services','Office supplies/Stationery']);
const money=n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&Math.abs(n*100-Math.round(n*100))<0.001;
export const normalizePayee=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu,' ').trim().replace(/\s+/g,' ').replace(/^(?:mr|mrs|ms|miss|dr)\s+/,'');
const phrase=(text,alias)=>(' '+normalizePayee(text)+' ').includes(' '+normalizePayee(alias)+' ');
const conciseDescription=value=>{
  const text=value.replace(/\s+/g,' ').trim().replace(/^Social Security contribution$/i,'Social Security');
  return text.length<=70?text:text.slice(0,67).replace(/\s+\S*$/,'')+'…';
};

export function validateRecognitionConfig(config,companyId){
  if(config?.companyId!==companyId||config.mode!=='one_expense_per_receipt'||config.language!=='en'||config.recordPayments!==false||config.attachmentPolicy!=='line_original_only'||config.ownerConsent?.originalsInLine!==true)throw Error('Explicit individual-expense and LINE-original policy required');
  if(!Array.isArray(config.payeeRules)||!Array.isArray(config.purposeRules)||config.payeeRules.length+config.purposeRules.length>150)throw Error('Invalid private recognition rules');
  if(!Array.isArray(config.categoryCatalog)||!config.categoryCatalog.length)throw Error('Company expense categories are required');
  const categories=new Map(config.categoryCatalog.map(c=>[Number(c.id),c.name]));
  for(const rule of [...config.payeeRules,...config.purposeRules]){
    if(!rule.id||!Array.isArray(rule.aliases)||!rule.aliases.length||rule.aliases.length>30||rule.aliases.some(a=>typeof a!=='string'||!a.trim()||a.length>180)||!Array.isArray(rule.sourceRecords)||!rule.sourceRecords.length||categories.get(Number(rule.categoryId))!==rule.categoryName||!supportedCategories.has(rule.categoryName))throw Error('Recognition rule has no verified company category/history');
    if(rule.contactRecordId!==undefined&&(!Number.isSafeInteger(rule.contactRecordId)||rule.contactRecordId<=0||!rule.sourceRecords.includes(rule.contactRecordId)))throw Error('Contact source must be a verified historical expense');
  }
  return config;
}

export function recognizeExpense(receipt,config,ownerText=''){
  const names=(receipt.kind==='payment_slip'&&receipt.readerVersion===2?[receipt.recipientName]:[receipt.payeeName,receipt.vendor]).filter(Boolean).map(normalizePayee);
  const hits=config.payeeRules.filter(rule=>rule.aliases.some(alias=>names.includes(normalizePayee(alias))));
  if(hits.length>1)throw Error('Payee identity is ambiguous');
  const purpose=[receipt.purpose,receipt.descriptionEnglish,ownerText].filter(Boolean).join(' ');
  const purposes=config.purposeRules.filter(rule=>rule.aliases.some(alias=>phrase(purpose,alias))).sort((a,b)=>Math.max(...b.aliases.map(a=>a.length))-Math.max(...a.aliases.map(a=>a.length)));
  const rule=hits[0]||purposes[0];
  if(!rule)return null;
  if((rule.contradictoryKeywords||[]).some(word=>phrase(purpose,word)))throw Error('Known payee has a different payment purpose');
  if(hits[0]&&purposes.some(p=>Number(p.categoryId)!==Number(rule.categoryId)))throw Error('Payee history conflicts with current purpose');
  if(receipt.category&&receipt.category!=='unknown'&&receipt.category!==rule.categoryName)throw Error('Current category conflicts with payee history');
  return {id:rule.id,payee:rule.canonicalName||null,description:rule.englishDescription,categoryId:Number(rule.categoryId),category:rule.categoryName,sourceRecords:rule.sourceRecords,aliases:rule.aliases,role:rule.role||'purpose'};
}

export function buildDirectExpensePlan(receipt,current,config,existingContact){
  validateRecognitionConfig(config,current.companyId);
  const job=current.job;
  if(receipt?.kind==='payment_slip'&&receipt.readerVersion===2){
    const recipient=normalizePayee(receipt.recipientName);
    if(!recipient||recipient===normalizePayee(receipt.senderName)||[receipt.vendor,receipt.payeeName].some(name=>normalizePayee(name)!==recipient))throw Error('Transfer recipient reading needs review');
  }
  if(!/^[a-f0-9]{24}$/.test(job?.id||'')||!receipt||receipt.readable!==true||!['receipt','payment_slip'].includes(receipt.kind)||!money(receipt.total)||!/^20\d\d-\d\d-\d\d$/.test(receipt.date||''))throw Error('Receipt amount/date/readability needs review');
  const dateObject=new Date(receipt.date+'T00:00:00Z');if(!Number.isFinite(dateObject.getTime())||dateObject.toISOString().slice(0,10)!==receipt.date)throw Error('Invalid receipt date');
  if(!/^(?:THB|baht|บาท|฿)$/i.test(String(receipt.currency||'').trim())||receipt.withholding!==0)throw Error('Currency or withholding needs review');
  const ownerText=[job.override?.purpose,...(job.answers||[]).map(a=>a.text)].filter(Boolean).join(' '),recognition=recognizeExpense(receipt,config,ownerText);
  if(recognition&&job.override?.bucket==='online'&&recognition.category!=='General expenses'||recognition&&job.override?.bucket==='electricity'&&recognition.category!=='Electricity')throw Error('Owner classification conflicts with payee history');
  let category=recognition?.category||receipt.category;
  if(!recognition&&job.override?.bucket==='online')category='General expenses';
  if(!recognition&&job.override?.bucket==='electricity')category='Electricity';
  const categoryInfo=config.categoryCatalog.find(c=>c.name===category&&supportedCategories.has(c.name));
  if(!categoryInfo)throw Error('Expense purpose/category needs review');
  const purposeResolved=!!(recognition||job.override?.bucket);
  const uncertainty=(receipt.uncertainties||[]).filter(code=>!(purposeResolved&&['unknown_purpose','unknown_category'].includes(code)));
  if(uncertainty.length||receipt.kind==='receipt'&&receipt.expenseOnly!==true)throw Error('Unclear, inventory or asset receipt needs review');
  if(receipt.kind==='payment_slip'&&!recognition&&!job.confirmedExpense&&!job.override?.bucket)throw Error('Bank slip business purpose needs review');
  const contactName=recognition?.payee||receipt.vendor;
  if(typeof contactName!=='string'||!contactName.trim()||contactName.length>180)throw Error('Supplier/payee needs review');
  let description=recognition?.description||receipt.descriptionEnglish;
  if(typeof description!=='string'||!/[A-Za-z]/.test(description)||/[א-תก-๙]/.test(description))throw Error('An English expense description is required');
  description=conciseDescription(description);
  const date=job.override?.month?monthEnd(job.override.month):receipt.date,marker=`[LINE:${job.id}]`,reference=`LINE:${job.id}`;
  const notes=[marker],sourceRef=receipt.invoiceNumber||receipt.transactionId;
  if(sourceRef)notes.push(`Ref: ${String(sourceRef).slice(0,64)}`);
  if(date!==receipt.date)notes.push(`Receipt: ${receipt.date}`);
  const document={contact_name:contactName,document_date:date,due_date:date,credit_type:'credit',currency:'THB',expenseCategoryView:'business',is_vat_inclusive:false,use_inline_vat:false,use_inline_discount:false,discount_amount:0,withholding_tax_amount:0,withholding_tax_percentage:0,items:[{name:description,quantity:1,unit_price:receipt.total,category_id:Number(categoryInfo.id),vat_type:'exempt'}],reference,internal_notes:notes.join(' | ')};
  if(existingContact){
    const accepted=[contactName,...(recognition?.aliases||[])].map(normalizePayee);
    if(!/^\d+$/.test(String(existingContact.id||''))||!accepted.includes(normalizePayee(existingContact.name)))throw Error('Resolved contact does not match the verified payee');
    document.contact_id=String(existingContact.id);delete document.contact_name;
  }
  return {workflow:'mcp_individual_v1',companyId:current.companyId,date,total:receipt.total,paid:0,status:'awaiting',attachmentMode:'line_original_only',marker,markerLocation:'internal_notes',reference,receipt:{...receipt,currency:'THB',category},recognition:recognition?{...recognition,aliases:undefined}:null,existingContact:existingContact||null,document};
}

export function verifyDirectEvidence(plan,evidence){
  if(evidence?.companyId!==plan.companyId||!/^EXP\d{10}$/.test(evidence.serial||'')||!/^\d+$/.test(String(evidence.recordId||''))||evidence.date!==plan.date||evidence.status!=='awaiting'||evidence.paid!==0||evidence.total!==plan.total||evidence.reference!==plan.reference||evidence.marker!==plan.marker||evidence.markerCount!==1||evidence.lineCount!==1||evidence.categoryId!==plan.document.items[0].category_id||evidence.vat!==0||evidence.withholding!==0||evidence.discount!==0)throw Error('Saved individual expense does not match its verified plan');
  return evidence;
}

export function directEvidenceFromDocument(plan,response){
  const d=response?.structuredContent?.data||response?.data||response,items=d?.productItems;
  if(!d||String(d.companyId)!==plan.companyId||d.status!==1||d.statusString!=='awaiting'||d.collected!==0||d.isForeignCurrency!==false||!Array.isArray(items)||items.length!==1)throw Error('Saved document company/state/items do not match');
  const item=items[0],text=item.expenseDescription||item.description||item.name||'',expected=plan.document.items[0];
  if(text!==expected.name||item.quantity!==1||item.pricePerUnit!==plan.total||item.total!==plan.total||Number(item.expenseCategoryId)!==expected.category_id)throw Error('Saved line differs from the receipt');
  if(plan.document.contact_id?String(d.contactId)!==plan.document.contact_id:normalizePayee(d.contactName)!==normalizePayee(plan.document.contact_name))throw Error('Saved payee does not match');
  const markerText=plan.markerLocation==='internal_notes'?String(d.internalNotes||''):text;
  const evidence={companyId:String(d.companyId),recordId:String(d.recordId),serial:d.documentSerial,date:String(d.publishedOn).slice(0,10),status:'awaiting',paid:d.collected,total:d.total,reference:d.reference,marker:plan.marker,markerCount:markerText.split(plan.marker).length-1,lineCount:items.length,categoryId:Number(item.expenseCategoryId),vat:d.vatValue,withholding:d.withholdingTaxAmount,discount:d.discount};
  return verifyDirectEvidence(plan,evidence);
}
