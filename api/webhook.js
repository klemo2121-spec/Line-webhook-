// נניח שיש לך userMessage מהאירוע:
const userMessage = event.message.text;

// שולחים את הטקסט ל‑OpenAI
const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
  },
  body: JSON.stringify({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: userMessage }]
  })
}).then(r => r.json());

const replyText = aiRes.choices?.[0]?.message?.content || '🙂';
