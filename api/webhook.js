// api/webhook.js
// LINE Translator + Cashier Bot

const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';
const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

// Cashier LINE group
const CASHIER_GROUP_ID = 'C1035c01c8ae9076c1a3dc98132c64de5';

// Upstash
const UPSTASH_REDIS_REST_URL =
  'https://proud-bluejay-78256.upstash.io';

const UPSTASH_REDIS_REST_TOKEN =
  'gQAAAAAAATGwAAIgcDEzYmE2NjgxN2U4MTM0ODAwYTEyMTg4MGJhNDFhODgyZQ';


// Secret used by the external scheduler.
const CRON_SECRET = 'mcm-yelXWbVPa-1NygUniWYsDT3o4yohdKdR';
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const action = String(req.query?.action || '').trim();
    const key = String(req.query?.key || '').trim();

    if (action) {
      if (key !== CRON_SECRET) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }

      try {
        const result = await runScheduledReminder(action);
        return res.status(200).json({ ok: true, result });
      } catch (error) {
        console.error('Scheduled reminder error:', error);
        return res.status(500).json({
          ok: false,
          error: error?.message || 'Reminder failed',
        });
      }
    }

    return res.status(200).send('OK');
  }

  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  try {
    const events = Array.isArray(req.body?.events)
      ? req.body.events
      : [];

    for (const event of events) {
      try {
        await handleEvent(event);
      } catch (error) {
        console.error('Event error:', error);

        if (event.replyToken) {
          await replyText(
            event.replyToken,
            'Something went wrong. Please try again.'
          ).catch(() => {});
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({ ok: false });
  }
}

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source?.groupId || '';
  const messageType = event.message?.type || '';

  console.log('LINE event:', {
    groupId,
    userId: event.source?.userId,
    messageType,
  });

  if (groupId === CASHIER_GROUP_ID) {
    await handleCashierMessage(event);
    return;
  }

  if (messageType === 'text') {
    await handleTranslation(event);
  }
}

/* =========================================================
   CASHIER
========================================================= */

async function handleCashierMessage(event) {
  const type = event.message?.type;

  if (type === 'image') {
    await handleCashierScreenshot(event);
    return;
  }

  if (type !== 'text') return;

  const originalText = event.message?.text?.trim() || '';
  const text = originalText.toLowerCase().trim();

  if (!text) return;

  if (text === 'help' || text === '/help') {
    await replyText(event.replyToken, cashierHelp());
    return;
  }

  if (text === 'status') {
    await sendCashierStatus(event);
    return;
  }

  if (text === 'reset') {
    await resetCurrentCycle(event);
    return;
  }

  if (
    text === 'reset shortage' ||
    text === 'reset difference' ||
    text === 'clear shortage'
  ) {
    await resetDifference(event);
    return;
  }

  const cashOutAmount = parseCommandAmount(
    originalText,
    /^(?:cash\s*out|cashout|out)\s*[:=-]?\s*/i
  );

  if (cashOutAmount !== null) {
    await addCashOut(event, cashOutAmount);
    return;
  }

  const floatAmount = parseCommandAmount(
    originalText,
    /^(?:float|opening\s*cash|start\s*cash)\s*[:=-]?\s*/i
  );

  if (floatAmount !== null) {
    await setOpeningFloat(event, floatAmount);
    return;
  }

  const countAmount = parseCountAmount(originalText);

  if (countAmount !== null) {
    await saveCountedCash(event, countAmount);
    return;
  }

  await replyText(
    event.replyToken,
    [
      'Command not recognized.',
      '',
      'Examples:',
      'count 12500',
      'cash out 500',
      'float 1000',
      'status',
      'reset',
      'reset shortage',
    ].join('\n')
  );
}

async function handleCashierScreenshot(event) {
  const image = await downloadLineImage(event.message.id);
  const context = getCashierContext();
  const screenshot = await readCashFromScreenshot(
    image,
    context.reportDate
  );

  if (
    screenshot?.cash === null ||
    !Number.isFinite(Number(screenshot?.cash))
  ) {
    await replyText(
      event.replyToken,
      [
        'I could not read the Cash amount.',
        'Please send the screenshot again.',
      ].join('\n')
    );
    return;
  }

  const cumulativeCash = Number(screenshot.cash);
  const reportDate = screenshot.reportDate || context.reportDate;
  const previousCumulativeCash =
    await getLastCumulativeCash(reportDate);

  let periodCash = cumulativeCash;
  let baselineCash = 0;

  if (
    previousCumulativeCash !== null &&
    Number.isFinite(Number(previousCumulativeCash)) &&
    cumulativeCash >= Number(previousCumulativeCash)
  ) {
    baselineCash = Number(previousCumulativeCash);
    periodCash = cumulativeCash - baselineCash;
  }

  await setLastCumulativeCash(reportDate, cumulativeCash);

  const state = await getCycleState(context.cycleId);

  state.screenshotCash = periodCash;
  state.cumulativeCash = cumulativeCash;
  state.baselineCash = baselineCash;
  state.reportDate = reportDate;
  state.screenshotReceivedAt = new Date().toISOString();
  state.updatedAt = new Date().toISOString();

  await saveCycleState(context.cycleId, state);

  const result = await calculateResult(context.cycleId);

  if (result.ready) {
    await replyCashierResult(event.replyToken, result);
  } else {
    await replyText(
      event.replyToken,
      [
        'Screenshot received ✅',
        `Report Date: ${reportDate}`,
        `Cumulative POS Cash: ${formatMoney(cumulativeCash)} THB`,
        `Previous Baseline: ${formatMoney(baselineCash)} THB`,
        `Cash for This Period: ${formatMoney(periodCash)} THB`,
        '',
        'Please send the counted cash.',
        'Example: count 12500',
      ].join('\n')
    );
  }
}

async function saveCountedCash(event, amount) {
  if (amount < 0) {
    await replyText(
      event.replyToken,
      'The counted cash cannot be negative.'
    );
    return;
  }

  const context = getCashierContext();
  const state = await getCycleState(context.cycleId);

  state.countedCash = amount;
  state.countReceivedAt = new Date().toISOString();
  state.updatedAt = new Date().toISOString();

  await saveCycleState(context.cycleId, state);

  const result = await calculateResult(context.cycleId);

  if (result.ready) {
    await replyCashierResult(event.replyToken, result);
  } else {
    await replyText(
      event.replyToken,
      [
        `Counted Cash: ${formatMoney(amount)} THB`,
        '',
        'Waiting for the cashier screenshot.',
      ].join('\n')
    );
  }
}

async function addCashOut(event, amount) {
  if (amount <= 0) {
    await replyText(
      event.replyToken,
      'Cash Out must be greater than zero.'
    );
    return;
  }

  const context = getCashierContext();
  const state = await getCycleState(context.cycleId);

  state.cashOutTotal =
    Number(state.cashOutTotal || 0) + amount;

  // If cash was already counted, reduce the counted amount as well.
  // This preserves the existing difference after money leaves the drawer.
  if (
    state.countedCash !== null &&
    state.countedCash !== undefined &&
    Number.isFinite(Number(state.countedCash))
  ) {
    state.countedCash =
      Number(state.countedCash) - amount;
  }

  state.cashOutEntries = Array.isArray(state.cashOutEntries)
    ? state.cashOutEntries
    : [];

  state.cashOutEntries.push({
    amount,
    userId: event.source?.userId || '',
    createdAt: new Date().toISOString(),
  });

  state.updatedAt = new Date().toISOString();

  await saveCycleState(context.cycleId, state);

  const result = await calculateResult(context.cycleId);

  const lines = [
    'Cash Out recorded ✅',
    `Amount: ${formatMoney(amount)} THB`,
    `Total Cash Out: ${formatMoney(
      state.cashOutTotal
    )} THB`,
  ];

  if (
    state.countedCash !== null &&
    state.countedCash !== undefined &&
    Number.isFinite(Number(state.countedCash))
  ) {
    lines.push(
      `Updated Counted Cash: ${formatMoney(
        state.countedCash
      )} THB`
    );
  }

  if (result.ready) {
    lines.push(
      '',
      `Updated Difference: ${formatSignedMoney(
        result.difference
      )} THB`
    );
  }

  await replyText(event.replyToken, lines.join('\n'));
}

async function setOpeningFloat(event, amount) {
  if (amount < 0) {
    await replyText(
      event.replyToken,
      'Opening float cannot be negative.'
    );
    return;
  }

  const context = getCashierContext();
  const state = await getCycleState(context.cycleId);

  state.openingFloat = amount;
  state.updatedAt = new Date().toISOString();

  await saveCycleState(context.cycleId, state);

  const result = await calculateResult(context.cycleId);

  const lines = [
    'Opening Float saved ✅',
    `Float: ${formatMoney(amount)} THB`,
  ];

  if (result.ready) {
    lines.push(
      '',
      `Updated Difference: ${formatSignedMoney(
        result.difference
      )} THB`
    );
  }

  await replyText(event.replyToken, lines.join('\n'));
}

async function sendCashierStatus(event) {
  const context = getCashierContext();
  const state = await getCycleState(context.cycleId);
  const adjustment = await getAdjustment();
  const result = await calculateResult(context.cycleId);

  const lines = [
    `Cashier Status — ${context.label}`,
    '',
    `Cash for This Period: ${
      state.screenshotCash === null
        ? 'Not received'
        : `${formatMoney(state.screenshotCash)} THB`
    }`,
    `Cumulative POS Cash: ${
      state.cumulativeCash === null ||
      state.cumulativeCash === undefined
        ? 'Not received'
        : `${formatMoney(state.cumulativeCash)} THB`
    }`,
    `Previous Baseline: ${formatMoney(
      state.baselineCash || 0
    )} THB`,
    `Counted Cash: ${
      state.countedCash === null
        ? 'Not received'
        : `${formatMoney(state.countedCash)} THB`
    }`,
    `Opening Float: ${formatMoney(
      state.openingFloat || 0
    )} THB`,
    `Cash Out: ${formatMoney(
      state.cashOutTotal || 0
    )} THB`,
    `Adjustment: ${formatSignedMoney(
      adjustment
    )} THB`,
  ];

  if (result.ready) {
    lines.push(
      '',
      `Expected Cash: ${formatMoney(
        result.expectedCash
      )} THB`,
      `Difference: ${formatSignedMoney(
        result.difference
      )} THB`,
      result.status
    );
  }

  await replyText(event.replyToken, lines.join('\n'));
}

async function resetCurrentCycle(event) {
  const context = getCashierContext();

  await saveCycleState(
    context.cycleId,
    createEmptyCycleState()
  );

  await replyText(
    event.replyToken,
    [
      'Current cashier check reset ✅',
      `Cycle: ${context.label}`,
      '',
      'The shortage adjustment was not changed.',
    ].join('\n')
  );
}

async function resetDifference(event) {
  const context = getCashierContext();
  const result = await calculateResult(context.cycleId);

  if (!result.ready) {
    await replyText(
      event.replyToken,
      [
        'Cannot reset the difference yet.',
        'The screenshot and counted cash are both required.',
      ].join('\n')
    );
    return;
  }

  if (Math.abs(result.difference) < 0.01) {
    await replyText(
      event.replyToken,
      'There is no difference to reset.'
    );
    return;
  }

  const oldAdjustment = await getAdjustment();
  const newAdjustment =
    Number(oldAdjustment || 0) + result.difference;

  await setAdjustment(newAdjustment);

  const state = await getCycleState(context.cycleId);
  state.differenceResetAt = new Date().toISOString();
  state.differenceBeforeReset = result.difference;
  state.updatedAt = new Date().toISOString();

  await saveCycleState(context.cycleId, state);

  await replyText(
    event.replyToken,
    [
      'Difference reset ✅',
      `Previous Difference: ${formatSignedMoney(
        result.difference
      )} THB`,
      `New Adjustment: ${formatSignedMoney(
        newAdjustment
      )} THB`,
      '',
      'The event remains recorded in the database.',
    ].join('\n')
  );
}

async function calculateResult(cycleId) {
  const state = await getCycleState(cycleId);
  const adjustment = await getAdjustment();

  const hasScreenshot =
    state.screenshotCash !== null &&
    Number.isFinite(Number(state.screenshotCash));

  const hasCount =
    state.countedCash !== null &&
    Number.isFinite(Number(state.countedCash));

  if (!hasScreenshot || !hasCount) {
    return {
      ready: false,
      state,
    };
  }

  const screenshotCash = Number(state.screenshotCash);
  const countedCash = Number(state.countedCash);
  const openingFloat = Number(state.openingFloat || 0);
  const cashOutTotal = Number(state.cashOutTotal || 0);

  const expectedCash =
    screenshotCash +
    openingFloat -
    cashOutTotal +
    Number(adjustment || 0);

  const difference = countedCash - expectedCash;

  let status = '✅ Cash matches.';

  if (difference < -0.009) {
    status = `❌ Shortage: ${formatMoney(
      Math.abs(difference)
    )} THB`;
  } else if (difference > 0.009) {
    status = `⚠️ Overage: ${formatMoney(
      difference
    )} THB`;
  }

  state.lastExpectedCash = expectedCash;
  state.lastDifference = difference;
  state.lastCalculatedAt = new Date().toISOString();

  await saveCycleState(cycleId, state);

  return {
    ready: true,
    screenshotCash,
    cumulativeCash: Number(state.cumulativeCash ?? screenshotCash),
    baselineCash: Number(state.baselineCash || 0),
    reportDate: state.reportDate || '',
    countedCash,
    openingFloat,
    cashOutTotal,
    adjustment: Number(adjustment || 0),
    expectedCash,
    difference,
    status,
  };
}

function createCashierResultText(result) {
  return [
    'Cash Check Completed',
    '',
    `Report Date: ${result.reportDate || 'Unknown'}`,
    `Cumulative POS Cash: ${formatMoney(
      result.cumulativeCash
    )} THB`,
    `Previous Baseline: ${formatMoney(
      result.baselineCash
    )} THB`,
    `Cash for This Period: ${formatMoney(
      result.screenshotCash
    )} THB`,
    `Opening Float: ${formatMoney(
      result.openingFloat
    )} THB`,
    `Cash Out: ${formatMoney(
      result.cashOutTotal
    )} THB`,
    `Adjustment: ${formatSignedMoney(
      result.adjustment
    )} THB`,
    `Expected Cash: ${formatMoney(
      result.expectedCash
    )} THB`,
    `Counted Cash: ${formatMoney(
      result.countedCash
    )} THB`,
    '',
    `Difference: ${formatSignedMoney(
      result.difference
    )} THB`,
    result.status,
  ].join('\n');
}

async function replyCashierResult(replyToken, result) {
  const quickReplies =
    Math.abs(result.difference) >= 0.01
      ? [
          {
            type: 'action',
            action: {
              type: 'message',
              label: 'Reset difference',
              text: 'reset shortage',
            },
          },
          {
            type: 'action',
            action: {
              type: 'message',
              label: 'Status',
              text: 'status',
            },
          },
        ]
      : [
          {
            type: 'action',
            action: {
              type: 'message',
              label: 'Status',
              text: 'status',
            },
          },
        ];

  await replyText(
    replyToken,
    createCashierResultText(result),
    quickReplies
  );
}

function cashierHelp() {
  return [
    'Cashier Bot Commands',
    '',
    'Send cashier screenshot',
    'count 12500',
    'cash out 500',
    'float 1000',
    'status',
    'reset',
    'reset shortage',
    '',
    'You may also send only a number.',
    'Example: 12500',
  ].join('\n');
}


/* =========================================================
   AUTOMATIC REMINDERS
========================================================= */

async function runScheduledReminder(action) {
  const context = getCashierContext();
  const state = await getCycleState(context.cycleId);

  const validActions = new Set([
    'start',
    'check15',
    'check30',
  ]);

  if (!validActions.has(action)) {
    throw new Error('Unknown reminder action');
  }

  const reminderKey =
    `cashier:reminder:${CASHIER_GROUP_ID}:${context.cycleId}:${action}`;

  const alreadySent = await redisCommand(['GET', reminderKey]);

  if (alreadySent) {
    return {
      sent: false,
      reason: 'Already sent',
      cycle: context.cycleId,
      action,
    };
  }

  let message = '';

  if (action === 'start') {
    message = [
      `Cashier Check — ${context.label}`,
      '',
      'Please send:',
      '1. The FlowAccount cashier screenshot',
      '2. The counted cash amount',
      '',
      'Example: count 12500',
    ].join('\n');
  }

  if (action === 'check15') {
    const missing = getMissingCashierItems(state);

    if (missing.length === 0) {
      return {
        sent: false,
        reason: 'Report complete',
        cycle: context.cycleId,
        action,
      };
    }

    message = [
      `Reminder — ${context.label}`,
      '',
      `Still missing: ${missing.join(' and ')}.`,
      'Please send the missing information now.',
    ].join('\n');
  }

  if (action === 'check30') {
    const missing = getMissingCashierItems(state);

    if (missing.length === 0) {
      return {
        sent: false,
        reason: 'Report complete',
        cycle: context.cycleId,
        action,
      };
    }

    message = [
      `Overdue Cashier Report — ${context.label} ⚠️`,
      '',
      `Still missing: ${missing.join(' and ')}.`,
      'The cashier report is now late. Please update the group immediately.',
    ].join('\n');
  }

  await pushText(CASHIER_GROUP_ID, message);

  await redisCommand([
    'SET',
    reminderKey,
    new Date().toISOString(),
    'EX',
    '172800',
  ]);

  return {
    sent: true,
    cycle: context.cycleId,
    action,
  };
}

function getMissingCashierItems(state) {
  const missing = [];

  if (
    state.screenshotCash === null ||
    state.screenshotCash === undefined
  ) {
    missing.push('cashier screenshot');
  }

  if (
    state.countedCash === null ||
    state.countedCash === undefined
  ) {
    missing.push('counted cash');
  }

  return missing;
}

/* =========================================================
   SCREENSHOT / OPENAI VISION
========================================================= */

async function downloadLineImage(messageId) {
  const response = await fetch(
    `${LINE_DATA_API}/message/${messageId}/content`,
    {
      method: 'GET',
      headers: {
        Authorization:
          `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `LINE image download failed: ${response.status}`
    );
  }

  const contentType =
    response.headers.get('content-type') || 'image/jpeg';

  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  return {
    contentType,
    base64,
  };
}

async function readCashFromScreenshot(image, fallbackReportDate) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  const dataUrl =
    `data:${image.contentType};base64,${image.base64}`;

  const response = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:
        `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'You read FlowAccount Cashier Report screenshots.',
            'Find the payment-method amount labeled Cash.',
            'Do not use Net Sales.',
            'Do not use Transfer or QR.',
            'Also read the report date shown in the screenshot.',
            'Return only valid JSON:',
            '{"cash":860,"reportDate":"2026-07-11"}',
            'Use YYYY-MM-DD for reportDate.',
            'If the Cash amount cannot be found, return:',
            '{"cash":null,"reportDate":null}',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Read the Cash payment amount from this screenshot.',
            },
            {
              type: 'image_url',
              image_url: {
                url: dataUrl,
              },
            },
          ],
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('OpenAI vision error:', data);
    throw new Error(
      `OpenAI vision failed: ${response.status}`
    );
  }

  const content =
    data?.choices?.[0]?.message?.content?.trim() || '';

  const json = extractJson(content);

  if (json && json.cash !== null) {
    const amount = normalizeAmount(json.cash);

    if (amount !== null) {
      return {
        cash: amount,
        reportDate:
          normalizeReportDate(json.reportDate) ||
          fallbackReportDate,
      };
    }
  }

  const match = content.match(
    /(?:cash["']?\s*[:=]\s*|฿\s*)([\d,]+(?:\.\d{1,2})?)/i
  );

  return {
    cash: match ? normalizeAmount(match[1]) : null,
    reportDate: fallbackReportDate,
  };
}

/* =========================================================
   TRANSLATOR
========================================================= */

async function handleTranslation(event) {
  const userText = event.message?.text?.trim();

  if (!userText) return;

  const translation = await translateThaiHebrew(userText);
  await replyText(event.replyToken, translation);
}

async function translateThaiHebrew(userText) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  const response = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:
        `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `
You are a precise translator for a LINE group.

Rules:
- Hebrew must be translated into natural Thai.
- Thai must be translated into natural Hebrew.
- English-only messages must remain unchanged.
- Preserve names, English words, URLs, numbers, dates, prices and emojis.
- Never translate Hebrew into Hebrew.
- Never translate Thai into Thai.
- Return only the final translation.
- Do not add explanations, labels or quotation marks.
          `.trim(),
        },
        {
          role: 'user',
          content: userText,
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('OpenAI translation error:', data);
    throw new Error(
      `OpenAI translation failed: ${response.status}`
    );
  }

  const result =
    data?.choices?.[0]?.message?.content?.trim();

  if (!result) {
    throw new Error(
      'OpenAI returned an empty translation'
    );
  }

  return result;
}

/* =========================================================
   UPSTASH STORAGE
========================================================= */

async function redisCommand(command) {
  const response = await fetch(
    UPSTASH_REDIS_REST_URL,
    {
      method: 'POST',
      headers: {
        Authorization:
          `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    console.error('Upstash error:', data);
    throw new Error(
      data.error ||
        `Upstash request failed: ${response.status}`
    );
  }

  return data.result;
}

async function redisGetJson(key, fallback) {
  const result = await redisCommand(['GET', key]);

  if (result === null || result === undefined) {
    return fallback;
  }

  try {
    return JSON.parse(result);
  } catch {
    return fallback;
  }
}

async function redisSetJson(key, value) {
  return redisCommand([
    'SET',
    key,
    JSON.stringify(value),
  ]);
}

function cycleKey(cycleId) {
  return `cashier:cycle:${CASHIER_GROUP_ID}:${cycleId}`;
}

function adjustmentKey() {
  return `cashier:adjustment:${CASHIER_GROUP_ID}`;
}

function cumulativeBaselineKey(reportDate) {
  return `cashier:cumulative:${CASHIER_GROUP_ID}:${reportDate}`;
}

async function getLastCumulativeCash(reportDate) {
  const result = await redisCommand([
    'GET',
    cumulativeBaselineKey(reportDate),
  ]);

  if (result === null || result === undefined) {
    return null;
  }

  const amount = Number(result);
  return Number.isFinite(amount) ? amount : null;
}

async function setLastCumulativeCash(reportDate, amount) {
  await redisCommand([
    'SET',
    cumulativeBaselineKey(reportDate),
    String(amount),
  ]);
}

async function getCycleState(cycleId) {
  return redisGetJson(
    cycleKey(cycleId),
    createEmptyCycleState()
  );
}

async function saveCycleState(cycleId, state) {
  await redisSetJson(cycleKey(cycleId), state);
}

async function getAdjustment() {
  const result = await redisCommand([
    'GET',
    adjustmentKey(),
  ]);

  const amount = Number(result || 0);
  return Number.isFinite(amount) ? amount : 0;
}

async function setAdjustment(amount) {
  await redisCommand([
    'SET',
    adjustmentKey(),
    String(amount),
  ]);
}

function createEmptyCycleState() {
  return {
    screenshotCash: null,
    cumulativeCash: null,
    baselineCash: 0,
    reportDate: null,
    countedCash: null,
    openingFloat: 0,
    cashOutTotal: 0,
    cashOutEntries: [],
    lastExpectedCash: null,
    lastDifference: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/* =========================================================
   LINE MESSAGES
========================================================= */


async function pushText(to, text) {
  if (!to || !text) return;

  const response = await fetch(
    `${LINE_API}/message/push`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:
          `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to,
        messages: [
          {
            type: 'text',
            text: String(text).slice(0, 5000),
          },
        ],
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('LINE push error:', data);
    throw new Error(
      `LINE push failed: ${response.status}`
    );
  }
}

async function replyText(
  replyToken,
  text,
  quickReplyItems = []
) {
  if (!replyToken || !text) return;

  const message = {
    type: 'text',
    text: String(text).slice(0, 5000),
  };

  if (quickReplyItems.length > 0) {
    message.quickReply = {
      items: quickReplyItems,
    };
  }

  const response = await fetch(
    `${LINE_API}/message/reply`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:
          `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [message],
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('LINE reply error:', data);
    throw new Error(
      `LINE reply failed: ${response.status}`
    );
  }
}

/* =========================================================
   HELPERS
========================================================= */

function getCashierContext() {
  const now = new Date();

  const bangkokParts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }
  ).formatToParts(now);

  const values = Object.fromEntries(
    bangkokParts.map((part) => [
      part.type,
      part.value,
    ])
  );

  const hour = Number(values.hour);
  const currentDate =
    `${values.year}-${values.month}-${values.day}`;

  if (hour < 13) {
    const yesterday = new Date(
      `${currentDate}T00:00:00+07:00`
    );

    yesterday.setDate(yesterday.getDate() - 1);

    const yesterdayParts =
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(yesterday);

    const y = Object.fromEntries(
      yesterdayParts.map((part) => [
        part.type,
        part.value,
      ])
    );

    const date = `${y.year}-${y.month}-${y.day}`;

    return {
      cycleId: `${date}:evening`,
      label: `Evening shift — ${date}`,
      reportDate: date,
    };
  }

  return {
    cycleId: `${currentDate}:morning`,
    label: `Morning shift — ${currentDate}`,
    reportDate: currentDate,
  };
}

function parseCommandAmount(text, prefixRegex) {
  const stripped = text.replace(prefixRegex, '').trim();

  if (stripped === text.trim()) {
    return null;
  }

  return normalizeAmount(stripped);
}

function parseCountAmount(text) {
  const trimmed = text.trim();

  const countMatch = trimmed.match(
    /^(?:count|cash\s*count|counted)\s*[:=-]?\s*(.+)$/i
  );

  if (countMatch) {
    return normalizeAmount(countMatch[1]);
  }

  if (
    /^[฿\s]*[\d,]+(?:\.\d{1,2})?\s*(?:thb|baht|บาท)?$/i.test(
      trimmed
    )
  ) {
    return normalizeAmount(trimmed);
  }

  return null;
}

function normalizeAmount(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/฿/g, '')
    .replace(/thb/gi, '')
    .replace(/baht/gi, '')
    .replace(/บาท/g, '')
    .replace(/[^\d.-]/g, '')
    .trim();

  if (!cleaned) return null;

  const amount = Number(cleaned);

  return Number.isFinite(amount) ? amount : null;
}

function normalizeReportDate(value) {
  if (!value) return null;

  const text = String(value).trim();

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return text;

  const slash = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (slash) {
    const day = slash[1].padStart(2, '0');
    const month = slash[2].padStart(2, '0');
    return `${slash[3]}-${month}-${day}`;
  }

  return null;
}

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString(
    'en-US',
    {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }
  );
}

function formatSignedMoney(amount) {
  const number = Number(amount || 0);

  if (Math.abs(number) < 0.005) return '0';

  const sign = number > 0 ? '+' : '-';

  return `${sign}${formatMoney(Math.abs(number))}`;
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*?\}/);

    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}
