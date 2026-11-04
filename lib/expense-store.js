export function createExpenseStore({ env = process.env, fetchImpl = fetch } = {}) {
  return async function command(command) {
    const url = new URL(env.UPSTASH_REDIS_REST_URL || 'https://missing.invalid');
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.upstash.io') || url.username || url.password || !env.UPSTASH_REDIS_REST_TOKEN) throw new Error('Configure private expense storage');
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error('Private expense storage unavailable');
    return data.result;
  };
}
