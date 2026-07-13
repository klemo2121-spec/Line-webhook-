// api/webhook.js
// LINE bot:
// 1. Cashier group -> cashier workflow
// 2. Other groups/chats -> Thai <-> Hebrew translation
// 3. /groupid -> shows the LINE group ID

const LINE_API = 'https://api.line.me/v2/bot';
const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

export default async function handler(req, res) {
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

  const messageType = event.message?.type;
  const groupId = event.source?.groupId || '';
  const userId = event.source?.userId || '';
  const cashierGroupId = process.env.CASHIER_GROUP_ID || '';

  console.log('Incoming LINE source:', {
    sourceType: event.source?.type,
    groupId,
    userId,
    messageType,
  });

  // Temporary command: return the current LINE Group ID.
  if (
    messageType === 'text' &&
    event.message.text?.trim().toLowerCase() === '/groupid'
  ) {
    const reply =
      groupId ||
      'This message was not sent inside a LINE group.';

    await replyToLine(event.replyToken, reply);
    return;
  }

  // Messages from the cashier group use the cashier workflow.
  if (
    cashierGroupId &&
    groupId &&
    groupId === cashierGroupId
  ) {
    await handleCashierMessage(event);
    return;
  }

  // All other text messages use the translator.
  if (messageType === 'text') {
    await handleTranslation(event);
  }
}

async function handleTranslation(event) {
  const userText = event.message?.text?.trim();

  if (!userText) return;

  const translation = await translateThaiHebrew(userText);

  await replyToLine(event.replyToken, translation);
}

async function translateThaiHebrew(userText) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  const response = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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
- If the message is mainly Hebrew, translate it into natural Thai.
- If the message is mainly Thai, translate it into natural Hebrew.
- If the message is only English, return it unchanged.
- Preserve names, English words, URLs, numbers, dates, prices and emojis.
- Never translate Hebrew into Hebrew.
- Never translate Thai into Thai.
- Return only the translation.
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
    console.error('OpenAI error:', data);
    throw new Error(`OpenAI request failed: ${response.status}`);
  }

  const result =
    data?.choices?.[0]?.message?.content?.trim();

  if (!result) {
    throw new Error('OpenAI returned an empty response');
  }

  return result;
}

async function handleCashierMessage(event) {
  const messageType = event.message?.type;

  if (messageType === 'image') {
    await replyToLine(
      event.replyToken,
      [
        '✅ Cashier screenshot received.',
        'กรุณาส่งจำนวนเงินสดที่นับได้',
        'Please send the counted cash amount.',
      ].join('\n')
    );
    return;
  }

  if (messageType === 'text') {
    const text = event.message?.text?.trim() || '';

    await replyToLine(
      event.replyToken,
      `✅ Cashier message received:\n${text}`
    );
  }
}

async function replyToLine(replyToken, text) {
  if (!replyToken || !text) return;

  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    throw new Error('Missing LINE_CHANNEL_ACCESS_TOKEN');
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
    console.error('LINE reply error:', data);
    throw new Error(
      `LINE reply failed: ${response.status}`
    );
  }
}
