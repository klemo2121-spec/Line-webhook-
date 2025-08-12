// api/webhook.js
// LINE <-> OpenAI Translator (Thai <-> Hebrew) + DEBUG LOGS

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  try {
    console.log('Incoming body:', JSON.stringify(req.body)); // DEBUG
    const events = req.body?.events || [];

    await Promise.all(
      events.map(async (ev) => {
        if (ev.type !== 'message' || ev.message?.type !== 'text') return;

        const userText = ev.message.text || '';

        // Detect language
        const hasThai = /[\u0E00-\u0E7F]/.test(userText);
        const hasHeb  = /[\u0590-\u05FF]/.test(userText);
        let target = 'Hebrew';
        if (hasHeb && !hasThai) target = 'Thai';

        // Call OpenAI
        let aiJson;
        try {
          const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
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
                    'You are a precise translator. Translate the user message into the TARGET language. Return ONLY the translation.',
                },
                { role: 'user', content: `TARGET: ${target}\nTEXT: ${userText}` },
              ],
            }),
          });

          aiJson = await aiRes.json();
          console.log('OpenAI status:', aiRes.status, 'body:', JSON.stringify(aiJson).slice(0, 500)); // DEBUG
        } catch (e) {
          console.error('OpenAI error:', e);
        }

        const replyText =
          aiJson?.choices?.[0]?.message?.content?.trim() ||
          'מצטער, לא הצלחתי לתרגם כרגע.';

        // Reply to LINE
        try {
          const lineRes = await fetch('https://api.line.me/v2/bot/message/reply', {
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

          const lineText = await lineRes.text();
          console.log('LINE reply status:', lineRes.status, 'body:', lineText); // DEBUG חשוב
        } catch (e) {
          console.error('LINE reply error:', e);
        }
      })
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(200).json({ ok: true });
  }
}
