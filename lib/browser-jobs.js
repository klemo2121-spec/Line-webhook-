import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createExpenseStore } from './expense-store.js';
import { parseMonthInstruction, monthEnd } from './months.js';
import { parseBucket } from './monthly-expenses.js';
import { validateArchiveEvidence } from './archive-evidence.js';
import {buildDirectExpensePlan,validateRecognitionConfig,verifyDirectEvidence} from './direct-expense-policy.js';

const defaultPrefix = 'line-expenses:browser:v1:';
const sha = value => createHash('sha256').update(value).digest('hex');
const csv = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const allowedCategories = new Set(['General expenses', 'Messenger/Postage', 'Electricity']);
const money = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && Math.abs(n * 100 - Math.round(n * 100)) < 0.001;

export function createBrowserJobs({ env = process.env, redis = createExpenseStore({ env }), downloadLineImage, send = async () => {}, now = Date.now, storagePrefix = defaultPrefix } = {}) {
  const prefix = storagePrefix;
  if (!/^line-expenses:browser:[a-zA-Z0-9:-]+:$/.test(prefix)) throw Error('Invalid storage namespace');
  function seal(value) {
    const key = Buffer.from(env.FLOWACCOUNT_OAUTH_ENCRYPTION_KEY || '', 'base64');
    if (key.length !== 32) throw Error('Configure private job encryption');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(prefix));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  }
  function open(value) {
    if (!value) return null;
    const key = Buffer.from(env.FLOWACCOUNT_OAUTH_ENCRYPTION_KEY || '', 'base64'), bytes = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(prefix)); cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
  }
  const get = async name => open(await redis(['GET', prefix + name]));
  const put = (name, value, ttl) => redis(['SET', prefix + name, seal(value), ...(ttl ? ['EX', String(ttl)] : [])]);
  async function locked(fn) {
    const owner = randomUUID(), key = prefix + 'coordinator';
    if (!await redis(['SET', key, owner, 'NX', 'EX', '45'])) throw Error('Queue is busy; retry shortly');
    try { return await fn(); }
    finally { await redis(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", '1', key, owner]); }
  }
  const jobId = (group, message) => sha(`${group}:${message}`).slice(0, 24);
  const contextId = actor => sha(`${actor.groupId}:${actor.userId}`).slice(0, 24);
  function checkOwner(job, actor) { if (!job || job.groupId !== actor.groupId || job.userId !== actor.userId) throw Error('Receipt is not owned by this sender'); }
  async function enqueue(job, image, contextKey, context) {
    if (await redis(['LLEN', prefix + 'pending']) >= 20) throw Error('תור ההוצאות מלא. לא נרשמה הוצאה; נסה שוב לאחר שהמחשב יטפל בתור.');
    // Reserve encrypted-image bytes, removing expired reservations first. Bound
    // this feature below the free database capacity, including base64 overhead.
    const packed = seal(image), expires = now() + 604800000;
    const reserve = "local old=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); for _,id in ipairs(old) do local n=tonumber(redis.call('HGET',KEYS[2],id) or '0'); redis.call('DECRBY',KEYS[3],n); redis.call('HDEL',KEYS[2],id); redis.call('ZREM',KEYS[1],id); end; local used=tonumber(redis.call('GET',KEYS[3]) or '0'); if used+tonumber(ARGV[4])>104857600 then return 0 end; redis.call('ZADD',KEYS[1],ARGV[2],ARGV[3]); redis.call('HSET',KEYS[2],ARGV[3],ARGV[4]); redis.call('INCRBY',KEYS[3],ARGV[4]); return 1";
    if (!await redis(['EVAL', reserve, '3', prefix + 'image-expiry', prefix + 'image-sizes', prefix + 'image-bytes', String(now()), String(expires), job.id, String(packed.length)])) throw Error('אחסון התמונות מלא; לא נוצרה הוצאה.');
    // Publish the image, job, dedup marker, queue entry and sender context
    // together. A crash cannot leave an accepted receipt outside the queue.
    await redis(['EVAL', "redis.call('SET',KEYS[1],ARGV[1],'EX','604800'); redis.call('SET',KEYS[2],ARGV[2]); redis.call('RPUSH',KEYS[3],ARGV[3]); redis.call('SET',KEYS[4],ARGV[3]); redis.call('SET',KEYS[5],ARGV[4]); return 1", '5', prefix + `image:${job.id}`, prefix + `job:${job.id}`, prefix + 'pending', prefix + `dedup:image:${job.imageHash}`, prefix + contextKey, packed, seal(job), job.id, seal(context)]);
  }
  async function intake(event) {
    if (env.BROWSER_WORKER_ENABLED !== 'true' || event.type !== 'message') return false;
    const actor = event.source || {};
    if (!csv(env.EXPENSE_GROUP_IDS).includes(actor.groupId)) return false;
    const type = event.message?.type, text = type === 'text' ? event.message.text.trim() : '';
    const month = parseMonthInstruction(text, new Date(now())), bucket = parseBucket(text);
    const command = /^expense\s+(status|sync|help)$/i.exec(text);
    // Free-text answers are accepted only for this owner's outstanding question.
    if (type !== 'image' && type !== 'text') return false;
    if (!csv(env.EXPENSE_USER_IDS).includes(actor.userId)) return true;
    const contextKey = `context:${contextId(actor)}`;
    if (type !== 'image') {
      return locked(async () => {
        const context = await get(contextKey) || {};
        const quoted=event.message.quotedMessageId;
        const questionLink=quoted?await get(`question:${sha(`${actor.groupId}:${quoted}`)}`):null;
        const target = quoted ? questionLink?.jobId||jobId(actor.groupId,quoted) : context.lastId;
        const job = target ? await get(`job:${target}`) : null;
        if (!month && !bucket && !command && job?.status !== 'awaiting_info') return false;
        if (command?.[1].toLowerCase() === 'help') {
          const individual=(await get('direct_policy'))?.enabled===true;
          await send(actor.groupId, individual?'שלח קבלה אחת בתמונה. כל קבלה נרשמת כהוצאה נפרדת באנגלית; התמונה המקורית נשארת ב־LINE בינתיים. אפשר להוסיף ״לחודש שעבר״. expense status מציג מצב.':'שלח קבלה אחת בתמונה. הוראות: ״לחודש שעבר״, ״קניות אונליין״, ״קופה קטנה״, ״חשמל״.\nהטיפול מתבצע כשהמחשב והדפדפן זמינים. expense status מציג מצב.', null); return true;
        }
        if (command) {
          if (job) checkOwner(job, actor);
          await send(actor.groupId, job ? `מצב הקבלה: ${job.status}\n${job.evidence?.serial || ''}\n${job.reason || ''}` : 'אין קבלה שמורה למשתמש הזה.', null); return true;
        }
        if (job && !/הבא|next|ถัดไป/i.test(text)) {
          checkOwner(job, actor);
          if (job.status === 'awaiting_info' && !job.plan) {
            if ((job.answers || []).some(answer=>answer.messageId===event.message.id)) return true;
            job.answers=[...(job.answers || []).slice(-9),{messageId:event.message.id,text:text.slice(0,1000),createdAt:now()}];
            job.override={...job.override,...(month?{month}:{}),...(bucket?{bucket}:{})};
            if(bucket)job.confirmedExpense={bucket,purpose:text.slice(0,1000),source:'owner_line',createdAt:now()};
            job.status='queued';delete job.reason;
            if(await redis(['LLEN',prefix+'pending'])>=20)throw Error('תור ההוצאות מלא; ההבהרה טרם הוחזרה לטיפול.');
            await redis(['EVAL',"redis.call('SET',KEYS[1],ARGV[1]); redis.call('RPUSH',KEYS[2],ARGV[2]); return 1",'2',prefix+`job:${job.id}`,prefix+'pending',seal(job),job.id]);
            await redis(['PUBLISH',prefix+'wake','clarification']).catch(()=>{});
            return true;
          }
          if (job.status !== 'queued' && !(job.workflow==='mcp_individual_v1'&&job.status==='claimed'&&!job.plan)) {
            await send(actor.groupId, 'הקבלה כבר בטיפול או נרשמה. התיקון נשמר לבדיקה; לא תיווצר הוצאה נוספת.', null);
            await put(`correction:${job.id}:${event.message.id}`, { jobId:job.id, month, bucket, createdAt:now(), status:'needs_review' }); return true;
          }
          job.override = { ...job.override, ...(month ? { month } : {}), ...(bucket ? { bucket } : {}) };
          await put(`job:${job.id}`,job);
          await send(actor.groupId, `עודכן שיוך הקבלה${month ? ` לחודש ${month}` : ''}.`, null); return true;
        }
        if (event.message.quotedMessageId) { await send(actor.groupId, 'הקבלה המצוטטת אינה בתור.', null); return true; }
        context.next = { month, bucket, purpose:text.slice(0,1000), until:now() + 3600000 };
        await put(contextKey, context);
        await send(actor.groupId, `התמונה הבאה תשויך ל־${month || 'חודש הקבלה'}${bucket ? `, ${bucket}` : ''}. ההוראה תקפה לשעה.`, null); return true;
      });
    }
    const id = jobId(actor.groupId, event.message.id);
    if (await get(`job:${id}`)) return true;
    if (!event.message.quoteToken) { await send(actor.groupId, 'LINE לא סיפק קישור לציטוט התמונה. לא נוצרה הוצאה.', null); return true; }
    const image = await downloadLineImage(event.message.id);
    if (!['image/jpeg','image/png'].includes(image.contentType) || Buffer.from(image.base64, 'base64').length > 3 * 1024 * 1024) {
      await send(actor.groupId, 'שלח JPEG או PNG עד 3 MB. לא נוצרה הוצאה.', null); return true;
    }
    return locked(async () => {
      if (await get(`job:${id}`)) return true;
      const imageHash = sha(Buffer.from(image.base64, 'base64'));
      if (await redis(['GET', prefix + `dedup:image:${imageHash}`])) { await send(actor.groupId, 'התמונה כבר נקלטה; לא נוצר רישום נוסף.', null); return true; }
      const context = await get(contextKey) || {};
      const override = context.next?.until > now() ? context.next : {};
      const job = { id, groupId:actor.groupId, userId:actor.userId, messageId:event.message.id, quoteToken:event.message.quoteToken, status:'queued', override, imageHash, filename:`line-${id}.${image.contentType === 'image/png' ? 'png' : 'jpg'}`, createdAt:now(), ackKey:randomUUID() };
      if(override.bucket&&override.purpose)job.confirmedExpense={bucket:override.bucket,purpose:override.purpose,source:'owner_line',createdAt:now()};
      context.lastId = id; delete context.next;
      await enqueue(job,image,contextKey,context);
      // The durable queue is authoritative; reconnecting subscribers recover missed wakes.
      await redis(['PUBLISH', prefix + 'wake', 'receipt']).catch(() => {});
      return true;
    });
  }
  async function acknowledge(job) {
    if (job.status !== 'completed' || job.acknowledged) return;
    await send(job.groupId, '👍🏻', job.quoteToken, job.ackKey);
    job.acknowledged = true; await put(`job:${job.id}`,job);
  }
  async function work(action, input = {}) {
    return locked(async () => {
      if (!/^[a-f0-9-]{36}$/.test(input.workerId || '')) throw Error('Invalid worker identity');
      if(action==='inspect'){
        if(!/^[a-f0-9]{24}$/.test(input.id||''))throw Error('Invalid receipt ID');
        const job=await get(`job:${input.id}`);if(!job)throw Error('Receipt not found');
        const corrections=[];let cursor='0';
        for(let n=0;n<5;n++){
          const result=await redis(['SCAN',cursor,'MATCH',prefix+`correction:${job.id}:*`,'COUNT','50']);cursor=String(result[0]);
          for(const key of result[1]){const correction=open(await redis(['GET',key]));if(correction)corrections.push(correction);}
          if(cursor==='0')break;
        }
        return {id:job.id,status:job.status,override:job.override,answers:job.answers||[],corrections,reason:job.reason,hasPlan:!!job.plan};
      }
      const active = parse(await redis(['GET', prefix + 'active']));
      const directPolicy=await get('direct_policy');
      if(action==='direct_rules')return {config:directPolicy||null};
      if(action==='direct_configure'){
        if(active)throw Error('Reconcile the active job before changing recording mode');
        validateRecognitionConfig(input.config,env.FLOWACCOUNT_COMPANY_ID);
        for(const id of (input.config.previouslyRecordedJobIds||[]).slice(0,20)){
          if(!/^[a-f0-9]{24}$/.test(id))throw Error('Invalid previously recorded job');
          const old=await get(`job:${id}`),r=old?.plan?.receipt;
          if(old?.status!=='completed'||!r)throw Error('Legacy receipt must already be completed');
          if(r.invoiceNumber)await redis(['SET',prefix+'dedup:reference:'+sha(JSON.stringify([String(r.invoiceNumber).trim().toUpperCase(),r.date,r.total])),id]);
        }
        await put('direct_policy',{...input.config,enabled:true,configuredAt:now()});
        return {configured:true,mode:'one_expense_per_receipt',payees:input.config.payeeRules.length};
      }
      if(['claim','plan','write_started','saved','complete','confirm_expense'].includes(action)&&directPolicy?.enabled===true)throw Error('Browser recording is disabled in individual MCP mode');
      if(action.startsWith('direct_')&&directPolicy?.enabled!==true)throw Error('Individual MCP recording has not been configured');
      if(action==='confirm_expense'){
        if(active)throw Error('Another task is active; reconcile first');
        const job=await get(`job:${input.id}`),p=job?.plan,e=job?.evidence;
        if(job?.status!=='completed'||p?.receipt?.kind!=='payment_slip'||!e||p.beforeTotal!==p.afterTotal||job.attachmentOnlyCompletion)throw Error('Only a completed attachment-only bank proof can be confirmed once');
        if(input.bucket!==p.bucket||!String(input.ownerInstruction||'').trim())throw Error('Owner expense purpose and original bucket are required');
        if(!await get(`image:${job.id}`))throw Error('Original image expired');
        if(await redis(['LLEN',prefix+'pending'])>=20)throw Error('Queue is full');
        job.attachmentOnlyCompletion={plan:p,evidence:e,acknowledged:job.acknowledged,completedAt:job.completedAt};
        job.confirmedExpense={bucket:p.bucket,purpose:String(input.ownerInstruction).slice(0,1000),source:'owner_chat',createdAt:now()};
        job.override={...job.override,bucket:p.bucket};
        job.status='queued';delete job.plan;delete job.evidence;delete job.completedAt;delete job.acknowledged;job.ackKey=randomUUID();
        await redis(['EVAL',"redis.call('SET',KEYS[1],ARGV[1]); redis.call('RPUSH',KEYS[2],ARGV[2]); return 1",'2',prefix+`job:${job.id}`,prefix+'pending',seal(job),job.id]);
        await redis(['PUBLISH',prefix+'wake','expense_confirmation']).catch(()=>{});return {queued:job.id};
      }
      if (action === 'claim'||action==='direct_claim') {
        if (active && active.workerId !== input.workerId) throw Error('Another worker owns the queue');
        const id = active?.id || await redis(['LINDEX', prefix + 'pending', '0']);
        if (!id) return { idle:true };
        const job = await get(`job:${id}`);
        if (!job) throw Error('Queue record missing; manual recovery required');
        if (job.status === 'completed') {
          await acknowledge(job);
          await redis(['LREM', prefix + 'pending', '0', id]); await redis(['DEL', prefix + 'active']); return { completed:id };
        }
        if (job.status === 'needs_review') return { blocked:true, id, reason:job.reason };
        if(job.status==='awaiting_info'&&job.infoQuestion){
          await deliverQuestion(job);
          await redis(['LREM',prefix+'pending','0',id]);await redis(['DEL',prefix+'active']);
          return {awaitingInfo:id};
        }
        if(action==='direct_claim'){
          if(job.plan&&job.workflow!=='mcp_individual_v1')return {blocked:true,id,reason:'Earlier financial write requires reconciliation'};
          if(!job.plan){job.workflow='mcp_individual_v1';job.attachmentMode='line_original_only';}
        }
        await redis(['SET', prefix + 'active', JSON.stringify({ id, workerId:input.workerId })]);
        if (job.status === 'queued') { job.status = 'claimed'; await put(`job:${id}`,job); }
        const image = await get(`image:${id}`);
        if (!image) throw Error('Original image expired; do not write');
        return { job, image, companyId:env.FLOWACCOUNT_COMPANY_ID, companyRef:env.FLOWACCOUNT_COMPANY_REFERENCE };
      }
      if(action==='resume_info'){
        if(active)throw Error('Another task is active; retry after reconciliation');
        const job=await get(`job:${input.id}`);
        if(job?.status!=='awaiting_info'||job.plan||!['online','petty_cash','electricity'].includes(input.bucket))throw Error('Only untouched clarification can resume');
        job.override={...job.override,bucket:input.bucket};job.answers=[...(job.answers||[]).slice(-9),{text:String(input.ownerInstruction||'').slice(0,1000),createdAt:now(),origin:'owner_chat'}];
        job.status='queued';delete job.reason;
        await redis(['EVAL',"redis.call('SET',KEYS[1],ARGV[1]); redis.call('RPUSH',KEYS[2],ARGV[2]); return 1",'2',prefix+`job:${job.id}`,prefix+'pending',seal(job),job.id]);
        await redis(['PUBLISH',prefix+'wake','clarification']).catch(()=>{});return {queued:job.id};
      }
      if (!active || active.workerId !== input.workerId || active.id !== input.id) throw Error('Job is not owned by this worker');
      const job = await get(`job:${input.id}`);
      if(action.startsWith('direct_')){
        if(job.workflow!=='mcp_individual_v1')throw Error('Job belongs to a different workflow');
        if(action==='direct_context')return {job,config:directPolicy,companyId:env.FLOWACCOUNT_COMPANY_ID};
        if(action==='direct_plan'){
          if(job.status!=='claimed'||job.plan)throw Error('Individual expense cannot be replanned');
          const expected=buildDirectExpensePlan(input.receipt,{companyId:env.FLOWACCOUNT_COMPANY_ID,job},directPolicy,input.existingContact);
          if(input.preview?.valid!==true||Number(input.preview.total)!==expected.total)throw Error('A matching MCP preview is required');
          const r=expected.receipt,identity=sha(JSON.stringify([r.kind,r.vendor,r.invoiceNumber||r.transactionId||'',r.date,r.total]));
          const duplicate=await redis(['GET',prefix+`dedup:receipt:${identity}`]);
          if(duplicate&&duplicate!==job.id)throw Error('Possible duplicate receipt; review before creating');
          const refs=[r.invoiceNumber,r.transactionId].filter(ref=>ref&&String(ref).trim().length>=4);
          for(const ref of refs){const key=prefix+'dedup:reference:'+sha(JSON.stringify([String(ref).trim().toUpperCase(),r.date,r.total]));const prior=await redis(['GET',key]);if(prior&&prior!==job.id)throw Error('Receipt reference is already recorded');}
          for(const ref of refs)await redis(['SET',prefix+'dedup:reference:'+sha(JSON.stringify([String(ref).trim().toUpperCase(),r.date,r.total])),job.id]);
          await redis(['SET',prefix+`dedup:receipt:${identity}`,job.id]);job.plan=expected;job.status='planned';
        }else if(action==='direct_write_started'){
          if(job.status!=='planned')throw Error('Create already started; reconcile before retrying');job.status='writing';
        }else if(action==='direct_created'){
          const c=input.creation;
          if(job.status!=='writing'||String(c?.companyId)!==env.FLOWACCOUNT_COMPANY_ID||!/^\d+$/.test(String(c.recordId||''))||!/^EXP\d{10}$/.test(c.serial||''))throw Error('Invalid direct-create result');
          if(job.creation&&(String(job.creation.recordId)!==String(c.recordId)||job.creation.serial!==c.serial))throw Error('A different create result is already recorded');
          job.creation={companyId:String(c.companyId),recordId:String(c.recordId),serial:c.serial,idempotencyKey:typeof c.idempotencyKey==='string'?c.idempotencyKey.slice(0,256):null};
        }else if(action==='direct_submitted'){
          if(job.status!=='writing'||typeof input.idempotencyKey!=='string'||!input.idempotencyKey||input.idempotencyKey.length>256)throw Error('Invalid pending submission');
          if(job.submissionKey&&job.submissionKey!==input.idempotencyKey)throw Error('Another submission is already recorded');
          job.submissionKey=input.idempotencyKey;
        }else if(action==='direct_saved'){
          if(!['writing','saved'].includes(job.status))throw Error('Missing direct-create marker');
          if(job.creation&&(String(input.evidence?.recordId)!==job.creation.recordId||input.evidence?.serial!==job.creation.serial))throw Error('Read back the exact created document');
          job.evidence=verifyDirectEvidence(job.plan,input.evidence);job.status='saved';
        }else if(action==='direct_complete'){
          if(!['saved','completed'].includes(job.status)||input.documentVerified!==true||job.attachmentMode!=='line_original_only')throw Error('Individual expense must be independently verified');
          verifyDirectEvidence(job.plan,job.evidence);job.status='completed';job.completedAt=now();
          await put(`job:${job.id}`,job);await acknowledge(job);
          await redis(['LREM',prefix+'pending','0',job.id]);await redis(['DEL',prefix+'active']);
          return {completed:job.id,serial:job.evidence.serial,attachmentMode:'line_original_only'};
        }else throw Error('Unknown individual expense action');
        await put(`job:${job.id}`,job);return {id:job.id,status:job.status,plan:job.plan,creation:job.creation};
      }
      if (action === 'plan') {
        if (!['claimed','needs_review'].includes(job.status) || job.plan) throw Error('Job cannot be replanned after a write');
        const p = input.plan, r = p?.receipt;
        if (!r || !['receipt','payment_slip'].includes(r.kind) || !r.readable || r.currency !== 'THB' || !money(r.total) || r.total <= 0 || !/^20\d\d-\d\d-\d\d$/.test(r.date || '') || new Date(`${r.date}T00:00:00Z`).toISOString().slice(0,10) !== r.date || !r.vendor || r.uncertainties?.length) throw Error('Receipt needs review');
        if (r.kind === 'receipt' && (r.expenseOnly !== true || !allowedCategories.has(r.category) || Number(r.withholding || 0) !== 0 || !r.description)) throw Error('Expense category/purpose needs review');
        if(r.sourceKind==='payment_slip'){
          if(r.kind!=='receipt'||r.ownerConfirmedExpense!==true||!job.confirmedExpense||job.confirmedExpense.bucket!==p.bucket)throw Error('Bank-proof expense requires explicit owner purpose');
          const previous=job.attachmentOnlyCompletion;
          if(previous&&(p.serial!==previous.evidence.serial||['total','date','currency','vendor','invoiceNumber'].some(key=>r[key]!==previous.plan.receipt[key])))throw Error('Confirmed expense must preserve original slip and document');
        }
        const month = job.override.month || r.date.slice(0,7), bucket = job.override.bucket || r.bucket;
        if (!['online','petty_cash','electricity'].includes(bucket)) throw Error('Monthly group needs review');
        if (p.companyId !== env.FLOWACCOUNT_COMPANY_ID || p.month !== month || p.bucket !== bucket || p.date !== monthEnd(month)) throw Error('Wrong company/month/group');
        if (!money(p.beforeTotal) || !money(p.afterTotal) || Math.abs(p.afterTotal - p.beforeTotal - (r.kind === 'receipt' ? r.total : 0)) > 0.011 || p.status !== 'awaiting' || Number(p.paid) !== 0) throw Error('Unsafe document state or totals');
        if (r.kind === 'payment_slip' && !/^EXP\d{10}$/.test(p.serial || '')) throw Error('A bank slip requires an existing expense document');
        const identity = sha(JSON.stringify([r.sourceKind||r.kind,r.vendor,r.invoiceNumber || '',r.date,r.total]));
        const duplicate = await redis(['GET',prefix + `dedup:receipt:${identity}`]);
        if (duplicate && duplicate !== job.id) throw Error('Possible duplicate receipt; review before writing');
        await redis(['SET',prefix + `dedup:receipt:${identity}`,job.id]);
        job.plan = { ...p, marker:`[LINE:${job.id}]`, filename:job.filename }; job.status = 'planned';
      } else if (action === 'write_started') {
        if (job.status !== 'planned') throw Error('Write already started; reconcile the UI before continuing');
        job.status = 'writing';
      } else if (action === 'saved') {
        if (!['writing','saved'].includes(job.status)) throw Error('Missing write marker');
        const e = input.evidence, p = job.plan;
        if (e?.companyId !== env.FLOWACCOUNT_COMPANY_ID || !/^EXP\d{10}$/.test(e.serial || '') || !/^\d+$/.test(String(e.recordId || '')) || e.date !== p.date || e.status !== 'awaiting' || Number(e.paid) !== 0 || !money(e.total) || Math.abs(e.total - p.afterTotal) > 0.011 || (p.serial && e.serial !== p.serial) || (p.receipt.kind === 'receipt' && e.marker !== p.marker)) throw Error('Saved document evidence does not match plan');
        job.evidence = e; job.status = 'saved';
      } else if (action === 'archive_prepared') {
        if (job.status !== 'saved') throw Error('Save and verify the document before preparing its ZIP');
        const archive = validateArchiveEvidence(input.archive, job);
        if (job.archive && job.archive.sha256 !== archive.sha256) throw Error('Previous ZIP upload has an uncertain outcome; reconcile first');
        job.archive = archive;
      } else if (action === 'complete') {
        if (!['saved','completed'].includes(job.status)) throw Error('Document is not verified');
        if (input.attachmentVerified !== true || input.reopened !== true) throw Error('Original image must be verified after reopening the document');
        if (job.archive) {
          validateArchiveEvidence(job.archive, job);
          if (input.filename !== job.archive.filename || input.archiveSha256 !== job.archive.sha256 || input.archiveContentsVerified !== true || input.downloadedAfterReopen !== true) throw Error('Download the saved ZIP and verify all original image bytes before completion');
        } else if (input.filename !== job.filename) throw Error('Original image must be verified after reopening the document');
        job.status = 'completed'; job.completedAt = now();
        await put(`job:${job.id}`,job); // Persist before sending: retries never recreate an expense.
        await acknowledge(job);
        await redis(['LREM',prefix + 'pending','0',job.id]); await redis(['DEL',prefix + 'active']);
        return { completed:job.id,serial:job.evidence.serial };
      } else if (action === 'request_info') {
        if(!['claimed','needs_review'].includes(job.status)||job.plan)throw Error('Uncertain financial writes require reconciliation');
        if(input.bucket){if(!['online','petty_cash','electricity'].includes(input.bucket))throw Error('Invalid reviewed group');job.override={...job.override,bucket:input.bucket};}
        if((job.infoRound||0)>=3)throw Error('Clarification limit reached; manual review required');
        job.infoRetryKey=randomUUID();job.infoRound=(job.infoRound||0)+1;
        job.status='awaiting_info';job.reason='A purchase receipt with details is required';await put(`job:${job.id}`,job);
        const directQuestions={identity:'מי המקבל שמופיע בסליפ?',purpose:'מה מטרת ההוצאה?',classification:'מה מטרת ההוצאה?',month:'לאיזה חודש לרשום את ההוצאה?',date:'מה תאריך הקבלה?',amount:'מה סכום ההוצאה?'};
        const question=job.workflow==='mcp_individual_v1'?(directQuestions[input.question]||directQuestions.classification):input.question==='existing_document'?'לא מצאתי מסמך הוצאות קיים לחודש ולשיוך של הסליפ. לאיזה חודש ולגבי איזו הוצאה הוא שייך?':'מה נקנה ולאיזה חודש ושיוך לרשום את ההוצאה — קניות אונליין, קופה קטנה או חשמל? אפשר לענות כאן בציטוט לתמונה. לא ארשום תשלום.';
        job.infoQuestion=question;job.infoDelivered=false;await put(`job:${job.id}`,job);
        await deliverQuestion(job);
        await redis(['LREM',prefix+'pending','0',job.id]);await redis(['DEL',prefix+'active']);return {awaitingInfo:job.id};
      } else if (action === 'reject_non_receipt') {
        if(job.status!=='needs_review'||job.plan||input.imageHash!==job.imageHash)throw Error('Only an untouched verified non-receipt may leave review');
        job.status='rejected_non_receipt';job.rejectedAt=now();
        await put(`job:${job.id}`,job);
        await redis(['LREM',prefix+'pending','0',job.id]);await redis(['DEL',prefix+'active']);
        return {rejected:job.id};
      } else if (action === 'dismiss') {
        if (job.status !== 'needs_review' || job.plan || input.reason !== 'user_confirmed_no_action') throw Error('Only an untouched reviewed job may be dismissed');
        job.status = 'dismissed'; job.reason = input.reason; job.dismissedAt = now();
        await put(`job:${job.id}`,job);
        await redis(['LREM',prefix + 'pending','0',job.id]); await redis(['DEL',prefix + 'active']);
        return { dismissed:job.id };
      } else if (action === 'fail') {
        job.reason = String(input.reason || 'Needs review').slice(0,250);
        // Never unlock an uncertain write or automatically replay it.
        job.status = 'needs_review';
      } else throw Error('Unknown worker action');
      await put(`job:${job.id}`,job);
      return { id:job.id,status:job.status,plan:job.plan,archive:job.archive };
    });
  }
  async function deliverQuestion(job){
    if(job.infoDelivered)return;
    const sent=await send(job.groupId,job.infoQuestion,job.quoteToken,job.infoRetryKey);
    for(const message of sent?.sentMessages||[]){
      if(typeof message.id==='string')await put(`question:${sha(`${job.groupId}:${message.id}`)}`,{jobId:job.id},604800);
    }
    job.infoDelivered=true;await put(`job:${job.id}`,job);
  }
  return { intake, work };
}
