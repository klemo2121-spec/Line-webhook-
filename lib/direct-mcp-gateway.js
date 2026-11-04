import {createPlannedExpenseClient} from './flowaccount-mcp.js';
import {createFlowOAuth} from './flowaccount-oauth.js';
import {createExpenseStore} from './expense-store.js';
import {buildDirectExpensePlan,directEvidenceFromDocument,normalizePayee} from './direct-expense-policy.js';

const csv=value=>String(value||'').split(',').map(v=>v.trim()).filter(Boolean);
export class ReceiptQuestion extends Error {
  constructor(question){super('Receipt needs '+question);this.question=question;}
}
export function contactRows(result){
  const rows=Array.isArray(result)?result:result?.contacts||result?.data?.contacts||result?.data?.list||result?.data||result?.results||[];
  if(!Array.isArray(rows))throw Error('Unexpected contact response');
  return rows.map(c=>({id:String(c.id??c.contactId??''),name:c.name||c.nameLocal||c.nameForeign||c.contactName||''}));
}
export function creationAnchor(response,companyId){
  const r=response?.result||response,company=String(r.company_id??r.companyId??companyId);
  const recordId=String(r.record_id??r.recordId??''),serial=r.document_serial??r.documentSerial??r.serial;
  if(company!==companyId||!/^\d+$/.test(recordId)||!/^EXP\d{10}$/.test(serial||''))return null;
  return {companyId:company,recordId,serial,idempotencyKey:response.idempotency_key||r.idempotency_key||null};
}
export function checkPreview(preview,plan,answers=[]){
  const v=preview?.validation,review=preview?.review||{};
  if(v?.valid!==true||(v.errors||[]).length||(review.blockers||[]).length||
    Number(v.totals_summary?.grandTotal??v.totals?.grand_total)!==plan.total)throw Error('Expense preview needs review');
  if(preview.existing_document||preview.duplicate_document||preview.idempotent_replay)throw Error('Possible existing expense; reconcile first');
  const confirmed={};
  for(const c of review.clarifications||[]){
    if(c.required===false)continue;
    const key=c.key||c.topic;
    if(!key)throw Error('Unrecognized FlowAccount clarification');
    if(/multiple|ambiguous|choose.*contact|contact.*choice/i.test(key))throw new ReceiptQuestion('identity');
    if(/vat|inline|discount|category|document_type/i.test(key))confirmed[key]='Owner policy: one operating expense, gross amount, VAT exempt, no input VAT, no discount, document-level VAT and discount, category as supplied.';
    else if(/new.*contact|create.*contact|contact.*creat|vendor.*not.*found/i.test(key)&&plan.document.contact_name)confirmed[key]='Create supplier '+plan.document.contact_name+' as identified in the original receipt under the owner-authorized automatic expense policy.';
    else if(answers.length)confirmed[key]=answers.map(a=>a.text).join(' ').slice(0,1000);
    else throw new ReceiptQuestion('purpose');
  }
  return confirmed;
}

export function createDirectMcpGateway({env=process.env,jobs,send,oauth=createFlowOAuth({redis:createExpenseStore({env}),env}),createClient=createPlannedExpenseClient}={}){
  const companyId=env.FLOWACCOUNT_COMPANY_ID;
  async function clientFor(actor){
    if(!csv(env.EXPENSE_GROUP_IDS).includes(actor.groupId)||!csv(env.EXPENSE_USER_IDS).includes(actor.userId))throw Error('Receipt sender is not authorized');
    const client=await createClient({getToken:()=>oauth.getToken(actor)})();
    const context=await client.call('company_settings__load');
    if(String(context.user?.current_company_id)!==companyId)throw Error('FlowAccount company mismatch');
    const p=context.subscription?.permissions;
    if(p?.create_expense!==true||p?.create_document_ai!==true||p?.read_only_ai===true||p?.read_only===true)throw Error('Direct expense creation permission is unavailable');
    return client;
  }
  async function preflight(){
    const actors=[];
    for(const groupId of csv(env.EXPENSE_GROUP_IDS))for(const userId of csv(env.EXPENSE_USER_IDS)){
      if(actors.length>10)throw Error('Too many expense connections');
      if((await oauth.status({groupId,userId})).connected)actors.push({groupId,userId});
    }
    if(actors.length!==1)throw Error(actors.length?'Expense connection is ambiguous':'Connect FlowAccount from the expense LINE group first');
    const client=await clientFor(actors[0]),catalog=await client.listTools();
    if(!['expense__create_expense','expense__get_document','contacts__list','documents__get_creation_status'].every(name=>catalog.some(t=>t.name===name)))throw Error('Required official MCP tools are unavailable');
    return {ready:true,companyId,mode:'mcp_individual_event_v1',browser:false,payments:false};
  }
  return async function gateway(action,input){
    if(action==='preflight')return preflight();
    if(action==='request_connection'){
      const groups=csv(env.EXPENSE_GROUP_IDS),users=csv(env.EXPENSE_USER_IDS);
      if(groups.length!==1||users.length!==1||!send)throw Error('Choose the authorized expense owner before connecting');
      const actor={groupId:groups[0],userId:users[0]};
      const url=await oauth.start(actor);
      await send(actor.groupId,'כדי להפעיל רישום הוצאות ישירות מהקבוצה, אשר את חיבור FlowAccount של הבוט:\n'+url+'\nבחר Cannabis MCM. הקישור תקף לעשר דקות.',null);
      return {sent:true,expiresInSeconds:600};
    }
    const current=await jobs.work('direct_context',input),job=current.job;
    const client=await clientFor({groupId:job.groupId,userId:job.userId});
    if(action==='contacts'){
      if(job.status!=='claimed'||job.plan)throw Error('Contact resolution is only available before planning');
      if(typeof input.search!=='string'||!input.search.trim()||input.search.length>180)throw Error('Invalid payee search');
      const known=current.config.payeeRules.filter(r=>r.aliases.some(a=>normalizePayee(a)===normalizePayee(input.search)));
      if(known.length>1)throw Error('Known payee contact is ambiguous');
      const rule=known[0];
      if(rule?.contactRecordId){
        // Re-read the exact verified expense, rather than depending on the
        // contact search index for a supplier already identified by name.
        if(!Number.isSafeInteger(rule.contactRecordId)||!rule.sourceRecords.includes(rule.contactRecordId))throw Error('Invalid historical contact source');
        const response=await client.call('expense__get_document',{record_id:rule.contactRecordId,document_type:'expense',view:'full'});
        const d=response.data;
        if(String(d?.companyId)!==companyId||Number(d?.recordId)!==rule.contactRecordId||!/^\d+$/.test(String(d?.contactId||''))||
          ![rule.canonicalName,...rule.aliases].some(a=>normalizePayee(a)===normalizePayee(d.contactName)))throw Error('Historical contact does not match the verified recipient');
        return {contacts:[{id:String(d.contactId),name:d.contactName}],hasMore:false};
      }
      const response=await client.call('contacts__list',{search:input.search,fields:['id','name'],view:'summary'});
      return {contacts:contactRows(response),hasMore:response.pagination?.hasMore===true||response.data?.hasMore===true};
    }
    if(action==='preview'){
      if(job.status!=='claimed'||job.plan)throw Error('Receipt is already planned');
      const plan=buildDirectExpensePlan(input.receipt,current,current.config,input.existingContact);
      const preview=await client.call('expense__create_expense',{confirm:false,document:plan.document});
      checkPreview(preview,plan,job.answers);
      return {valid:true,total:plan.total};
    }
    if(action==='submit'){
      if(job.status!=='planned'||!job.plan)throw Error('Creation already started; do not submit again');
      // Re-check live review before persisting the irreversible write intent.
      const preview=await client.call('expense__create_expense',{confirm:false,document:job.plan.document});
      const confirmed=checkPreview(preview,job.plan,job.answers);
      await jobs.work('direct_write_started',input);
      const response=await client.createPlannedExpense(job.plan,confirmed);
      const key=response.idempotency_key;
      if(key)await jobs.work('direct_submitted',{...input,idempotencyKey:key});
      const creation=creationAnchor(response,companyId);
      if(!creation)throw Error('Creation is uncertain; reconcile the submission without resubmitting');
      await jobs.work('direct_created',{...input,creation});
      return {creation};
    }
    if(action==='verify'){
      if(!['writing','saved'].includes(job.status)||!job.plan)throw Error('No saved expense to verify');
      let creation=job.creation;
      if(!creation&&job.submissionKey){
        const status=await client.call('documents__get_creation_status',{idempotency_key:job.submissionKey});
        if(status.status==='completed'){
          creation=creationAnchor(status,companyId);
          if(creation)await jobs.work('direct_created',{...input,creation});
        }
      }
      if(!creation)throw Error('Uncertain creation; manual reconciliation is required, no new expense will be created');
      const response=await client.call('expense__get_document',{record_id:Number(creation.recordId),document_type:'expense',view:'full'});
      const evidence=directEvidenceFromDocument(job.plan,response);
      if(evidence.recordId!==creation.recordId||evidence.serial!==creation.serial)throw Error('Read-back returned another expense');
      await jobs.work('direct_saved',{...input,evidence});
      return {evidence};
    }
    throw Error('Unsupported direct MCP operation');
  };
}
