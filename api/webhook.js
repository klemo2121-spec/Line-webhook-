// api/webhook.js

// Vercel (Node 18+) already has global fetch.

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('LINE webhook is live.');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = req.body;
    const events = body?.events || [];

    // Handle each incoming LINE event
    const jobs = events.map(async (ev) => {
      if (ev.type !== 'message' || ev.message.type !== 'text') return;

      const userText = ev.message.text || '';

      // 1) Call OpenAI to translate (HE<->TH). If not HE or TH, just echo.
      let replyText = '🙂';
      try {
        const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content:
                  'You are a translator between Hebrew and Thai. Detect the input language automatically. If the user writes in Hebrew, translate to Thai. If the user writes in Thai, translate to Hebrew. Keep only the translation, no extra text.',
              },
              { role: 'user', content: userText },
            ],
            temperature: 0.2,
          }),
        });

        const aiJson = await aiResp.json();
        replyText =
          aiJson?.choices?.[0]?.message?.content?.trim() || '🙂';
      } catch (e) {
        replyText = 'מצטער, הייתה בעיה זמנית. נסה שוב.';
      }

      // 2) Reply to the user on LINE
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
    console.error(err);
    return res.status(200).json({ ok: true }); // LINE expects 200 regardless
  }
}
