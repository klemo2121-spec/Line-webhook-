// /api/webhook.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  try {
    const { events = [] } = req.body || {};

    const jobs = events.map(async (ev) => {
      if (ev.type !== 'message' || ev.message?.type !== 'text') return;

      const userText = ev.message.text?.trim() || '';

      // 1) קורא ל‑OpenAI: מזהה שפה ומחזיר תרגום לעברית⇄תאית
      const oa = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini', // אם אין גישה, אפשר להחליף ל‑"gpt-3.5-turbo"
          messages: [
            {
              role: 'system',
              content:
                'You are a translator. Detect if the input is Hebrew or Thai. If Hebrew, translate to Thai. If Thai, translate to Hebrew. Keep it short and natural. Return ONLY the translation.',
            },
            { role: 'user', content: userText },
          ],
          temperature: 0.2,
        }),
      }).then((r) => r.json());

      const replyText =
        oa?.choices?.[0]?.message?.content?.trim() || '🙂';

      // 2) מחזיר תשובה למשתמש ב‑LINE
      await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: ev.replyToken,
          messages: [{ type: 'text', text: replyText }],
        }),
      });
    });

    await Promise.all(jobs);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).json({ ok: false });
  }
}
