// api/webhook.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  try {
    const events = req.body?.events || [];
    console.log('Got events:', JSON.stringify(events, null, 2));

    const jobs = events.map(async (ev) => {
      try {
        if (ev.type !== 'message' || ev.message?.type !== 'text') return;
        const userText = ev.message.text || '';

        // detect language
        const hasThai = /[\u0E00-\u0E7F]/.test(userText);
        const hasHeb  = /[\u0590-\u05FF]/.test(userText);
        let target = 'Thai';
        if (hasThai && !hasHeb) target = 'Hebrew';
        if (hasHeb && !hasThai) target = 'Thai';

        // ask OpenAI
        let replyText = '';
        try {
          const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              temperature: 0.2,
              messages: [
                { role: 'system', content: 'You are a precise translator. Translate the user message into the TARGET language. Return ONLY the translation.' },
                { role: 'user', content: `TARGET: ${target}\nTEXT: ${userText}` },
              ],
            }),
          });

          const aiJson = await aiResp.json();
          console.log('OpenAI status:', aiResp.status, aiJson?.error || '');
          replyText = aiJson?.choices?.[0]?.message?.content?.trim();
        } catch (e) {
          console.error('OpenAI error:', e);
        }

        if (!replyText) {
          // fallback כדי שתמיד תהיה תשובה
          replyText = target === 'Hebrew' ? 'לא הצלחתי לתרגם כרגע.' : 'ไม่สามารถแปลได้ตอนนี้';
        }

        // reply to LINE
        const lineResp = await fetch('https://api.line.me/v2/bot/message/reply', {
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

        const lineText = await lineResp.text();
        console.log('LINE reply status:', lineResp.status, lineText);
      } catch (inner) {
        console.error('Event handling error:', inner);
      }
    });

    await Promise.all(jobs);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(200).json({ ok: true });
  }
}
