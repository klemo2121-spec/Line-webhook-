import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createBrowserJobs } from '../lib/browser-jobs.js';
import { createWorkerEndpoint } from '../api/browser-worker.js';
import { parseLineRequest } from '../lib/receipts.js';

const workerId = '11111111-1111-4111-8111-111111111111';
function setup() {
  let clock = Date.parse('2026-11-03T01:00:00Z'), failSend=false;
  const env={BROWSER_WORKER_ENABLED:'true',EXPENSE_GROUP_IDS:'G',EXPENSE_USER_IDS:'U',FLOWACCOUNT_COMPANY_ID:'7',FLOWACCOUNT_OAUTH_ENCRYPTION_KEY:Buffer.alloc(32,31).toString('base64')};
  const values=new Map(),lists=new Map(),sent=[],published=[];
  const prefix='line-expenses:browser:v1:';
  async function redis([cmd,...a]) {
    if(cmd==='PUBLISH'){published.push(a);return 1;}
    if(cmd==='GET')return values.get(a[0])??null;
    if(cmd==='SET'){if(a.includes('NX')&&values.has(a[0]))return null;values.set(a[0],a[1]);return 'OK';}
    if(cmd==='DEL'){let n=0;for(const k of a){n+=values.delete(k)?1:0;}return n;}
    if(cmd==='LLEN')return (lists.get(a[0])||[]).length;
    if(cmd==='LINDEX')return (lists.get(a[0])||[])[Number(a[1])]??null;
    if(cmd==='LREM'){const list=lists.get(a[0])||[];const filtered=list.filter(v=>v!==a[2]);lists.set(a[0],filtered);return list.length-filtered.length;}
    if(cmd==='EVAL') {
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
  const jobs=createBrowserJobs({env,redis,now:()=>clock,downloadLineImage:async id=>{downloadCount++;return {contentType:'image/jpeg',base64:Buffer.from('original-'+id).toString('base64')};},send:async(...args)=>{if(failSend)throw Error('LINE unavailable');sent.push(args);}});
  const image=(id='1',userId='U')=>({type:'message',source:{groupId:'G',userId},message:{type:'image',id,quoteToken:'quote-'+id}});
  const text=(text,extra={})=>({type:'message',source:{groupId:'G',userId:'U'},message:{type:'text',id:'t'+Math.random(),text,...extra}});
  const work=(action,data={})=>jobs.work(action,{workerId,...data});
  const plan=id=>({id,plan:{companyId:'7',month:'2026-11',bucket:'online',date:'2026-11-30',beforeTotal:0,afterTotal:250,status:'awaiting',paid:0,receipt:{kind:'receipt',readable:true,vendor:'Office supplier',invoiceNumber:'INV1',date:'2026-11-02',currency:'THB',total:250,description:'Office supplies',expenseOnly:true,category:'General expenses',bucket:'online',withholding:0,uncertainties:[]}}});
  const evidence=id=>({id,evidence:{companyId:'7',serial:'EXP2026110002',recordId:'222',date:'2026-11-30',status:'awaiting',paid:0,total:250,marker:`[LINE:${id}]`}});
  return {env,values,lists,sent,published,jobs,image,text,work,plan,evidence,prefix,downloads:()=>downloadCount,failSend:v=>{failSend=v;},advance:n=>{clock+=n;}};
}
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
