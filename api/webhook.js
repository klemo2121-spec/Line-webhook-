// api/webhook.js
// LINE <-> OpenAI Translator
// עברית/אנגלית → תאית | תאית → עברית

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  try {
    const events = req.body?.events || [];

    await Promise.all(
      events.map(async (ev) => {
        if (ev.type !== 'message' || ev.message?.type !== 'text') return;

        const userText = ev.message.text || '';

        // אם יש תאית → מתרגם לעברית, אחרת (עברית/אנגלית) → תאית
        const hasThai = /[\u0E00-\u0E7F]/.test(userText);
        const target = hasThai ? 'Hebrew' : 'Thai';

        let aiJson;
        try {
          const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: 'gpt-5-mini',
              messages: [
                {
                  role: 'system',
                  content:
                    'You are a precise translator. Translate the user message into the TARGET language. Return ONLY the translation.',
                },
                { role: 'user', content: `TARGET: ${target}\nTEXT: ${userText}` },
              ],
            }),
          });
          aiJson = await aiRes.json();
        } catch (e) {}

        const replyText =
          aiJson?.choices?.[0]?.message?.content?.trim() ||
          'מצטער, לא הצלחתי לתרגם כרגע.';

        try {
          await fetch('https://api.line.me/v2/bot/message/reply', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
            },
            body: JSON.stringify({
              replyToken: ev.replyToken,
              messages: [{ type: 'text', text: replyText }],
            }),
          });
        } catch (e) {}
      })
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(200).json({ ok: true });
  }
}
