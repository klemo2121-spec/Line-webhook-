// api/webhook.js — ECHO TEST ONLY
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');
  try {
    console.log('EVENTS:', JSON.stringify(req.body));
    const events = req.body?.events || [];
    await Promise.all(events.map(async (ev) => {
      if (ev.type !== 'message' || ev.message?.type !== 'text') return;
      const replyText = `echo: ${ev.message.text}`;
      const r = await fetch('https://api.line.me/v2/bot/message/reply', {
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
      const body = await r.text();
      console.log('LINE reply status:', r.status, 'body:', body);
    }));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Handler error:', e);
    return res.status(200).json({ ok: false });
  }
}
