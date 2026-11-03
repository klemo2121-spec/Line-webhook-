export async function pushBrowserMessage(to,text,quoteToken,retryKey) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{ Authorization:`Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type':'application/json', ...(retryKey ? {'X-Line-Retry-Key':retryKey} : {}) },
    body:JSON.stringify({ to,messages:[{type:'text',text,...(quoteToken ? {quoteToken} : {})}] }),
  });
  if (response.status === 409 && retryKey && response.headers.get('x-line-accepted-request-id')) return;
  if (!response.ok) throw Error(`LINE delivery failed (${response.status})`);
}
