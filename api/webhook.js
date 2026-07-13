// api/webhook.js
// LINE bot:
// 1. Cashier group -> cashier workflow
// 2. All other groups/chats -> Thai <-> Hebrew translation

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

    // Process sequentially because a LINE replyToken can only be used once.
    for (const event of events) {
      await handleEvent(event);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);

    // Return 200 so LINE doesn't repeatedly resend a broken event.
    return res.status(200).json({ ok: false });
  }
}

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source?.groupId || '';
  const cashierGroupId = process.env.CASHIER_GROUP_ID || '';

  console.log('Incoming LINE source:', {
    type: event.source?.type,
    groupId,
    userId: event.source?.userId,
    messageType: event.message?.type,
  });

  // Cashier group has completely different behavior.
  if (cashierGroupId && groupId === cashierGroupId) {
    await handleCashierMessage(event);
    return;
  }

  // Everywhere else: translate text messages only.
  if (event.message?.type === 'text') {
    await handleTranslation(event);
  }
}

async function handleTranslation(event) {
  const userText = event.message.text?.trim();

  if (!userText) return;

  const translation = await translateThaiHebrew(userText);

  await replyToLine(event.replyToken, translation);
}

async function translateThaiHebrew(userText) {
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
- Keep English words, brand names, URLs, numbers, dates, prices and emojis unchanged whenever appropriate.
- If the message is only English, return it unchanged.
- If the message contains both Hebrew and Thai, translate each meaningful part into the opposite language.
- Never translate Hebrew into Hebrew.
- Never translate Thai into Thai.
- Return only the final translated message.
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

  const data = await response.json();

  if (!response.ok) {
    console.error('OpenAI error:', data);
    throw new Error(`OpenAI request failed: ${response.status}`);
  }

  const result = data?.choices?.[0]?.message?.content?.trim();

  if (!result) {
    throw new Error('OpenAI returned an empty translation');
  }

  return result;
}

async function handleCashierMessage(event) {
  const messageType = event.message?.type;

  // For now, this confirms that routing works.
  // In the next step this section will process:
  // - screenshot
  // - counted cash
  // - cash-out
  // - shortage reset

  if (messageType === 'image') {
    await replyToLine(
      event.replyToken,
      '✅ Cashier screenshot received.\nกรุณาส่งยอดเงินสดที่นับได้'
    );
    return;
  }

  if (messageType === 'text') {
    const text = event.message.text?.trim() || '';

    await replyToLine(
      event.replyToken,
      `✅ Cashier message received:\n${text}`
    );
  }
}

async function replyToLine(replyToken, text) {
  if (!replyToken || !text) return;

  const response = await fetch(`${LINE_API}/message/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: 'text',
          text: text.slice(0, 5000),
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('LINE reply error:', data);
    throw new Error(`LINE reply failed: ${response.status}`);
  }
}
