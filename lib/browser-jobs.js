import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createExpenseStore } from './expense-store.js';
import { parseMonthInstruction, monthEnd } from './months.js';
import { parseBucket } from './monthly-expenses.js';
import { validateArchiveEvidence } from './archive-evidence.js';

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
    if (type !== 'image' && !month && !bucket && !command) return false;
    if (!csv(env.EXPENSE_USER_IDS).includes(actor.userId)) return true;
    const contextKey = `context:${contextId(actor)}`;
    if (type !== 'image') {
      return locked(async () => {
        const context = await get(contextKey) || {};
        const target = event.message.quotedMessageId ? jobId(actor.groupId, event.message.quotedMessageId) : context.lastId;
        const job = target ? await get(`job:${target}`) : null;
        if (command?.[1].toLowerCase() === 'help') {
          await send(actor.groupId, 'שלח קבלה אחת בתמונה. הוראות: ״לחודש שעבר״, ״קניות אונליין״, ״קופה קטנה״, ״חשמל״.\nהטיפול מתבצע כשהמחשב והדפדפן זמינים. expense status מציג מצב.', null); return true;
        }
        if (command) {
          if (job) checkOwner(job, actor);
          await send(actor.groupId, job ? `מצב הקבלה: ${job.status}\n${job.evidence?.serial || ''}\n${job.reason || ''}` : 'אין קבלה שמורה למשתמש הזה.', null); return true;
        }
        if (job && !/הבא|next|ถัดไป/i.test(text)) {
          checkOwner(job, actor);
          if (job.status !== 'queued') {
            await send(actor.groupId, 'הקבלה כבר בטיפול או נרשמה. התיקון נשמר לבדיקה; לא תיווצר הוצאה נוספת.', null);
            await put(`correction:${job.id}:${event.message.id}`, { jobId:job.id, month, bucket, createdAt:now(), status:'needs_review' }); return true;
          }
          job.override = { ...job.override, ...(month ? { month } : {}), ...(bucket ? { bucket } : {}) };
          await put(`job:${job.id}`,job);
          await send(actor.groupId, `עודכן שיוך הקבלה${month ? ` לחודש ${month}` : ''}.`, null); return true;
        }
        if (event.message.quotedMessageId) { await send(actor.groupId, 'הקבלה המצוטטת אינה בתור.', null); return true; }
        context.next = { month, bucket, until:now() + 3600000 };
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
      const active = parse(await redis(['GET', prefix + 'active']));
      if (action === 'claim') {
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
        await redis(['SET', prefix + 'active', JSON.stringify({ id, workerId:input.workerId })]);
        if (job.status === 'queued') { job.status = 'claimed'; await put(`job:${id}`,job); }
        const image = await get(`image:${id}`);
        if (!image) throw Error('Original image expired; do not write');
        return { job, image, companyId:env.FLOWACCOUNT_COMPANY_ID, companyRef:env.FLOWACCOUNT_COMPANY_REFERENCE };
      }
      if (!active || active.workerId !== input.workerId || active.id !== input.id) throw Error('Job is not owned by this worker');
      const job = await get(`job:${input.id}`);
      if (action === 'plan') {
        if (!['claimed','needs_review'].includes(job.status) || job.plan) throw Error('Job cannot be replanned after a write');
        const p = input.plan, r = p?.receipt;
        if (!r || !['receipt','payment_slip'].includes(r.kind) || !r.readable || r.currency !== 'THB' || !money(r.total) || r.total <= 0 || !/^20\d\d-\d\d-\d\d$/.test(r.date || '') || new Date(`${r.date}T00:00:00Z`).toISOString().slice(0,10) !== r.date || !r.vendor || r.uncertainties?.length) throw Error('Receipt needs review');
        if (r.kind === 'receipt' && (r.expenseOnly !== true || !allowedCategories.has(r.category) || Number(r.withholding || 0) !== 0 || !r.description)) throw Error('Expense category/purpose needs review');
        const month = job.override.month || r.date.slice(0,7), bucket = job.override.bucket || r.bucket;
        if (!['online','petty_cash','electricity'].includes(bucket)) throw Error('Monthly group needs review');
        if (p.companyId !== env.FLOWACCOUNT_COMPANY_ID || p.month !== month || p.bucket !== bucket || p.date !== monthEnd(month)) throw Error('Wrong company/month/group');
        if (!money(p.beforeTotal) || !money(p.afterTotal) || Math.abs(p.afterTotal - p.beforeTotal - (r.kind === 'receipt' ? r.total : 0)) > 0.011 || p.status !== 'awaiting' || Number(p.paid) !== 0) throw Error('Unsafe document state or totals');
        if (r.kind === 'payment_slip' && !/^EXP\d{10}$/.test(p.serial || '')) throw Error('A bank slip requires an existing expense document');
        const identity = sha(JSON.stringify([r.kind,r.vendor,r.invoiceNumber || '',r.date,r.total]));
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
        if(!job.infoRetryKey)job.infoRetryKey=randomUUID();
        job.status='awaiting_info';job.reason='A purchase receipt with details is required';await put(`job:${job.id}`,job);
        await send(job.groupId,'לא הצלחתי לזהות קבלה עם פרטי רכישה בתמונה. לא נרשמה הוצאה. שלח בבקשה קבלה/חשבונית שמפרטת את הרכישה; הוראות כמו ״קניות אונליין״ ו״לחודש שעבר״ אפשר לשלוח לפני התמונה הבאה.',job.quoteToken,job.infoRetryKey);
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
  return { intake, work };
}
