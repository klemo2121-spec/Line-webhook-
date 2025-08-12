// api/webhook.js
// LINE <-> OpenAI Translator (Thai <-> Hebrew)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  try {
    const events = req.body?.events || [];

    const jobs = events.map(async (ev) => {
      if (ev.type !== 'message' || ev.message?.type !== 'text') return;

      const userText = ev.message.text || '';

      // Language detection: Thai or Hebrew
      const hasThai = /[\u0E00-\u0E7F]/.test(userText);
      const hasHeb = /[\u0590-\u05FF]/.test(userText);

      let target = 'Thai';
      if (hasThai && !hasHeb) target = 'Hebrew';
      if (hasHeb && !hasThai) target = 'Thai';

      // Ask OpenAI for translation only
      const ai = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                'You are a precise translator. Translate the user message into the TARGET language. Return ONLY the translation, no extra words.',
            },
            {
              role: 'user',
              content: `TARGET: ${target}\nTEXT: ${userText}`,
            },
          ],
        }),
      }).then((r) => r.json());

      const replyText =
        ai?.choices?.[0]?.message?.content?.trim() || 'Sorry, no translation.';

      // Reply back to LINE
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
    });

    await Promise.all(jobs);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: true });
  }
}
