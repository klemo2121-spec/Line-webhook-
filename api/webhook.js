export default async function handler(req, res) {
  if (req.method === 'POST') {
    const events = (req.body && req.body.events) || [];
    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN; // נשים ב-Vercel

    // עונים רק לטקסטים כדי לבדוק שהכל עובד
    const tasks = events
      .filter(e => e.type === 'message' && e.message?.type === 'text')
      .map(e =>
        fetch('https://api.line.me/v2/bot/message/reply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            replyToken: e.replyToken,
            messages: [{ type: 'text', text: `קיבלתי: ${e.message.text}` }],
          }),
        })
      );

    await Promise.all(tasks).catch(() => {});
    return res.status(200).end('OK');
  }

  // בדיקת חיים
  return res.status(200).send('LINE Webhook is running!');
}
