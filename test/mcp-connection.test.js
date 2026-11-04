import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowOAuth } from '../lib/flowaccount-oauth.js';
import { createMcpClient, createPlannedExpenseClient, MCP_ORIGIN, MCP_ENDPOINT } from '../lib/flowaccount-mcp.js';
import {buildDirectExpensePlan} from '../lib/direct-expense-policy.js';
import {directConfig,directReceipt,directCurrent} from './direct-expense-fixture.js';
import { createLineFlowAccount } from '../lib/line-flowaccount.js';
import { createCallback } from '../api/flowaccount-callback.js';
import { parseLineRequest } from '../lib/receipts.js';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';

const actor = { groupId: 'G1', userId: 'U1' };
function setup({ companyId = '7', expiresIn = 3600, issuer = MCP_ORIGIN, sse = false } = {}) {
  let clock = 1000000;
  const env = { APP_BASE_URL: 'https://expense.example', FLOWACCOUNT_COMPANY_ID: '7',
    FLOWACCOUNT_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
    MCP_CONNECTIONS_ENABLED: 'true', EXPENSE_GROUP_IDS: 'G1', EXPENSE_USER_IDS: 'U1' };
  const values = new Map(), requests = [];
  async function redis([command, ...args]) {
    if (command === 'GET') return values.get(args[0]) ?? null;
    if (command === 'GETDEL') { const value = values.get(args[0]) ?? null; values.delete(args[0]); return value; }
    if (command === 'SET') { if (args.includes('NX') && values.has(args[0])) return null; values.set(args[0], args[1]); return 'OK'; }
    if (command === 'EVAL') { if (values.get(args[2]) === args[3]) { values.delete(args[2]); return 1; } return 0; }
    throw new Error(`Unexpected storage operation ${command}`);
  }
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  async function fetchImpl(url, options = {}) {
    url = String(url); requests.push({ url, options });
    if (url.endsWith('/.well-known/oauth-authorization-server')) return response({ issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`, code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
    if (url.endsWith('/oauth/register')) return response({ client_id: 'public-client' });
    if (url.endsWith('/oauth/token')) return response({ access_token: 'SECRET-access', refresh_token: 'SECRET-refresh', token_type: 'Bearer', expires_in: expiresIn });
    assert.equal(url, MCP_ENDPOINT);
    const rpc = JSON.parse(options.body);
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26' };
    if (rpc.method === 'tools/list') result = { tools: [{ name: 'expense__create_expense' }] };
    if (rpc.method === 'tools/call') {
      if (rpc.params.name === 'company__list') result = { structuredContent: { companies: [{ is_current: true, name: 'Test' }] } };
      else if (rpc.params.name === 'company_settings__load') result = { structuredContent: { user: { current_company_id: companyId }, company: { company_name_foreign: 'Test Company' } } };
      else result = { structuredContent: { validation: { valid: true } } };
    }
    const message = { jsonrpc: '2.0', id: rpc.id, result };
    return sse ? new Response(`event: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n`, { headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'session' } }) : response(message);
  }
  const oauth = createFlowOAuth({ redis, env, fetchImpl, now: () => clock });
  async function authorize() {
    const url = new URL(await oauth.start(actor));
    const params = new URLSearchParams({ state: url.searchParams.get('state'), code: 'one-time-code', iss: MCP_ORIGIN });
    await oauth.complete(params);
    return { url, params };
  }
  return { env, values, requests, oauth, authorize, fetchImpl, redis, advance: ms => { clock += ms; } };
}

test('persistent OAuth uses PKCE, verifies company and encrypts tokens and pending secrets', async () => {
  const s = setup(); const { url, params } = await s.authorize();
  assert.equal(url.origin, MCP_ORIGIN);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('scope'), /offline_access/);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://expense.example/api/flowaccount-callback');
  assert.equal(await s.oauth.getToken(actor), 'SECRET-access');
  const serialized = JSON.stringify([...s.values]);
  // Short actor IDs can occur by chance in randomized base64 ciphertext.
  assert.doesNotMatch(serialized, /SECRET-access|SECRET-refresh|public-client|"U1"|"G1"/);
  assert.equal((await s.oauth.status(actor)).connected, true);
  assert.equal((await s.oauth.status({ ...actor, userId: 'U2' })).connected, false);
  await assert.rejects(s.oauth.complete(params), /already used/);
  assert.equal(s.requests.filter(r => r.url.endsWith('/oauth/token')).length, 1);
  assert.equal(s.requests.filter(r => r.url === MCP_ENDPOINT && JSON.parse(r.options.body).method === 'tools/call').every(r => ['company__list', 'company_settings__load'].includes(JSON.parse(r.options.body).params.name)), true);
});

test('wrong company, invalid issuer and expired state never save a usable connection', async () => {
  const wrong = setup({ companyId: '8' }); await assert.rejects(wrong.authorize(), /company/);
  assert.equal((await wrong.oauth.status(actor)).connected, false);
  const s = setup(); const url = new URL(await s.oauth.start(actor));
  await assert.rejects(s.oauth.complete(new URLSearchParams({ state: url.searchParams.get('state'), code: 'code', iss: 'https://evil.example' })), /issuer/);
  assert.equal(s.requests.some(r => r.url.endsWith('/oauth/token')), false);
  const expired = setup(); const u = new URL(await expired.oauth.start(actor)); expired.advance(600001);
  await assert.rejects(expired.oauth.complete(new URLSearchParams({ state: u.searchParams.get('state'), code: 'code', iss: MCP_ORIGIN })), /incomplete/);
});

test('provider endpoints cannot redirect OAuth secrets to an unrelated host', async () => {
  const s = setup({ issuer: 'https://evil.example' });
  await assert.rejects(s.oauth.start(actor), /provider/);
  assert.equal(s.requests.length, 1);
  const bad = setup(); bad.env.APP_BASE_URL = 'http://expense.example';
  await assert.rejects(bad.oauth.start(actor), /HTTPS/);
  assert.equal(bad.requests.length, 0);
});

test('expired access tokens refresh once and rotated credentials remain encrypted', async () => {
  const s = setup(); await s.authorize(); s.advance(3600000);
  assert.equal(await s.oauth.getToken(actor), 'SECRET-access');
  assert.equal(await s.oauth.getToken(actor), 'SECRET-access');
  const grants = s.requests.filter(r => r.url.endsWith('/oauth/token')).map(r => r.options.body.get('grant_type'));
  assert.deepEqual(grants, ['authorization_code', 'refresh_token']);
  assert.doesNotMatch(JSON.stringify([...s.values]), /SECRET/);
  await assert.rejects(s.oauth.getToken({ ...actor, userId: 'U2' }), /Connect/);
});

test('parallel refresh is refused while another worker owns the refresh lock', async () => {
  const s = setup(); await s.authorize(); s.advance(3600000);
  const connectionKey = [...s.values.keys()].find(k => k.includes(':connection:'));
  s.values.set(connectionKey.replace(':connection:', ':refresh:'), 'other-worker');
  await assert.rejects(s.oauth.getToken(actor), /refreshing/);
  assert.equal(s.requests.filter(r => r.url.endsWith('/oauth/token')).length, 1);
});

test('MCP supports SSE responses but refuses financial writes and payments before any request', async () => {
  const s = setup({ sse: true });
  const client = await createMcpClient({ getToken: async () => 'token', fetchImpl: s.fetchImpl })();
  assert.equal((await client.listTools()).length, 1);
  const before = s.requests.length;
  for (const [name, args] of [['expense__create_expense', { confirm: true }], ['expense__create_expense', {}],
    ['documents__record_payment', {}], ['expense__create_expense', { confirm: false, document: { payment: {} } }]]) {
    await assert.rejects(client.call(name, args), /previews only/);
  }
  assert.equal(s.requests.length, before);
  assert.equal((await client.call('expense__create_expense', { confirm: false, document: {} })).validation.valid, true);
});

test('LINE connection commands are disabled by default and require exact group and user', async () => {
  const s = setup(), replies = []; let started = 0;
  const handle = createLineFlowAccount({ env: s.env, oauth: { start: async () => { started++; return 'https://mcp.flowaccount.com/oauth/authorize'; } }, replyText: async (...args) => replies.push(args) });
  const event = { type: 'message', source: actor, replyToken: 'r', message: { type: 'text', text: 'flow connect' } };
  assert.equal(await handle(event), true); assert.equal(started, 1); assert.match(replies[0][1], /עשר דקות/);
  await handle({ ...event, source: { ...actor, userId: 'U2' } }); assert.equal(started, 1);
  await handle({ ...event, source: { ...actor, groupId: 'G2' } }); assert.equal(started, 1);
  s.env.MCP_CONNECTIONS_ENABLED = 'false'; assert.equal(await handle(event), false);
});

test('event client exposes only immutable unpaid receipt creation; generic writes stay blocked',async()=>{
  const s=setup(),client=await createPlannedExpenseClient({getToken:async()=>'token',fetchImpl:s.fetchImpl})();
  const plan=buildDirectExpensePlan(directReceipt(),directCurrent(),directConfig());
  const before=s.requests.length;
  await assert.rejects(client.call('expense__create_expense',{confirm:true,document:plan.document}),/previews only/);
  const paid=structuredClone(plan);paid.document.payment={payment_method:1};
  await assert.rejects(client.createPlannedExpense(paid),/immutable unpaid/);
  assert.equal(s.requests.length,before);
  await client.createPlannedExpense(plan);
  const rpc=JSON.parse(s.requests.at(-1).options.body);
  assert.equal(rpc.params.arguments.confirm,true);assert.equal(rpc.params.arguments.document.payment,undefined);
  assert.deepEqual(rpc.params.arguments.document,plan.document);
});

test('OAuth errors are not leaked to LINE and callback pages never echo codes', async () => {
  const s = setup(), replies = [];
  const oauth = { start: async () => { throw new Error('SECRET token body'); }, complete: async () => { throw new Error('SECRET code'); } };
  const handle = createLineFlowAccount({ env: s.env, oauth, replyText: async (...a) => replies.push(a) });
  await handle({ type: 'message', source: actor, replyToken: 'r', message: { type: 'text', text: 'flow connect' } });
  assert.doesNotMatch(JSON.stringify(replies), /SECRET/);
  const res = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(c) { this.code=c; return this; }, send(v) { this.body=v; return this; } };
  await createCallback({ env: s.env, oauth })({ method: 'GET', query: { code: 'SECRET' } }, res);
  assert.equal(res.code, 400); assert.doesNotMatch(res.body, /SECRET/); assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});

test('MCP-only mode still verifies the raw LINE signature before handling commands', async () => {
  const previous = { receipts: process.env.RECEIPTS_ENABLED, connections: process.env.MCP_CONNECTIONS_ENABLED, secret: process.env.LINE_CHANNEL_SECRET };
  Object.assign(process.env, { RECEIPTS_ENABLED: 'false', MCP_CONNECTIONS_ENABLED: 'true', LINE_CHANNEL_SECRET: 'signature-test' });
  try {
    const body = JSON.stringify({ events: [] });
    const unsigned = Readable.from([Buffer.from(body)]); unsigned.headers = {};
    await assert.rejects(parseLineRequest(unsigned), /signature/);
    const signed = Readable.from([Buffer.from(body)]); signed.headers = { 'x-line-signature': createHmac('sha256', 'signature-test').update(body).digest('base64') };
    assert.deepEqual(await parseLineRequest(signed), { events: [] });
  } finally {
    for (const [key,value] of Object.entries({ RECEIPTS_ENABLED: previous.receipts, MCP_CONNECTIONS_ENABLED: previous.connections, LINE_CHANNEL_SECRET: previous.secret })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
