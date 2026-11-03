import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventExpenseProcessor,parseWakeFrames} from '../lib/event-expense-worker.js';
import {createDirectMcpGateway,creationAnchor,contactRows} from '../lib/direct-mcp-gateway.js';
import {createDirectMcpEndpoint} from '../api/direct-mcp.js';
import {createReceiptReader} from '../lib/receipt-reader.js';
import {buildDirectExpensePlan} from '../lib/direct-expense-policy.js';
import {directConfig,directCurrent,directReceipt} from './direct-expense-fixture.js';

const workerId='11111111-1111-4111-8111-111111111111';
function fixture(status='claimed'){
  const current=directCurrent();Object.assign(current.job,{status,workflow:'mcp_individual_v1',groupId:'G',userId:'U',imageHash:'source'});
  const rules=directConfig(),receipt=directReceipt();
  if(status!=='claimed')current.job.plan=buildDirectExpensePlan(receipt,current,rules);
  const calls=[];let complete=false;
  const worker=async(action,input)=>{
    calls.push([action,input]);
    if(action==='direct_claim')return complete?{idle:true}:structuredClone(current);
    if(action==='direct_rules')return {config:rules};
    if(action==='direct_plan'){current.job.plan=buildDirectExpensePlan(input.receipt,current,rules,input.existingContact);current.job.status='planned';return {status:'planned',plan:current.job.plan};}
    if(['direct_complete','request_info','reject_non_receipt'].includes(action))complete=true;
    return {};
  };
  const gateway=async(action,input)=>{
    calls.push([action,input]);
    if(action==='contacts')return {contacts:[{id:'77',name:receipt.vendor}]};
    if(action==='preview')return {valid:true,total:receipt.total};
    if(action==='submit')current.job.status='writing';
    return {};
  };
  return {current,rules,receipt,calls,worker,gateway};
}
test('empty queue makes no AI or FlowAccount calls',async()=>{
  let external=0;
  const processor=createEventExpenseProcessor({worker:async()=>({idle:true}),gateway:async()=>{external++;},extract:async()=>{external++;}});
  assert.deepEqual(await processor.drain(),{idle:true,processed:0});assert.equal(external,0);
});
test('one event processes a receipt in order and concurrent wakes cannot create twice',async()=>{
  const s=fixture();let reads=0;
  const processor=createEventExpenseProcessor({...s,extract:async()=>{reads++;return s.receipt;}});
  await Promise.all([processor.drain(),processor.drain()]);
  assert.equal(reads,1);
  const actions=s.calls.map(c=>c[0]);
  assert.deepEqual(actions,['direct_claim','direct_rules','contacts','preview','direct_plan','submit','verify','direct_complete','direct_claim']);
  assert.equal(s.current.job.plan.document.items[0].name,'Office operating supplies');
  assert.equal(s.current.job.plan.document.payment,undefined);
});
test('writing and saved recovery only read back and acknowledge; no reading or resubmission',async()=>{
  for(const status of ['writing','saved']){
    const s=fixture(status);
    await createEventExpenseProcessor({...s,extract:async()=>{throw Error('Must not call AI');}}).drain();
    assert.deepEqual(s.calls.map(c=>c[0]),['direct_claim','verify','direct_complete','direct_claim']);
  }
});
test('uncertain submit is not retried, and resuming uses verification only',async()=>{
  const s=fixture('planned');let creates=0;
  const gateway=async(action,input)=>{
    if(action==='submit'){creates++;s.current.job.status='writing';throw Error('Transport lost after write');}
    return s.gateway(action,input);
  };
  const p=createEventExpenseProcessor({...s,gateway,extract:async()=>{throw Error('No AI');}});
  await assert.rejects(p.drain(),/Transport/);await p.drain();assert.equal(creates,1);
});
test('real missing amount parks the original with one question and no preview/write',async()=>{
  const s=fixture();s.receipt.total=null;
  await createEventExpenseProcessor({...s,extract:async()=>s.receipt}).drain();
  assert.equal(s.calls.find(c=>c[0]==='request_info')[1].question,'amount');
  assert.equal(s.calls.some(c=>['preview','submit','direct_complete'].includes(c[0])),false);
});
test('an incomplete billable AI read persists intent and cannot charge again on the next wake',async()=>{
  const s=fixture();let attempted=false,reads=0;
  const p=createEventExpenseProcessor({...s,markExtractionStarted:async()=>{attempted=true;},loadExtraction:async()=>{if(attempted)throw Error('Prior AI read is uncertain');return null;},extract:async()=>{reads++;throw Error('AI response timed out');}});
  await assert.rejects(p.drain(),/timed out/);await assert.rejects(p.drain(),/Prior AI read/);assert.equal(reads,1);
  assert.equal(s.calls.some(c=>c[0]==='submit'),false);
});
test('non-receipt images leave review without an expense or acknowledgement',async()=>{
  const s=fixture();s.receipt.kind='other';
  await createEventExpenseProcessor({...s,extract:async()=>s.receipt}).drain();
  assert.deepEqual(s.calls.map(c=>c[0]),['direct_claim','direct_rules','fail','reject_non_receipt','direct_claim']);
});
test('event stream handles split frames, subscribe recovery, and refuses unrelated messages',()=>{
  let p=parseWakeFrames('','data: sub');assert.equal(p.wake,false);
  p=parseWakeFrames(p.tail,'scribe,channel,1\r\n\r\n');assert.equal(p.wake,true);
  assert.equal(parseWakeFrames('','data: ["message","channel","receipt"]\n\n').wake,true);
  assert.equal(parseWakeFrames('','data: {"result":["subscribe","channel",1]}\n\n').wake,true);
  assert.equal(parseWakeFrames('','data: random instruction\n\n').wake,false);
  assert.throws(()=>parseWakeFrames('','x'.repeat(65537)),/frame/);
});

function gatewayFixture({status='planned',wrongCompany=false,failCreate=false}={}){
  const current=directCurrent(),config=directConfig();
  Object.assign(current,{config});Object.assign(current.job,{groupId:'G',userId:'U',workflow:'mcp_individual_v1',status});
  current.job.plan=buildDirectExpensePlan(directReceipt(),current,config);
  const calls=[];
  const jobs={async work(action,input){
    calls.push(action);
    if(action==='direct_context')return structuredClone(current);
    if(action==='direct_write_started'){if(current.job.status!=='planned')throw Error('Already writing');current.job.status='writing';}
    if(action==='direct_created')current.job.creation=input.creation;
    if(action==='direct_submitted')current.job.submissionKey=input.idempotencyKey;
    if(action==='direct_saved')current.job.status='saved';
    return {};
  }};
  const document=()=>({companyId:7,recordId:99,documentSerial:'EXP2026110004',publishedOn:'2026-11-02',status:1,statusString:'awaiting',collected:0,isForeignCurrency:false,contactName:'Demo supplier',internalNotes:current.job.plan.document.internal_notes,reference:current.job.plan.reference,total:250,vatValue:0,withholdingTaxAmount:0,discount:0,productItems:[{expenseDescription:'Office operating supplies',quantity:1,pricePerUnit:250,total:250,expenseCategoryId:11}]});
  const preview={validation:{valid:true,totals:{grand_total:'250.00'}},review:{status:'ready',clarifications:[],blockers:[]}};
  const createClient=()=>async()=>({
    async call(name){
      calls.push(name);
      if(name==='company_settings__load')return {user:{current_company_id:wrongCompany?'8':'7'},subscription:{permissions:{create_expense:true,create_document_ai:true,read_only_ai:false}}};
      if(name==='expense__create_expense')return preview;
      if(name==='expense__get_document')return {data:document()};
      if(name==='documents__get_creation_status')return {status:'completed',result:{company_id:7,record_id:99,document_serial:'EXP2026110004',idempotency_key:'actual-auto-key'}};
    },
    async createPlannedExpense(plan){calls.push('CREATE');assert.deepEqual(plan,current.job.plan);if(failCreate)throw Error('Unknown upstream outcome');return {status:'created',company_id:7,record_id:99,document_serial:'EXP2026110004',idempotency_key:'actual-auto-key'};},
    async listTools(){return ['expense__create_expense','expense__get_document','contacts__list','documents__get_creation_status'].map(name=>({name}));}
  });
  const env={FLOWACCOUNT_COMPANY_ID:'7',EXPENSE_GROUP_IDS:'G',EXPENSE_USER_IDS:'U'};
  const gateway=createDirectMcpGateway({env,jobs,createClient,oauth:{status:async()=>({connected:true})}});
  return {gateway,current,calls,preview,env,jobs};
}
test('gateway records write intent before creating and saves returned anchor before read-back',async()=>{
  const s=gatewayFixture();await s.gateway('submit',{workerId,id:s.current.job.id});
  assert.ok(s.calls.indexOf('direct_write_started')<s.calls.indexOf('CREATE'));
  assert.ok(s.calls.indexOf('CREATE')<s.calls.indexOf('direct_created'));
  assert.equal(s.current.job.submissionKey,'actual-auto-key');
  await s.gateway('verify',{workerId,id:s.current.job.id});assert.equal(s.current.job.status,'saved');
  await assert.rejects(s.gateway('submit',{workerId,id:s.current.job.id}),/already started/);
  assert.equal(s.calls.filter(c=>c==='CREATE').length,1);
});
test('concurrent submissions compete for write intent, so only one reaches FlowAccount',async()=>{
  const s=gatewayFixture();const results=await Promise.allSettled([s.gateway('submit',{workerId,id:s.current.job.id}),s.gateway('submit',{workerId,id:s.current.job.id})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(s.calls.filter(c=>c==='CREATE').length,1);
});
test('failed create stays writing and can never be automatically submitted again',async()=>{
  const s=gatewayFixture({failCreate:true});
  await assert.rejects(s.gateway('submit',{workerId,id:s.current.job.id}),/Unknown upstream/);
  assert.equal(s.current.job.status,'writing');
  await assert.rejects(s.gateway('submit',{workerId,id:s.current.job.id}),/already started/);
  await assert.rejects(s.gateway('verify',{workerId,id:s.current.job.id}),/Uncertain creation/);
  assert.equal(s.calls.filter(c=>c==='CREATE').length,1);
});
test('writing recovery polls the actual returned key and verifies the exact created record',async()=>{
  const s=gatewayFixture({status:'writing'});s.current.job.submissionKey='actual-auto-key';
  await s.gateway('verify',{workerId,id:s.current.job.id});assert.equal(s.current.job.status,'saved');
  assert.equal(s.calls.includes('documents__get_creation_status'),true);assert.equal(s.calls.includes('CREATE'),false);
});
test('wrong company and unresolved preview blockers prevent all financial writes',async()=>{
  const s=gatewayFixture({wrongCompany:true});await assert.rejects(s.gateway('submit',{workerId,id:s.current.job.id}),/company mismatch/);assert.equal(s.calls.includes('CREATE'),false);
  const b=gatewayFixture();b.preview.review.blockers=['closed period'];await assert.rejects(b.gateway('submit',{workerId,id:b.current.job.id}),/preview needs review/);assert.equal(b.calls.includes('direct_write_started'),false);
});
test('API rejects unauthorized callers before touching MCP or receipt state',async()=>{
  let calls=0;const endpoint=createDirectMcpEndpoint({env:{BROWSER_WORKER_ENABLED:'true'},jobs:{},gateway:async()=>{calls++;}});
  const res={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
  await endpoint({method:'POST',headers:{},body:{action:'submit',workerId}},res);assert.equal(res.code,401);assert.equal(calls,0);
});
test('reader reserves budget before a single request and never fabricates an incomplete response',async()=>{
  let requests=0;
  const reader=createReceiptReader({apiKey:'sk-test',model:'configured-model',reserveUsage:async()=>{throw Error('Budget reached');},fetchImpl:async()=>{requests++;}});
  await assert.rejects(reader({image:{contentType:'image/jpeg',base64:'eA=='},job:{}},directConfig()),/Budget/);assert.equal(requests,0);
  const incomplete=createReceiptReader({apiKey:'sk-test',model:'configured-model',reserveUsage:async()=>{},fetchImpl:async()=>{requests++;return new Response(JSON.stringify({status:'incomplete',output:[]}));}});
  await assert.rejects(incomplete({image:{contentType:'image/jpeg',base64:'eA=='},job:{}},directConfig()),/incomplete/);assert.equal(requests,1);
});
test('creation response accepts the actual gateway key and refuses another company',()=>{
  assert.equal(creationAnchor({company_id:8,record_id:99,document_serial:'EXP2026110004'},'7'),null);
  assert.equal(creationAnchor({company_id:7,record_id:99,document_serial:'EXP2026110004',idempotency_key:'auto:actual'},'7').idempotencyKey,'auto:actual');
});
test('native contact projection resolves the returned local name from data.list',()=>{
  assert.deepEqual(contactRows({data:{list:[{id:'77',nameLocal:'Demo supplier'}]}}),[{id:'77',name:'Demo supplier'}]);
});
test('connection link uses the sole configured owner and sends no financial request',async()=>{
  const sent=[],actors=[];
  const gateway=createDirectMcpGateway({env:{FLOWACCOUNT_COMPANY_ID:'7',EXPENSE_GROUP_IDS:'G',EXPENSE_USER_IDS:'U'},jobs:{},oauth:{start:async actor=>{actors.push(actor);return 'https://mcp.flowaccount.com/authorize?state=test';}},send:async(...args)=>sent.push(args),createClient:()=>{throw Error('No MCP call before consent');}});
  assert.equal((await gateway('request_connection',{workerId})).sent,true);
  assert.deepEqual(actors,[{groupId:'G',userId:'U'}]);assert.equal(sent[0][0],'G');assert.match(sent[0][1],/https:\/\/mcp.flowaccount.com/);
});
test('arrival-time owner purpose and previous-month instruction classify a slip without changing its printed date',()=>{
  const current=directCurrent();current.job.override={month:'2026-10',purpose:'Rent for last month'};
  const receipt={...directReceipt(),kind:'payment_slip',category:'unknown',purpose:null,descriptionEnglish:'Transfer',expenseOnly:false,uncertainties:['unknown_purpose','unknown_category']};
  const plan=buildDirectExpensePlan(receipt,current,directConfig());
  assert.equal(plan.document.items[0].name,'Rent');assert.equal(plan.date,'2026-10-31');assert.equal(plan.receipt.date,'2026-11-02');
});
