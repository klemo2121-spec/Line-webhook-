import { createHash, randomUUID } from 'node:crypto';
import { enabled, readReceipt, flowRequest, categoriesFromEnv, validateReceipt } from './receipts.js';
import { parseMonthInstruction, monthEnd, monthName } from './months.js';
const hash = v => createHash('sha256').update(v).digest('hex');
const csv = v => (v || '').split(',').map(x => x.trim()).filter(Boolean);
const prefix = 'line-expenses:v2:';
const locks = prefix + 'writer-lock';
const json = v => typeof v === 'string' ? JSON.parse(v) : v;
const categoryKeys = ['systemCode','categoryId','nameLocal','nameForeign','creditId','creditCode','creditCategory','creditNameLocal','creditNameForeign','debitId','debitCode','debitCategory','debitNameLocal','debitNameForeign'];

export function parseBucket(text) {
  if (/קופה\s*קטנה|petty\s*cash|เงินสดย่อย/i.test(text)) return 'petty_cash';
  if (/אונליין|שופי|לאזדה|online|shopee|lazada/i.test(text)) return 'online';
  if (/חשמל|electricity|pea\b|ค่าไฟ/i.test(text)) return 'electricity';
  return null;
}
export function monthlyPayload(month, bucket, receipts, categories, profile) {
  const groups = { petty_cash: 'Petty cash box', online: 'Online shopping', electricity: 'PEA ( Electricity Chiang Mai )' };
  const items = receipts.map(r => ({
    ...Object.fromEntries(categoryKeys.map(k => [k, categories[r.receipt.category]?.[k]])),
    description: `${r.receipt.description || r.receipt.vendor} ${r.receipt.date} [LINE:${r.id}]`,
    quantity: 1, pricePerUnit: r.receipt.total, total: r.receipt.total, unitName: 'receipt',
  }));
  const total = Math.round(items.reduce((sum, i) => sum + i.total, 0) * 100) / 100;
  if (profile !== 'gross_no_input_vat') throw new Error('Configure the existing gross expense recording policy');
  return {
    contactName: `${groups[bucket]} (${monthName(month)} ${month.slice(0,4)})`,
    publishedOn: monthEnd(month), dueDate: monthEnd(month), creditType: 1, creditDays: 0,
    expenseCategoryView: 3, isVat: false, isVatInclusive: false, useInlineVat: false,
    documentShowWithholdingTax: false, documentWithholdingTaxPercentage: 0, documentWithholdingTaxAmount: 0,
    subTotal: total, totalAfterDiscount: total, vatAmount: 0, grandTotal: total, discountAmount: 0, discountPercentage: 0,
    reference: `LINE-MONTH-${month}-${bucket}`, items,
    internalNotes: 'LINE monthly expenses. Gross amounts; no input VAT claimed. Payments recorded separately.',
  };
}

export function receiptErrors(receipt, categories) {
  // Existing company records use gross/no-input-VAT totals. This is a configured
  // booking policy, not an OCR conclusion that the receipt itself has no VAT.
  const gross = { ...receipt, net: receipt.total, vat: 0, taxTreatment: 'no_vat', withholding: receipt.withholding ?? 0, invoiceNumber: receipt.invoiceNumber || 'not-printed' };
  return validateReceipt(gross, categories);
}

async function receiptRedis(command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('Receipt storage unavailable');
  return data.result;
}

export function createMonthlyHandler({ redis = receiptRedis, flow = flowRequest, extract = readReceipt, downloadLineImage, replyText, now = () => new Date() }) {
  const get = async key => { const v = await redis(['GET', prefix + key]); return v ? json(v) : null; };
  const set = (key, value) => redis(['SET', prefix + key, JSON.stringify(value)]);
  const scope = event => hash(`${event.source.groupId}:${event.source.userId}`).slice(0,24);
  const saveReceipt = r => set(`receipt:${r.id}`, r);
  const allReceipts = async () => (await redis(['HVALS', prefix + 'ledger'])).map(json);
  const ledger = r => redis(['HSET', prefix + 'ledger', r.id, JSON.stringify(r)]);

  async function acknowledge(record,event) {
    if (!record.quoteToken) {
      await replyText(event.replyToken, `התיעוד הושלם במסמך ${record.serial || record.documentId}, אך LINE לא סיפק קישור לתמונה ולכן לא נשלח אישור 👍🏻 ללא ציטוט.`);
      return;
    }
    await replyText(event.replyToken, '👍🏻', [], record.quoteToken);
  }

  async function attach(record, documentId) {
    if (record.attachedTo === documentId) return;
    const image = await get(`image:${record.id}`);
    if (!image) throw new Error('Original image expired; attach it manually');
    const type = image.contentType;
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(image.base64, 'base64')], { type }), `${record.kind || 'receipt'}-${record.id}.${type === 'image/png' ? 'png' : 'jpg'}`);
    await flow(`/expenses/${documentId}/attachment`, { method: 'POST', body: form });
    record.attachedTo = documentId;
    await saveReceipt(record);
    // Keep original for seven days so a month correction can attach it to the destination.
  }

  async function discover(month, bucket) {
    const bindings = JSON.parse(process.env.FLOWACCOUNT_MONTHLY_DOCUMENTS_JSON || '{}');
    const boundId = bindings[`${month}:${bucket}`];
    if (boundId) return Number(boundId);
    const names = { petty_cash: /petty\s*cash\s*box/i, online: /online\s*shopping/i, electricity: /pea|electricity/i };
    let page = 1, matches = [];
    while (page <= 25) {
      const result = await flow(`/expenses?currentPage=${page}&pageSize=100`);
      const data = result.data;
      if (!Array.isArray(data?.list)) throw new Error('Cannot verify existing monthly documents');
      for (const d of data.list) {
        if (String(d.publishedOn || '').slice(0,7) === month && names[bucket].test(d.contactName || '')) matches.push(d.recordId);
      }
      const count = data.list.length;
      if (count < 100 || (Number.isFinite(data.count) && page * 100 >= data.count)) break;
      page++;
    }
    if (page > 25) throw new Error('Too many documents to safely discover the monthly document; configure its ID');
    if (matches.length > 1) throw new Error('Multiple matching monthly documents; configure the intended ID');
    return matches[0] || null;
  }

  async function plan(month, bucket, records, categories) {
    const key = `month:${month}:${bucket}`;
    const state = await get(key) || {};
    if (state.unknown) throw new Error(`Previous write has unknown outcome (${state.reference}); check FlowAccount before unlocking`);
    const id = state.id || await discover(month, bucket);
    const desired = records.filter(r => r.month === month && r.bucket === bucket && r.kind !== 'payment_slip');
    const payload = monthlyPayload(month, bucket, desired, categories, process.env.FLOWACCOUNT_RECORDING_POLICY);
    let before = null;
    if (id) {
      const response = await flow(`/expenses/${id}`);
      before = response.data;
      if (!before || !Array.isArray(before.items)) throw new Error('Unsupported expense response; existing document left unchanged');
      const status = String(before.statusString || before.status).toLowerCase();
      if (!['awaiting','1'].includes(status)) throw new Error(`Monthly document ${before.documentSerial || id} is already approved/paid; saved for review without changing it`);
      // Only edit documents owned by this integration. Existing paid/legacy records
      // are never rewritten from a guessed schema or have payments removed.
      if (before.reference !== payload.reference) throw new Error(`Existing monthly document ${before.documentSerial || id} requires manual review; no duplicate document created`);
      if (before.useInlineVat === true || before.useInlineDiscount === true || before.isVat === true || Number(before.documentWithholdingTaxAmount || 0) !== 0 || Number(before.discountAmount || 0) !== 0) throw new Error('Monthly tax/discount policy changed; manual review required');
      const nonBotItems = before.items.filter(i => !/\[LINE:[a-f0-9]{24}\]/.test(i.description || ''));
      if (nonBotItems.length) throw new Error('Monthly document contains manual lines; saved for review to preserve existing entries');
      if (state.fingerprint && hash(JSON.stringify(before.items)) !== state.fingerprint) throw new Error('Monthly document changed outside the bot; review before syncing');
      payload.contactName = before.contactName;
      payload.expenseStructureType = 'UpdateExpenseSimpleDocument';
    }
    if (!id && !desired.length) return null;
    // Removing the final line is not supported by the expense API. Do not void or
    // delete the existing monthly document as a side effect of a month correction.
    if (id && !desired.length) return { key, state, id, payload, before, empty: true };
    return { key, state, id, payload, before };
  }

  async function writePlan(p) {
    p.state.unknown = true; p.state.reference = p.payload.reference;
    await set(p.key, p.state); // Crash/timeout after this point blocks repeat writes.
    const response = await flow(p.id ? `/expenses/${p.id}` : '/expenses', {
      method: p.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p.payload),
    });
    const id = response.data?.recordId || p.id;
    if (!id) throw new Error('FlowAccount did not return a document ID');
    const verified = await flow(`/expenses/${id}`);
    if (!Array.isArray(verified.data?.items) || verified.data.reference !== p.payload.reference || verified.data.items.length !== p.payload.items.length || verified.data.items.some((item,i) => item.description !== p.payload.items[i].description || Math.abs(Number(item.total) - p.payload.items[i].total) > 0.011) || Math.abs(Number(verified.data.grandTotal) - p.payload.grandTotal) > 0.011) throw new Error('Could not verify monthly document after writing');
    p.state = { id, serial: verified.data.documentSerial, reference: p.payload.reference, unknown: false, fingerprint: hash(JSON.stringify(verified.data.items)) };
    await set(p.key, p.state);
    return p.state;
  }

  async function sync(record, previous, categories) {
    const owner = randomUUID();
    if (!await redis(['SET', locks, owner, 'NX'])) throw new Error('Expense writer is busy or awaiting recovery. Receipt saved; use expense sync later.');
    let uncertain = false;
    try {
      const records = await allReceipts();
      const targets = previous && (previous.month !== record.month || previous.bucket !== record.bucket)
        ? [[previous.month,previous.bucket],[record.month,record.bucket]] : [[record.month,record.bucket]];
      // Preflight both sides before moving a receipt, avoiding changes to locked months.
      const plans = [];
      for (const [month,bucket] of targets) plans.push(await plan(month,bucket,records,categories));
      if (plans[0]?.empty) {
        if (plans.length !== 2 || plans[1]?.id || !plans[1]) throw new Error('Moving the final receipt into an existing monthly document requires manual correction');
        const source = plans[0], target = plans[1];
        target.id = source.id;
        target.payload.expenseStructureType = 'UpdateExpenseSimpleDocument';
        source.state.unknown = true; source.state.reference = target.payload.reference; await set(source.key,source.state);
        uncertain = true;
        const relocated = await writePlan(target);
        await redis(['DEL',prefix + source.key]);
        uncertain = false;
        record.documentId = relocated.id; record.serial = relocated.serial; record.syncedMonth = record.month; record.syncedBucket = record.bucket; record.status = 'registered';
        await saveReceipt(record); await ledger(record);
        try { await attach(record,relocated.id); } catch { record.status = 'attachment_pending'; await saveReceipt(record); }
        return relocated;
      }
      let result;
      for (const p of plans.filter(Boolean)) {
        uncertain = true;
        result = await writePlan(p);
        uncertain = false;
      }
      if (result?.id) {
        record.documentId = result.id; record.serial = result.serial; record.syncedMonth = record.month; record.syncedBucket = record.bucket; record.status = 'registered';
        await saveReceipt(record); await ledger(record);
        try { await attach(record,result.id); }
        catch { record.status = 'attachment_pending'; await saveReceipt(record); await ledger(record); }
      }
      return result;
    } finally {
      // A permanent lock is intentional on unknown write outcomes. Operator must
      // reconcile with FlowAccount before recovery; never retry blindly.
      if (!uncertain) await redis(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", '1', locks, owner]);
    }
  }

  async function register(record, previous, categories, event) {
    await saveReceipt(record); await ledger(record);
    if (process.env.FLOWACCOUNT_WRITE_ENABLED !== 'true') {
      record.status = 'preview'; await saveReceipt(record);
      await replyText(event.replyToken, `מצב בדיקה בלבד — נשמרה קבלה לחודש ${record.month}, ${record.bucket}. לא נרשמה הוצאה ב־FlowAccount.`);
      return;
    }
    try {
      const company = await flow('/company/info');
      if (String(company.data?.companyId) !== process.env.FLOWACCOUNT_COMPANY_ID) throw new Error('FlowAccount company does not match the configured company');
      const live = await flow('/expenses/categories/business');
      const matches = (node, c) => node && typeof node === 'object' && ((String(node.categoryId) === String(c.categoryId) && String(node.systemCode) === String(c.systemCode) && String(node.debitId) === String(c.debitId) && String(node.creditId) === String(c.creditId)) || Object.values(node).some(v => typeof v === 'object' && matches(v,c)));
      for (const c of Object.values(categories)) if (!matches(live.data,c)) throw new Error('Expense category no longer matches FlowAccount');
      if (record.kind === 'payment_slip') {
        const state = await get(`month:${record.month}:${record.bucket}`);
        const id = state?.id || await discover(record.month, record.bucket);
        if (!id) throw new Error('לא נמצא מסמך חודשי לצירוף הסליפ. שלח קודם את הקבלה ופרטי ההוצאה.');
        await attach(record,id); record.status = 'attached'; record.documentId = id; await saveReceipt(record);
        await acknowledge(record,event);
        return;
      }
      if (record.documentId && record.syncedMonth === record.month && record.syncedBucket === record.bucket && record.status === 'attachment_pending') {
        await attach(record,record.documentId); record.status = 'registered'; await saveReceipt(record);
        await acknowledge(record,event); return;
      }
      const source = record.syncedMonth ? { month: record.syncedMonth, bucket: record.syncedBucket } : previous?.documentId ? previous : null;
      await sync(record,source,categories);
      if (record.status === 'attachment_pending') await replyText(event.replyToken, 'ההוצאה נרשמה, אך התמונה לא צורפה. כתוב expense sync לניסיון צירוף נוסף.');
      else await acknowledge(record,event);
    } catch (error) {
      record.status = 'needs_review'; record.error = error.message; await saveReceipt(record);
      await replyText(event.replyToken, `הקבלה נשמרה לבדיקה עבור ${record.month}. איני יכול לאשר שהרישום הושלם.\n${error.message}\nאין ליצור שוב לפני בדיקה ב־FlowAccount.`);
    }
  }

  return async function handle(event) {
    if (!enabled() || event.type !== 'message' || !csv(process.env.EXPENSE_GROUP_IDS).includes(event.source?.groupId)) return false;
    const imageMessage = event.message?.type === 'image';
    const text = event.message?.type === 'text' ? event.message.text.trim() : '';
    const month = parseMonthInstruction(text, now());
    const bucket = parseBucket(text);
    const command = /^(?:expense\s+(?:sync|status|help)|עזרה\s*הוצאות)$/i.test(text);
    const instruction = !!month && /צרף|צירוף|שייך|שייכ|תוסיף|הוסף|תעביר|העבר|לחודש|לחודש|לאוקטובר|לנובמבר|לדצמבר|attach|add|move|month|เดือน/i.test(text);
    if (!imageMessage && !command && !instruction && !bucket) return false;
    if (!csv(process.env.EXPENSE_USER_IDS).includes(event.source?.userId)) {
      await replyText(event.replyToken, 'המשתמש הזה אינו מורשה לרשום הוצאות.'); return true;
    }
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN || !process.env.FLOWACCOUNT_COMPANY_ID) throw new Error('Configure receipt storage and FlowAccount company ID');
    const userScope = scope(event);
    const categories = categoriesFromEnv();
    const context = await get(`context:${userScope}`) || {};
    if (!imageMessage) {
      if (/help|עזרה/i.test(text)) {
        await replyText(event.replyToken, 'שלח קבלה אחת בכל תמונה. היא תירשם במסמך החודשי לפי תאריך הקבלה.\nלפני או אחרי התמונה: ״צרף את זה לחודש שעבר״, ״לחודש 2026-10״, ״הוסף לקניות אונליין״.\nexpense status — מצב הקבלה האחרונה\nexpense sync — סנכרון חוזר כשאין תוצאה לא ודאית\nסליפ מצורף למסמך בלבד ואינו רושם הוצאה או תשלום נוסף.'); return true;
      }
      const quoted = event.message?.quotedMessageId;
      const id = quoted ? hash(`${event.source.groupId}:${quoted}`).slice(0,24) : context.lastId;
      const last = id ? await get(`receipt:${id}`) : null;
      if (quoted && !last) { await replyText(event.replyToken, 'לא מצאתי קבלה שמורה להודעה המצוטטת.'); return true; }
      if (/status/i.test(text)) {
        await replyText(event.replyToken, last ? `${last.status} · ${last.month || '?'} · ${last.bucket || '?'}\n${last.serial || ''}\n${last.error || ''}` : 'טרם התקבלה קבלה מהמשתמש הזה בקבוצה.'); return true;
      }
      if (/sync/i.test(text)) {
        if (!last || last.errors?.length || !last.month || !last.bucket) { await replyText(event.replyToken, 'חסרים פרטים בקבלה. שלח קבלה מלאה וברורה.'); return true; }
        await register(last,null,categories,event); return true;
      }
      // "הבאה"/next explicitly targets the next upload. Without a previous receipt
      // a month/category instruction also applies to the next upload for one hour.
      const next = /הבא|next|ถัดไป/i.test(text) || !last;
      if (next) {
        context.next = { month: month || null, bucket: bucket || null, until: now().getTime() + 3600000 };
        await set(`context:${userScope}`, context);
        await replyText(event.replyToken, `התמונה הבאה תשויך ל־${month || 'חודש הקבלה'}${bucket ? `, ${bucket}` : ''}. ההוראה תקפה לשעה.`); return true;
      }
      if (last.userId !== event.source.userId) { await replyText(event.replyToken, 'אפשר לשנות רק קבלה ששלחת בעצמך.'); return true; }
      const previous = { ...last };
      if (month) last.month = month;
      if (bucket) last.bucket = bucket;
      last.errors = last.kind === 'payment_slip' ? [] : receiptErrors(last.receipt,categories);
      if (!last.bucket) last.errors.push('Missing monthly group');
      if (!last.month) last.errors.push('Missing month');
      if (last.errors?.length) { await replyText(event.replyToken, `עדכנתי את השיוך, אך חסרים פרטים: ${last.errors.join(', ')}`); await saveReceipt(last); return true; }
      // The date printed on the receipt remains unchanged when selecting a booking month.
      await register(last,previous,categories,event); return true;
    }
    const id = hash(`${event.source.groupId}:${event.message.id}`).slice(0,24);
    if (await get(`receipt:${id}`)) { await replyText(event.replyToken, 'התמונה הזאת כבר נקלטה. כתוב expense status לבדיקת המצב.'); return true; }
    const image = await downloadLineImage(event.message.id);
    if (!['image/jpeg','image/png'].includes(image.contentType) || Buffer.from(image.base64,'base64').length > 8 * 1024 * 1024) { await replyText(event.replyToken, 'שלח JPEG או PNG עד 8 MB.'); return true; }
    const receipt = await extract(image,categories);
    if (receipt.kind === 'cashier_report') return false;
    const next = context.next?.until > now().getTime() ? context.next : {};
    const errors = receipt.kind === 'payment_slip' ? (receipt.readable === true ? [] : ['Unclear payment slip']) : receiptErrors(receipt,categories);
    const record = { id, quoteToken: event.message.quoteToken, kind: receipt.kind, userId: event.source.userId, groupId: event.source.groupId, messageId: event.message.id, receipt, errors,
      month: next.month || (receipt.date || '').slice(0,7) || null,
      bucket: next.bucket || receipt.bucket || null, status: 'received', createdAt: now().toISOString() };
    if (!['petty_cash','online','electricity'].includes(record.bucket)) record.errors.push('צריך לציין קופה קטנה / קניות אונליין / חשמל');
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(record.month || '')) record.errors.push('חסר חודש לרישום');
    const identity = hash(JSON.stringify([receipt.vendor,receipt.invoiceNumber,receipt.date,receipt.total]));
    const imageHash = hash(Buffer.from(image.base64,'base64'));
    const claimed = await redis(['EVAL', "for i,k in ipairs(KEYS) do if redis.call('EXISTS',k)==1 then return 0 end end for i,k in ipairs(KEYS) do redis.call('SET',k,ARGV[1]) end return 1", '2', prefix + `dedup:image:${imageHash}`, prefix + `dedup:${receipt.kind}:${identity}`, id]);
    if (!claimed) { await replyText(event.replyToken, 'ייתכן שזו קבלה כפולה — לא נוצר רישום נוסף.'); return true; }
    await redis(['SET', prefix + `image:${id}`, JSON.stringify(image), 'EX','604800']);
    await saveReceipt(record);
    context.lastId = id; delete context.next; await set(`context:${userScope}`,context);
    if (record.errors.length) { record.status = 'needs_review'; await saveReceipt(record); await replyText(event.replyToken, `התמונה נשמרה; לא נרשמה הוצאה.\n${record.errors.join('\n')}`); return true; }
    await register(record,null,categories,event); return true;
  };
}
