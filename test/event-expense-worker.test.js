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
    if(action==='direct_context')return {...structuredClone(current),config:rules};
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
  assert.deepEqual(actions,['direct_claim','direct_rules','direct_context','contacts','preview','direct_plan','submit','verify','direct_complete','direct_claim']);
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

test('a fertilizer caption arriving during image reading resolves the historical company category without another question',async()=>{
  const s=fixture();s.rules.categoryCatalog.push({id:15,name:'Purchased for servicing'});
  s.rules.purposeRules.push({id:'farm-fertilizer',aliases:['Fertilizer','Fertilizers'],categoryId:15,categoryName:'Purchased for servicing',englishDescription:'Fertilizers',sourceRecords:[106]});
  Object.assign(s.receipt,{kind:'payment_slip',category:'unknown',expenseOnly:false,uncertainties:['unknown_purpose','unknown_category']});
  await createEventExpenseProcessor({...s,extract:async()=>{s.current.job.override.purpose='Fertilizers';s.current.job.contextVersion=1;return s.receipt;}}).drain();
  assert.equal(s.calls.some(c=>c[0]==='request_info'),false);assert.equal(s.current.job.plan.document.items[0].name,'Fertilizers');
  assert.equal(s.current.job.plan.document.items[0].category_id,15);assert.equal(s.calls.filter(c=>c[0]==='submit').length,1);
});

test('a caption racing a missing-purpose question restarts planning from cached image facts with no second AI call',async()=>{
  const s=fixture();Object.assign(s.receipt,{kind:'payment_slip',category:'unknown',expenseOnly:false,uncertainties:['unknown_purpose','unknown_category']});
  s.rules.purposeRules.push({id:'gas',aliases:['CO2'],categoryId:11,categoryName:'General expenses',englishDescription:'CO2 supply',sourceRecords:[106]});
  let cache,reads=0,restarts=0;
  const worker=async(action,input)=>{
    if(action==='request_info'&&!restarts){restarts++;s.current.job.override.purpose='CO2';s.current.job.contextVersion=1;return {retry:true};}
    return s.worker(action,input);
  };
  await createEventExpenseProcessor({...s,worker,loadExtraction:async()=>cache,saveExtraction:async(c,r,receipt)=>{cache=receipt;},extract:async()=>{reads++;return s.receipt;}}).drain();
  assert.equal(reads,1);assert.equal(restarts,1);assert.equal(s.current.job.plan.document.items[0].name,'CO2 supply');
  assert.equal(s.calls.some(c=>c[0]==='request_info'),false);assert.equal(s.calls.filter(c=>c[0]==='submit').length,1);
});

test('a familiar payroll sender cannot override the printed commerce recipient or ask a redundant purpose question',async()=>{
  const s=fixture();
  s.current.image={contentType:'image/jpeg',base64:'eA=='};
  s.rules.payeeRules.push({id:'online-wallet',canonicalName:'EXAMPLEPAY',aliases:['EXAMPLEPAY'],categoryId:11,categoryName:'General expenses',englishDescription:'Online shopping',sourceRecords:[106]});
  const raw={...s.receipt,date:'2026-11-04T11:02:00',kind:'payment_slip',senderName:'Alex Example',recipientName:'EXAMPLEPAY',vendor:'Alex Example',payeeName:'Alex Example',purpose:'Salary — Alex Example',category:'Salary/Wages'};
  let request;
  const extract=createReceiptReader({apiKey:'sk-test',model:'configured-model',reserveUsage:async()=>{},fetchImpl:async(url,options)=>{
    request=JSON.parse(options.body);
    return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(raw)}]}]}));
  }});
  s.current.job.answers=[{text:'Private owner clarification'}];
  await createEventExpenseProcessor({...s,extract}).drain();
  assert.equal(s.current.job.plan.document.contact_name,'EXAMPLEPAY');
  assert.equal(s.current.job.plan.document.items[0].name,'Online shopping');
  assert.equal(s.current.job.plan.document.items[0].category_id,11);
  assert.equal(s.current.job.plan.date,'2026-11-04');
  assert.equal(s.calls.some(c=>c[0]==='request_info'),false);
  assert.equal(s.calls.filter(c=>c[0]==='submit').length,1);
  const textInput=request.input[0].content.find(c=>c.type==='input_text').text;
  assert.equal(textInput.includes('Alex Example'),false);
  assert.equal(textInput.includes('Private owner clarification'),false);
});

test('product-heading contact resolution never selects the original payee contact by historical alias',async()=>{
  const s=fixture();s.rules.expenseHeading='product';s.receipt.vendor='Alex Example';s.receipt.category='unknown';
  const gateway=async(action,input)=>action==='contacts'?{contacts:[{id:'1',name:'Alex Example'},{id:'2',name:'Salary — Alex Example'}]}:s.gateway(action,input);
  await createEventExpenseProcessor({...s,gateway,extract:async()=>s.receipt}).drain();
  assert.equal(s.current.job.plan.document.contact_id,'2');assert.equal(s.current.job.plan.sourcePayee,'Alex Example');
  assert.equal(s.calls.some(c=>c[0]==='request_info'),false);
});

test('an unreadable or self-conflicting transfer recipient cannot proceed or become a generic purpose question',async()=>{
  for(const recipientName of [null,'Alex Example']){
    const s=fixture();
    s.current.image={contentType:'image/jpeg',base64:'eA=='};
    const raw={...s.receipt,kind:'payment_slip',senderName:'Alex Example',recipientName};
    const extract=createReceiptReader({apiKey:'sk-test',model:'configured-model',reserveUsage:async()=>{},fetchImpl:async()=>new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(raw)}]}]}))});
    await assert.rejects(createEventExpenseProcessor({...s,extract}).drain(),/recipient reading/);
    assert.equal(s.calls.some(c=>['request_info','submit','direct_plan'].includes(c[0])),false);
  }
});
test('an incomplete billable AI read persists intent and cannot charge again on the next wake',async()=>{
  const s=fixture();let attempted=false,reads=0;
  const p=createEventExpenseProcessor({...s,markExtractionStarted:async()=>{attempted=true;},loadExtraction:async()=>{if(attempted)throw Error('Prior AI read is uncertain');return null;},extract:async()=>{reads++;throw Error('AI response timed out');}});
  await assert.rejects(p.drain(),/timed out/);await assert.rejects(p.drain(),/Prior AI read/);assert.equal(reads,1);
  assert.equal(s.calls.some(c=>c[0]==='submit'),false);
});
test('a model non-receipt classification asks about the original instead of silently discarding it',async()=>{
  const s=fixture();s.receipt.kind='other';
  await createEventExpenseProcessor({...s,extract:async()=>s.receipt}).drain();
  assert.deepEqual(s.calls.map(c=>c[0]),['direct_claim','direct_rules','direct_context','request_info','direct_claim']);
  assert.equal(s.calls.find(c=>c[0]==='request_info')[1].question,'document');
});
test('event stream handles split frames, subscribe recovery, and refuses unrelated messages',()=>{
  let p=parseWakeFrames('','data: sub');assert.equal(p.wake,false);
  p=parseWakeFrames(p.tail,'scribe,channel,1\r\n\r\n');assert.equal(p.wake,true);
  assert.equal(parseWakeFrames('','data: ["message","channel","receipt"]\n\n').wake,true);
  assert.equal(parseWakeFrames('','data: {"result":["subscribe","channel",1]}\n\n').wake,true);
  assert.equal(parseWakeFrames('','data: random instruction\n\n').wake,false);
  assert.throws(()=>parseWakeFrames('','x'.repeat(65537)),/frame/);
});

function gatewayFixture({status='planned',wrongCompany=false,failCreate=false,documentPatch={}}={}){
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
  const document=()=>({companyId:7,recordId:99,documentSerial:'EXP2026110004',publishedOn:'2026-11-02',status:1,statusString:'awaiting',collected:0,isForeignCurrency:false,contactId:77,contactName:'Demo supplier',internalNotes:current.job.plan?.document.internal_notes,reference:current.job.plan?.reference,total:250,vatValue:0,withholdingTaxAmount:0,discount:0,productItems:[{expenseDescription:'Office operating supplies',quantity:1,pricePerUnit:250,total:250,expenseCategoryId:11}],...documentPatch});
  const preview={validation:{valid:true,totals:{grand_total:'250.00'}},review:{status:'ready',clarifications:[],blockers:[]}};
  const createClient=()=>async()=>({
    async call(name){
      calls.push(name);
      if(name==='company_settings__load')return {user:{current_company_id:wrongCompany?'8':'7'},subscription:{permissions:{create_expense:true,create_document_ai:true,read_only_ai:false}}};
      if(name==='expense__create_expense')return preview;
      if(name==='expense__get_document')return {data:document()};
      if(name==='contacts__list')return {data:{list:[{id:'77',nameLocal:'Demo supplier'}]}};
      if(name==='documents__get_creation_status')return {status:'completed',result:{company_id:7,record_id:99,document_serial:'EXP2026110004',idempotency_key:'actual-auto-key'}};
    },
    async createPlannedExpense(plan){calls.push('CREATE');assert.deepEqual(plan,current.job.plan);if(failCreate)throw Error('Unknown upstream outcome');return {status:'created',company_id:7,record_id:99,document_serial:'EXP2026110004',idempotency_key:'actual-auto-key'};},
    async listTools(){return ['expense__create_expense','expense__get_document','contacts__list','documents__get_creation_status'].map(name=>({name}));}
  });
  const env={FLOWACCOUNT_COMPANY_ID:'7',EXPENSE_GROUP_IDS:'G',EXPENSE_USER_IDS:'U'};
  const gateway=createDirectMcpGateway({env,jobs,createClient,oauth:{status:async()=>({connected:true})}});
  return {gateway,current,calls,preview,env,jobs};
}

test('a known recipient reuses its exact contact from a re-read historical expense without a contact-index search',async()=>{
  const s=gatewayFixture({status:'claimed',documentPatch:{total:999999}});delete s.current.job.plan;
  s.current.config.payeeRules.push({id:'known-vendor',canonicalName:'Demo supplier',aliases:['Demo supplier'],sourceRecords:[99],contactRecordId:99});
  const result=await s.gateway('contacts',{workerId,id:s.current.job.id,search:'Demo supplier'});
  assert.deepEqual(result,{contacts:[{id:'77',name:'Demo supplier'}],hasMore:false});
  assert.equal(s.calls.includes('expense__get_document'),true);
  assert.equal(s.calls.includes('contacts__list'),false);
  assert.equal(s.calls.includes('CREATE'),false);
  const other=gatewayFixture({status:'claimed'});delete other.current.job.plan;
  other.current.config.payeeRules=s.current.config.payeeRules;
  await other.gateway('contacts',{workerId,id:other.current.job.id,search:'Demo'});
  assert.equal(other.calls.includes('contacts__list'),true);
  assert.equal(other.calls.includes('expense__get_document'),false);
});

test('historical contact lookup refuses another company, document, recipient or absent contact id',async()=>{
  for(const documentPatch of [{companyId:8},{recordId:100},{contactName:'Different person'},{contactId:null}]){
    const s=gatewayFixture({status:'claimed',documentPatch});delete s.current.job.plan;
    s.current.config.payeeRules.push({id:'known-vendor',canonicalName:'Demo supplier',aliases:['Demo supplier'],sourceRecords:[99],contactRecordId:99});
    await assert.rejects(s.gateway('contacts',{workerId,id:s.current.job.id,search:'Demo supplier'}),/Historical contact/);
    assert.equal(s.calls.includes('CREATE'),false);
  }
});
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
