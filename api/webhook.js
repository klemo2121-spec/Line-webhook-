export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('LINE Webhook is running!');
  }

  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  const events = (req.body && req.body.events) || [];

  const jobs = events.map((e) => {
    if (e.type === 'message' && e.message?.type === 'text') {
      return fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          replyToken: e.replyToken,
          messages: [{ type: 'text', text: `קיבלת הודעה: ${e.message.text}` }],
        }),
      });
    }
    return Promise.resolve();
  });

  await Promise.all(jobs).catch(() => {});
  return res.status(200).end('OK');
}
