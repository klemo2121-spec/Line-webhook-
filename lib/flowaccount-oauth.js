import { randomBytes, createHash, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { MCP_ORIGIN, MCP_ENDPOINT, createMcpClient } from './flowaccount-mcp.js';

const prefix = 'line-expenses:oauth:v1:';
const scopeId = actor => createHash('sha256').update(`${actor.groupId}:${actor.userId}`).digest('hex');
const sameActor = (a, b) => a?.groupId === b?.groupId && a?.userId === b?.userId;

export function createFlowOAuth({ redis, env = process.env, fetchImpl = fetch, now = Date.now }) {
  function key() {
    const value = Buffer.from(env.FLOWACCOUNT_OAUTH_ENCRYPTION_KEY || '', 'base64');
    if (value.length !== 32) throw new Error('Configure the OAuth encryption key');
    return value;
  }
  function seal(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from(prefix));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  function open(value) {
    const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(prefix)); decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }
  const get = async name => { const v = await redis(['GET', prefix + name]); return v ? open(v) : null; };
  const set = (name, value, ttl) => redis(['SET', prefix + name, seal(value), ...(ttl ? ['EX', String(ttl)] : [])]);
  function redirectUri() {
    const url = new URL(env.APP_BASE_URL || 'https://missing.invalid');
    if (url.protocol !== 'https:' || url.origin !== env.APP_BASE_URL || url.hostname === 'missing.invalid' || url.username || url.password) throw new Error('Configure canonical HTTPS APP_BASE_URL');
    if (!/^\d+$/.test(env.FLOWACCOUNT_COMPANY_ID || '')) throw new Error('Configure the expected FlowAccount company');
    key();
    return `${url.origin}/api/flowaccount-callback`;
  }
  async function provider(url, options = {}) {
    if (new URL(url).origin !== MCP_ORIGIN) throw new Error('Unexpected OAuth provider');
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error('FlowAccount authorization failed; reconnect from LINE');
    return data;
  }
  async function metadata() {
    const data = await provider(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`);
    if (data.issuer !== MCP_ORIGIN || !data.code_challenge_methods_supported?.includes('S256')) throw new Error('Unsupported OAuth provider');
    for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) if (new URL(data[field]).origin !== MCP_ORIGIN) throw new Error('Unexpected OAuth endpoint');
    return data;
  }
  function normalizedTokens(data, previous) {
    if (!data.access_token || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid OAuth token response');
    return { accessToken: data.access_token, refreshToken: data.refresh_token || previous?.refreshToken,
      expiresAt: now() + data.expires_in * 1000, clientId: previous.clientId, actor: previous.actor,
      companyId: previous.companyId, authorizedAt: previous.authorizedAt };
  }
  async function start(actor) {
    redirectUri();
    const meta = await metadata();
    // A new public client has no client secret. Provider registration is separate
    // from company consent, which the user completes in FlowAccount's UI.
    const client = await provider(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      client_name: 'LINE expenses', redirect_uris: [redirectUri()], response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none',
    }) });
    if (typeof client.client_id !== 'string' || !client.client_id) throw new Error('OAuth client registration failed');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    await set(`state:${state}`, { actor, verifier, clientId: client.client_id, expiresAt: now() + 600000 }, 600);
    const url = new URL(meta.authorization_endpoint);
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri(),
      scope: 'openid profile flowaccount-api offline_access', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: MCP_ENDPOINT })) url.searchParams.set(name, value);
    return url.href;
  }
  async function complete(params) {
    redirectUri();
    const state = params.get('state');
    if (!/^[A-Za-z0-9_-]{43}$/.test(state || '')) throw new Error('Invalid OAuth state');
    const packed = await redis(['GETDEL', prefix + `state:${state}`]);
    if (!packed) throw new Error('OAuth link expired or already used');
    const pending = open(packed);
    if (pending.expiresAt <= now() || params.has('error') || !params.get('code')) throw new Error('OAuth authorization incomplete');
    const meta = await metadata();
    if ((meta.authorization_response_iss_parameter_supported || params.has('iss')) && params.get('iss') !== MCP_ORIGIN) throw new Error('Unexpected OAuth issuer');
    const response = await provider(meta.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code',
      client_id: pending.clientId, code: params.get('code'), redirect_uri: redirectUri(), code_verifier: pending.verifier }) });
    const tokens = normalizedTokens(response, { ...pending, authorizedAt: now() });
    const client = await createMcpClient({ getToken: async () => tokens.accessToken, fetchImpl })();
    const companies = await client.call('company__list');
    const context = await client.call('company_settings__load');
    // support code is not a company ID. Verify the actual token-bound ID.
    if (!companies.companies?.some(c => c.is_current) || String(context.user?.current_company_id) !== env.FLOWACCOUNT_COMPANY_ID) throw new Error('The selected company does not match the expense company');
    tokens.companyId = env.FLOWACCOUNT_COMPANY_ID;
    const tools = await client.listTools();
    await set(`connection:${scopeId(tokens.actor)}`, tokens);
    await set(`capabilities:${scopeId(tokens.actor)}`, { checkedAt: now(), tools: tools.map(t => t.name) });
    // Wake the event worker only after the verified company connection is saved.
    await redis(['PUBLISH','line-expenses:browser:v1:wake','connection_ready']).catch(()=>{});
    return { actor: tokens.actor, companyId: tokens.companyId };
  }
  async function getToken(actor) {
    const id = scopeId(actor), saved = await get(`connection:${id}`);
    if (!saved || !sameActor(saved.actor, actor) || saved.companyId !== env.FLOWACCOUNT_COMPANY_ID) throw new Error('Connect FlowAccount from LINE first');
    if (saved.expiresAt > now() + 60000) return saved.accessToken;
    if (!saved.refreshToken) throw new Error('FlowAccount session expired; reconnect from LINE');
    const owner = randomUUID(), lock = prefix + `refresh:${id}`;
    if (!await redis(['SET', lock, owner, 'NX', 'EX', '60'])) throw new Error('FlowAccount session is refreshing; try again shortly');
    try {
      const latest = await get(`connection:${id}`);
      if (latest.expiresAt > now() + 60000) return latest.accessToken;
      const meta = await metadata();
      const response = await provider(meta.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: latest.clientId, refresh_token: latest.refreshToken }) });
      const refreshed = normalizedTokens(response, latest);
      await set(`connection:${id}`, refreshed);
      return refreshed.accessToken;
    } finally {
      await redis(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", '1', lock, owner]);
    }
  }
  async function status(actor) {
    const saved = await get(`connection:${scopeId(actor)}`);
    const capabilities = await get(`capabilities:${scopeId(actor)}`);
    return { connected: !!saved && sameActor(saved.actor, actor) && saved.companyId === env.FLOWACCOUNT_COMPANY_ID,
      expiresAt: saved?.expiresAt, refreshable: !!saved?.refreshToken, tools: capabilities?.tools || [] };
  }
  return { start, complete, getToken, status };
}
