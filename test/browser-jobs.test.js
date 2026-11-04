import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createBrowserJobs } from '../lib/browser-jobs.js';
import { createWorkerEndpoint } from '../api/browser-worker.js';
import { parseLineRequest } from '../lib/receipts.js';
import {directConfig,directReceipt} from './direct-expense-fixture.js';

const workerId = '11111111-1111-4111-8111-111111111111';
function setup() {
  let clock = Date.parse('2026-11-03T01:00:00Z'), failSend=false,sendResponse;
  const env={BROWSER_WORKER_ENABLED:'true',EXPENSE_GROUP_IDS:'G',EXPENSE_USER_IDS:'U',FLOWACCOUNT_COMPANY_ID:'7',FLOWACCOUNT_OAUTH_ENCRYPTION_KEY:Buffer.alloc(32,31).toString('base64')};
  const values=new Map(),lists=new Map(),sent=[],published=[],downloadAliases=new Map(),waits=[];let onWait;
  const prefix='line-expenses:browser:v1:';
  async function redis([cmd,...a]) {
    if(cmd==='PUBLISH'){published.push(a);return 1;}
    if(cmd==='SCAN')return ['0',[]];
    if(cmd==='GET')return values.get(a[0])??null;
    if(cmd==='SET'){if(a.includes('NX')&&values.has(a[0]))return null;values.set(a[0],a[1]);return 'OK';}
    if(cmd==='DEL'){let n=0;for(const k of a){n+=values.delete(k)?1:0;}return n;}
    if(cmd==='LLEN')return (lists.get(a[0])||[]).length;
    if(cmd==='LINDEX')return (lists.get(a[0])||[])[Number(a[1])]??null;
    if(cmd==='LREM'){const list=lists.get(a[0])||[];const filtered=list.filter(v=>v!==a[2]);lists.set(a[0],filtered);return list.length-filtered.length;}
    if(cmd==='EVAL') {
      if(a[1]==='4'){values.set(a[2],a[6]);lists.set(a[3],[...(lists.get(a[3])||[]),a[7]]);values.set(a[4],a[7]);values.set(a[5],a[8]);return 1;}
      if(a[1]==='2'){values.set(a[2],a[4]);lists.set(a[3],[...(lists.get(a[3])||[]),a[5]]);return 1;}
      if(a[1]==='3')return 1; // image-budget reservation; tested against real Redis separately.
      if(a[1]==='5') {
        const k=a.slice(2,7),v=a.slice(7);
        values.set(k[0],v[0]);values.set(k[1],v[1]);lists.set(k[2],[...(lists.get(k[2])||[]),v[2]]);values.set(k[3],v[2]);values.set(k[4],v[3]);return 1;
      }
      if(values.get(a[2])===a[3]){values.delete(a[2]);return 1;}return 0;
    }
    throw Error('Unexpected Redis operation '+cmd);
  }
  let downloadCount=0;
  const jobs=createBrowserJobs({env,redis,now:()=>clock,wait:async ms=>{waits.push(ms);await onWait?.();},downloadLineImage:async id=>{downloadCount++;return {contentType:'image/jpeg',base64:Buffer.from('original-'+(downloadAliases.get(id)||id)).toString('base64')};},send:async(...args)=>{if(failSend)throw Error('LINE unavailable');sent.push(args);return sendResponse;}});
  const image=(id='1',userId='U')=>({type:'message',source:{groupId:'G',userId},message:{type:'image',id,quoteToken:'quote-'+id}});
  const text=(text,extra={})=>({type:'message',source:{groupId:'G',userId:'U'},message:{type:'text',id:'t'+Math.random(),text,...extra}});
  const work=(action,data={})=>jobs.work(action,{workerId,...data});
  const plan=id=>({id,plan:{companyId:'7',month:'2026-11',bucket:'online',date:'2026-11-30',beforeTotal:0,afterTotal:250,status:'awaiting',paid:0,receipt:{kind:'receipt',readable:true,vendor:'Office supplier',invoiceNumber:'INV1',date:'2026-11-02',currency:'THB',total:250,description:'Office supplies',expenseOnly:true,category:'General expenses',bucket:'online',withholding:0,uncertainties:[]}}});
  const evidence=id=>({id,evidence:{companyId:'7',serial:'EXP2026110002',recordId:'222',date:'2026-11-30',status:'awaiting',paid:0,total:250,marker:`[LINE:${id}]`}});
  return {env,values,lists,sent,published,jobs,image,text,work,plan,evidence,prefix,waits,onWait:fn=>{onWait=fn;},sameImageAs:(id,prior)=>downloadAliases.set(id,prior),downloads:()=>downloadCount,failSend:v=>{failSend=v;},sendResponse:v=>{sendResponse=v;},advance:n=>{clock+=n;}};
}

test('a quoted owner purpose is captured quietly before the bot asks, on queued or claimed originals',async()=>{
  const s=setup();await s.work('direct_configure',{config:directConfig()});
  await s.jobs.intake(s.image('first'));await s.jobs.intake(s.image('second'));
  const caption=s.text('CO2',{quotedMessageId:'first'});
  await s.jobs.intake(caption);await s.jobs.intake(caption);
  const {job}=await s.work('direct_claim');assert.equal(job.messageId,'first');assert.equal(job.override.purpose,'CO2');assert.equal(job.answers.length,1);
  await s.jobs.intake(s.text('Fertilizers',{quotedMessageId:'first'}));
  const latest=(await s.work('direct_context',{id:job.id})).job;
  assert.equal(latest.override.purpose,'Fertilizers');assert.equal(latest.contextVersion,2);assert.equal(s.sent.length,0);
});

test('stale questions and plans restart from the owner caption without asking or saving a stale plan',async()=>{
  const s=setup();await s.work('direct_configure',{config:directConfig()});await s.jobs.intake(s.image('caption-race'));
  const {job}=await s.work('direct_claim');await s.jobs.intake(s.text('Rent',{quotedMessageId:job.messageId}));
  assert.deepEqual(await s.work('request_info',{id:job.id,question:'purpose',contextVersion:0}),{retry:true});
  assert.deepEqual(await s.work('direct_plan',{id:job.id,receipt:directReceipt(),preview:{valid:true,total:250},contextVersion:0}),{retry:true});
  assert.equal((await s.work('inspect',{id:job.id})).hasPlan,false);assert.equal(s.sent.length,0);
});

test('a new upload of the same untouched parked image resumes its original job once and accepts captions on the new photo',async()=>{
  const s=setup();await s.work('direct_configure',{config:directConfig()});await s.jobs.intake(s.image('original'));
  const {job}=await s.work('direct_claim');await s.work('request_info',{id:job.id,question:'purpose'});s.sent.length=0;
  s.sameImageAs('resent','original');await s.jobs.intake(s.image('resent'));const downloads=s.downloads();await s.jobs.intake(s.image('resent'));
  assert.equal(s.downloads(),downloads);assert.equal(s.sent.length,0);
  await s.jobs.intake(s.text('Fertilizers',{quotedMessageId:'resent'}));
  const resumed=await s.work('direct_claim');assert.equal(resumed.job.id,job.id);assert.equal(resumed.job.messageId,'resent');assert.equal(resumed.job.quoteToken,'quote-resent');
  assert.equal(resumed.job.override.purpose,'Fertilizers');assert.equal(resumed.job.sourceHistory[0].messageId,'original');
  assert.equal(s.lists.get(s.prefix+'pending').length,1);
  await s.work('direct_plan',{id:job.id,receipt:directReceipt(),preview:{valid:true,total:250}});await s.work('direct_write_started',{id:job.id});
  s.sameImageAs('another','original');await s.jobs.intake(s.image('another'));
  assert.equal((await s.work('inspect',{id:job.id})).status,'writing');assert.equal(s.lists.get(s.prefix+'pending').length,1);
});

test('temporary lock contention retries acquisition before capturing a caption, without repeating its mutation',async()=>{
  const s=setup();await s.work('direct_configure',{config:directConfig()});await s.jobs.intake(s.image('busy'));
  s.values.set(s.prefix+'coordinator','another-owner');s.onWait(()=>{if(s.waits.length===2)s.values.delete(s.prefix+'coordinator');});
  await s.jobs.intake(s.text('CO2',{quotedMessageId:'busy'}));
  assert.equal(s.waits.length,2);const {job}=await s.work('direct_claim');assert.equal(job.answers.length,1);assert.equal(job.override.purpose,'CO2');assert.equal(s.sent.length,0);
});

test('individual MCP workflow needs explicit photo policy, blocks browser writes and acknowledges only verified records',async()=>{
  const s=setup();await assert.rejects(s.work('direct_claim'),/not been configured/);
  await s.work('direct_configure',{config:directConfig()});
  assert.ok([...s.values.values()].every(v=>!String(v).includes('Alex Example')));
  await assert.rejects(s.work('claim'),/Browser recording is disabled/);
  await s.jobs.intake(s.image('direct'));const {job}=await s.work('direct_claim');
  assert.equal(job.workflow,'mcp_individual_v1');assert.equal(job.status,'claimed');
  await assert.rejects(s.work('direct_plan',{id:job.id,receipt:directReceipt(),preview:{valid:true,total:999}}),/matching MCP preview/);
  const p=await s.work('direct_plan',{id:job.id,receipt:directReceipt(),preview:{valid:true,total:250}});
  await assert.rejects(s.work('direct_complete',{id:job.id,documentVerified:true}),/independently verified/);
  await s.work('direct_write_started',{id:job.id});
  await s.work('direct_created',{id:job.id,creation:{companyId:'7',recordId:'22',serial:'EXP2026110004',idempotencyKey:'test-key'}});
  await assert.rejects(s.work('direct_plan',{id:job.id,receipt:directReceipt(),preview:{valid:true,total:250}}),/cannot be replanned/);
  const evidence={companyId:'7',recordId:'22',serial:'EXP2026110004',date:'2026-11-02',status:'awaiting',paid:0,total:250,reference:p.plan.reference,marker:p.plan.marker,markerCount:1,lineCount:1,categoryId:11,vat:0,withholding:0,discount:0};
  await assert.rejects(s.work('direct_saved',{id:job.id,evidence:{...evidence,recordId:'23'}}),/exact created document/);
  await s.work('direct_saved',{id:job.id,evidence});assert.equal(s.sent.length,0);
  await s.work('direct_complete',{id:job.id,documentVerified:true});
  assert.equal(s.sent.length,1);assert.equal(s.sent[0][1],'👍🏻');assert.equal(s.sent[0][2],job.quoteToken);
  assert.deepEqual(await s.work('direct_claim'),{idle:true});
});

test('individual mode preserves legacy receipts and refuses a rephotographed recorded reference',async()=>{
  const s=setup();await s.jobs.intake(s.image('old'));const {job}=await s.work('claim');
  await s.work('plan',s.plan(job.id));await s.work('write_started',{id:job.id});await s.work('saved',s.evidence(job.id));
  await s.work('complete',{id:job.id,filename:job.filename,attachmentVerified:true,reopened:true});
  await s.work('direct_configure',{config:{...directConfig(),previouslyRecordedJobIds:[job.id]}});
  await s.jobs.intake(s.image('different-photo'));const next=await s.work('direct_claim');
  await assert.rejects(s.work('direct_plan',{id:next.job.id,receipt:{...directReceipt(),vendor:'Different OCR spelling',invoiceNumber:'INV1'},preview:{valid:true,total:250}}),/already recorded/);
});

test('individual worker asks a short question for the missing fact in the original LINE group',async()=>{
  const s=setup();await s.work('direct_configure',{config:directConfig()});await s.jobs.intake(s.image('unknown-payee'));
  const {job}=await s.work('direct_claim');await s.work('request_info',{id:job.id,question:'identity'});
  assert.equal(s.sent.length,1);assert.equal(s.sent[0][0],'G');assert.equal(s.sent[0][1],'מי המקבל שמופיע בסליפ?');assert.equal(s.sent[0][2],job.quoteToken);
  assert.deepEqual(await s.work('direct_claim'),{idle:true});
  await s.jobs.intake(s.text('Casey Example',{quotedMessageId:job.messageId}));
  const resumed=await s.work('direct_claim');assert.equal(resumed.job.id,job.id);assert.equal(resumed.job.answers.at(-1).text,'Casey Example');assert.equal(resumed.job.plan,undefined);
});

test('a reply quoting the bot question resumes its original image after a newer image arrives',async()=>{
  const s=setup();s.sendResponse({sentMessages:[{id:'question-1'}]});
  await s.work('direct_configure',{config:directConfig()});await s.jobs.intake(s.image('older'));
  const {job}=await s.work('direct_claim');await s.work('request_info',{id:job.id,question:'purpose'});
  await s.jobs.intake(s.image('newer'));
  await s.jobs.intake(s.text('Rent',{quotedMessageId:'question-1'}));
  const older=await s.work('inspect',{id:job.id});assert.equal(older.status,'queued');assert.equal(older.answers.at(-1).text,'Rent');
});

test('question delivery failure resumes using the same retry key and never writes accounting',async()=>{
  const s=setup();await s.work('direct_configure',{config:directConfig()});await s.jobs.intake(s.image('question-retry'));
  const {job}=await s.work('direct_claim');s.failSend(true);
  await assert.rejects(s.work('request_info',{id:job.id,question:'identity'}),/LINE unavailable/);
  s.failSend(false);assert.deepEqual(await s.work('direct_claim'),{awaitingInfo:job.id});
  assert.equal(s.sent.length,1);assert.equal(s.sent[0][1],'מי המקבל שמופיע בסליפ?');
  assert.deepEqual(await s.work('direct_claim'),{idle:true});
  assert.equal((await s.work('inspect',{id:job.id})).hasPlan,false);
});

test('month instruction during image reading applies until the immutable plan is stored',async()=>{
  const s=setup();await s.work('direct_configure',{config:directConfig()});await s.jobs.intake(s.image('late-month'));
  const {job}=await s.work('direct_claim');await s.jobs.intake(s.text('לחודש שעבר',{quotedMessageId:job.messageId}));
  const result=await s.work('direct_plan',{id:job.id,receipt:directReceipt(),preview:{valid:true,total:250}});
  assert.equal(result.plan.date,'2026-10-31');
  await s.jobs.intake(s.text('לחודש הזה',{quotedMessageId:job.messageId}));
  assert.equal((await s.work('direct_context',{id:job.id})).job.plan.date,'2026-10-31');
});
test('a real event blocker sends one short notice and preserves an uncertain financial state',async()=>{
  const s=setup();await s.work('direct_configure',{config:directConfig()});await s.jobs.intake(s.image('unknown-write'));
  const {job}=await s.work('direct_claim');await s.work('direct_plan',{id:job.id,receipt:directReceipt(),preview:{valid:true,total:250}});
  await s.work('direct_write_started',{id:job.id});
  await s.work('direct_report_blocked',{id:job.id,reason:'Unknown create outcome'});await s.work('direct_report_blocked',{id:job.id,reason:'Still unknown'});
  assert.equal(s.sent.length,1);assert.equal(s.sent[0][2],job.quoteToken);assert.notEqual(s.sent[0][1],'👍🏻');
  assert.equal((await s.work('inspect',{id:job.id})).status,'writing');
});
test('reviewing a rejected original is read-only; recovery preserves it and cannot requeue twice or touch a plan',async()=>{
  const s=setup();await s.work('direct_configure',{config:directConfig()});await s.jobs.intake(s.image('recover-original'));
  const {job}=await s.work('direct_claim');await s.work('fail',{id:job.id,reason:'Classifier rejected'});await s.work('reject_non_receipt',{id:job.id,imageHash:job.imageHash});
  const review=await s.work('direct_review_rejected',{id:job.id});assert.equal(review.job.id,job.id);assert.equal(review.image.base64,Buffer.from('original-recover-original').toString('base64'));
  assert.deepEqual(await s.work('direct_claim'),{idle:true});
  await assert.rejects(s.work('direct_recover_rejected',{id:job.id,imageHash:'wrong',originalReviewed:true}),/exact original/);
  await s.work('direct_recover_rejected',{id:job.id,imageHash:job.imageHash,originalReviewed:true});
  await assert.rejects(s.work('direct_recover_rejected',{id:job.id,imageHash:job.imageHash,originalReviewed:true}),/untouched rejected/);
  assert.equal((await s.work('direct_claim')).job.id,job.id);
  await s.work('direct_plan',{id:job.id,receipt:directReceipt(),preview:{valid:true,total:250}});
  await assert.rejects(s.work('direct_review_rejected',{id:job.id}),/untouched rejected/);assert.equal(s.sent.length,0);
});

test('owner can register a previously attachment-only slip once, preserving image, amount, document and prior audit',async()=>{
  const s=setup();await s.jobs.intake(s.image('confirmed-slip'));const {job}=await s.work('claim');
  const receipt={...s.plan(job.id).plan.receipt,kind:'payment_slip',total:3924,expenseOnly:false,category:'unknown'};
  const plan={...s.plan(job.id).plan,receipt,beforeTotal:949,afterTotal:949,serial:'EXP2026110001'};
  await s.work('plan',{id:job.id,plan});await s.work('write_started',{id:job.id});
  await assert.rejects(s.work('confirm_expense',{id:job.id,bucket:'online',ownerInstruction:'online business purchases'}),/active/);
  const evidence={...s.evidence(job.id).evidence,serial:plan.serial,total:949};delete evidence.marker;
  await s.work('saved',{id:job.id,evidence});await s.work('complete',{id:job.id,filename:job.filename,attachmentVerified:true,reopened:true});
  await assert.rejects(s.work('confirm_expense',{id:job.id,bucket:'electricity',ownerInstruction:'wrong document'}),/bucket/);
  await s.work('confirm_expense',{id:job.id,bucket:'online',ownerInstruction:'online business purchases'});
  const next=await s.work('claim');assert.equal(next.job.id,job.id);assert.equal(next.job.filename,job.filename);
  assert.equal(next.job.override.bucket,'online');
  assert.equal(next.job.attachmentOnlyCompletion.evidence.total,949);assert.equal(next.job.confirmedExpense.source,'owner_chat');
  const expense={...receipt,kind:'receipt',sourceKind:'payment_slip',ownerConfirmedExpense:true,expenseOnly:true,category:'General expenses'};
  const fixed={...plan,receipt:expense,afterTotal:4873};
  await assert.rejects(s.work('plan',{id:job.id,plan:{...fixed,receipt:{...expense,total:999},afterTotal:1948}}),/preserve original/);
  await s.work('plan',{id:job.id,plan:fixed});await s.work('write_started',{id:job.id});
  await s.work('saved',{id:job.id,evidence:{...evidence,total:4873,marker:`[LINE:${job.id}]`}});
  await s.work('complete',{id:job.id,filename:job.filename,attachmentVerified:true,reopened:true});
  await assert.rejects(s.work('confirm_expense',{id:job.id,bucket:'online',ownerInstruction:'again'}),/only a completed/i);
  assert.deepEqual(await s.work('claim'),{idle:true});assert.equal(s.downloads(),1);
});
test('browser intake is encrypted, allowlisted, deduplicated and silent until verified completion',async()=>{
  const s=setup(); await s.jobs.intake(s.image('x','other'));assert.equal(s.downloads(),0);
  await s.jobs.intake(s.image());assert.equal(s.sent.length,0);
  const active=await s.work('claim');assert.equal(active.image.base64,Buffer.from('original-1').toString('base64'));
  assert.ok([...s.values.values()].every(v=>!String(v).includes('original-1')&&!String(v).includes('quote-1')));
  await s.jobs.intake(s.image());assert.equal(s.downloads(),1);
  assert.deepEqual(s.published,[[s.prefix+'wake','receipt']]);
  await assert.rejects(s.work('complete',{id:active.job.id,filename:active.job.filename,attachmentVerified:true,reopened:true}),/not verified/);
});

test('confirmed untouched review can be dismissed without acknowledgement; uncertain writes remain blocked',async()=>{
  const s=setup();await s.jobs.intake(s.image('review'));const {job}=await s.work('claim');
  await s.work('fail',{id:job.id,reason:'Existing paid document; human confirmed no action'});
  assert.equal((await s.work('claim')).blocked,true);
  assert.deepEqual(await s.work('dismiss',{id:job.id,reason:'user_confirmed_no_action'}),{dismissed:job.id});
  assert.equal(s.sent.length,0);assert.deepEqual(await s.work('claim'),{idle:true});
  await s.jobs.intake(s.image('uncertain'));const next=await s.work('claim');await s.work('plan',s.plan(next.job.id));await s.work('write_started',{id:next.job.id});await s.work('fail',{id:next.job.id,reason:'Unknown save outcome'});
  await assert.rejects(s.work('dismiss',{id:next.job.id,reason:'user_confirmed_no_action'}),/untouched/);
});

test('reviewed non-receipt rejection requires the exact image and cannot discard a financial plan',async()=>{
  const s=setup();await s.jobs.intake(s.image('screenshot'));const {job}=await s.work('claim');await s.work('fail',{id:job.id,reason:'Screenshot, not receipt'});
  await assert.rejects(s.work('reject_non_receipt',{id:job.id,imageHash:'wrong'}),/untouched/);
  assert.deepEqual(await s.work('reject_non_receipt',{id:job.id,imageHash:job.imageHash}),{rejected:job.id});assert.equal(s.sent.length,0);assert.deepEqual(await s.work('claim'),{idle:true});
  await s.jobs.intake(s.image('planned'));const next=await s.work('claim');await s.work('plan',s.plan(next.job.id));await s.work('fail',{id:next.job.id,reason:'Unknown'});
  await assert.rejects(s.work('reject_non_receipt',{id:next.job.id,imageHash:next.job.imageHash}),/untouched/);
});

test('missing purchase details asks in the source LINE group and leaves later receipts processable',async()=>{
  const s=setup();await s.jobs.intake(s.image('unclear'));const {job}=await s.work('claim');
  await s.work('fail',{id:job.id,reason:'Receipt needs review'});await s.work('request_info',{id:job.id});
  assert.equal(s.sent.length,1);assert.equal(s.sent[0][0],'G');assert.equal(s.sent[0][2],'quote-unclear');assert.notEqual(s.sent[0][1],'👍🏻');
  await s.jobs.intake(s.image('next'));const next=await s.work('claim');assert.notEqual(next.job.id,job.id);
  await s.work('plan',s.plan(next.job.id));await s.work('write_started',{id:next.job.id});
  await assert.rejects(s.work('request_info',{id:next.job.id}),/reconciliation/);
});

test('untouched review may receive a validated plan, but uncertain writes cannot be replanned',async()=>{
  const s=setup();await s.jobs.intake(s.image());const {job}=await s.work('claim');await s.work('fail',{id:job.id,reason:'Missing context'});
  await s.work('plan',s.plan(job.id));await s.work('write_started',{id:job.id});await s.work('fail',{id:job.id,reason:'Unknown save'});
  await assert.rejects(s.work('plan',s.plan(job.id)),/replanned/);
});

test('owner clarification resumes the same untouched image once, retains text/month and wakes the worker',async()=>{
  const s=setup();await s.jobs.intake(s.image('ask'));const {job}=await s.work('claim');await s.work('request_info',{id:job.id});
  const answer=s.text('ציוד למשרד לחודש שעבר');await s.jobs.intake(answer);await s.jobs.intake(answer);
  const resumed=await s.work('claim');assert.equal(resumed.job.id,job.id);assert.equal(resumed.job.override.month,'2026-10');assert.equal(resumed.job.answers.length,1);assert.equal(resumed.job.answers[0].text,answer.message.text);
  assert.equal(s.lists.get(s.prefix+'pending').length,1);assert.equal(s.published.at(-1)[1],'clarification');
});
test('free-text question answers are owner-scoped and cannot modify writing/completed jobs',async()=>{
  const s=setup();await s.jobs.intake(s.image('ask'));const {job}=await s.work('claim');await s.work('request_info',{id:job.id});
  const other=s.text('office supplies');other.source.userId='other';await s.jobs.intake(other);assert.deepEqual(await s.work('claim'),{idle:true});
  const answer=s.text('office supplies');await s.jobs.intake(answer);const resumed=await s.work('claim');assert.equal(resumed.job.answers[0].text,'office supplies');
  await s.work('plan',s.plan(job.id));await s.work('write_started',{id:job.id});assert.equal(await s.jobs.intake(s.text('free form change')),false);assert.equal((await s.work('claim')).job.status,'writing');
});
test('operator resume uses existing untouched parked image and cannot race an active task',async()=>{
  const s=setup();await s.jobs.intake(s.image('ask'));const {job}=await s.work('claim');await s.work('request_info',{id:job.id});
  await s.work('resume_info',{id:job.id,bucket:'online',ownerInstruction:'קניות אונליין'});const next=await s.work('claim');assert.equal(next.job.id,job.id);assert.equal(next.job.override.bucket,'online');
  await assert.rejects(s.work('resume_info',{id:job.id,bucket:'online'}),/active/);
});
test('month instructions are evaluated on arrival, scoped and applied before claim',async()=>{
  const s=setup();await s.jobs.intake(s.text('הקבלה הבאה לחודש שעבר'));await s.jobs.intake(s.image());
  const c=await s.work('claim');assert.equal(c.job.override.month,'2026-10');
  await assert.rejects(s.work('plan',s.plan(c.job.id)),/Wrong company\/month/);
  await s.jobs.intake(s.text('לחודש שעבר'));assert.match(s.sent.at(-1)[1],/בדיקה/);
  const again=await s.work('claim');assert.equal(again.job.status,'claimed');
});
test('wrong company, paid documents, slips without existing documents and duplicates cannot start writes',async()=>{
  const s=setup();await s.jobs.intake(s.image());const c=await s.work('claim');const id=c.job.id;
  for(const patch of [{companyId:'8'},{status:'paid'},{paid:1},{afterTotal:251}]) {
    const p=s.plan(id);Object.assign(p.plan,patch);await assert.rejects(s.work('plan',p));
  }
  const slip=s.plan(id);slip.plan.receipt.kind='payment_slip';slip.plan.beforeTotal=250;await assert.rejects(s.work('plan',slip),/existing expense/);
  await s.work('plan',s.plan(id));await s.work('write_started',{id});
  await assert.rejects(s.work('plan',s.plan(id)),/replanned/);
  await assert.rejects(s.jobs.work('claim',{workerId:'22222222-2222-4222-8222-222222222222'}),/Another worker/);
  assert.equal((await s.work('claim')).job.status,'writing'); // no timeout reset/replay
});
test('only reopened saved document plus exact attachment produces quoted thumb; acknowledgement retry never rewrites',async()=>{
  const s=setup();await s.jobs.intake(s.image());const {job}=await s.work('claim'),id=job.id;
  await s.work('plan',s.plan(id));await s.work('write_started',{id});
  const bad=s.evidence(id);bad.evidence.total=249;await assert.rejects(s.work('saved',bad),/evidence/);
  await s.work('saved',s.evidence(id));
  await assert.rejects(s.work('complete',{id,filename:'other.jpg',attachmentVerified:true,reopened:true}),/Original image/);
  s.failSend(true);await assert.rejects(s.work('complete',{id,filename:job.filename,attachmentVerified:true,reopened:true}),/LINE unavailable/);
  s.failSend(false);const retried=await s.work('claim');assert.equal(retried.completed,id);
  assert.deepEqual(s.sent.map(m=>m.slice(0,3)),[['G','👍🏻','quote-1']]);assert.match(s.sent[0][3],/^[a-f0-9-]{36}$/);
  assert.deepEqual(await s.work('claim'),{idle:true});
});
test('worker endpoint refuses invalid credentials before reading jobs; browser-only mode requires LINE signature',async()=>{
  const token='a'.repeat(43),env={BROWSER_WORKER_ENABLED:'true',BROWSER_WORKER_KEY_SHA256:createHash('sha256').update(token).digest('hex')};let called=false;
  const endpoint=createWorkerEndpoint({env,jobs:{work:async()=>{called=true;return {idle:true};}}});
  const res=()=>({setHeader(){},status(n){this.code=n;return this;},json(v){this.value=v;return this;}});
  const bad=res();await endpoint({method:'POST',headers:{authorization:'Bearer '+ 'b'.repeat(43)},body:{action:'claim'}},bad);assert.equal(bad.code,401);assert.equal(called,false);
  const good=res();await endpoint({method:'POST',headers:{authorization:'Bearer '+token},body:{action:'claim'}},good);assert.equal(good.code,200);
  const old={...process.env};try{process.env.BROWSER_WORKER_ENABLED='true';process.env.MCP_CONNECTIONS_ENABLED='false';process.env.RECEIPTS_ENABLED='false';const req=Readable.from(['{"events":[]}']);req.headers={};await assert.rejects(parseLineRequest(req),/signature/);}finally{for(const k of ['BROWSER_WORKER_ENABLED','MCP_CONNECTIONS_ENABLED','RECEIPTS_ENABLED'])if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
});

test('ZIP fallback requires exact original bytes, complete inventory and the same monthly document',async()=>{
  const s=setup();await s.jobs.intake(s.image());let {job}=await s.work('claim');const id=job.id;
  await s.work('plan',s.plan(id));await s.work('write_started',{id});await s.work('saved',s.evidence(id));
  const archive={filename:'line-2026-11-online-'+ 'c'.repeat(12)+'.zip',sha256:'c'.repeat(64),bytes:1024,limitObserved:true,limitReason:'image_count_limit',limitMessage:'Maximum image attachments reached',inventory:['previous.jpg'],manifest:{version:1,scope:{companyId:'7',month:'2026-11',bucket:'online',recordId:'222',serial:'EXP2026110002'},entries:[
    {name:'images/0001-'+ 'b'.repeat(12)+'.jpg',sourceName:'previous.jpg',source:'existing',sha256:'b'.repeat(64),bytes:12},
    {name:'images/0002-'+job.imageHash.slice(0,12)+'.jpg',sourceName:job.filename,source:'current',sha256:job.imageHash,bytes:10},
  ]}};
  for(const mutate of [a=>{a.manifest.scope.month='2026-10';},a=>{a.manifest.scope.recordId='999';},a=>{a.manifest.entries.pop();},a=>{a.manifest.entries[1].sha256='a'.repeat(64);},a=>{a.manifest.entries[0].name='../secret.jpg';},a=>{a.limitObserved=false;},a=>{a.inventory.push('missing.png');},a=>{a.limitReason='network_error';},a=>{a.limitMessage='';}]){
    const bad=structuredClone(archive);mutate(bad);await assert.rejects(s.work('archive_prepared',{id,archive:bad}));
  }
  await s.work('archive_prepared',{id,archive});
  await assert.rejects(s.work('complete',{id,filename:job.filename,attachmentVerified:true,reopened:true}),/Download the saved ZIP/);
  const completion={id,filename:archive.filename,attachmentVerified:true,reopened:true,archiveSha256:archive.sha256,archiveContentsVerified:true,downloadedAfterReopen:true};
  await assert.rejects(s.work('complete',{...completion,archiveContentsVerified:false}),/Download/);
  assert.equal(s.sent.length,0);
  await s.work('complete',completion);assert.equal(s.sent[0][1],'👍🏻');assert.equal(s.sent[0][2],'quote-1');
});
