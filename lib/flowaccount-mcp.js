export const MCP_ORIGIN = 'https://mcp.flowaccount.com';
export const MCP_ENDPOINT = `${MCP_ORIGIN}/mcp`;

// This connection milestone deliberately allows reads and previews only.
// Actual creates require the separate LINE approval + attachment workflow.
const allowed = new Set(['company__list', 'company_settings__load', 'expense__list_expenses',
  'expense__get_document', 'expense__list_business_categories', 'expense__validate_expense', 'expense__create_expense']);

export function createMcpClient({ getToken, fetchImpl = fetch }) {
  return async function session() {
    const token = await getToken();
    let sessionId, protocol = '2025-03-26', sequence = 0;
    async function request(method, params, notification = false) {
      const id = notification ? undefined : ++sequence;
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      if (method !== 'initialize') headers['MCP-Protocol-Version'] = protocol;
      const response = await fetchImpl(MCP_ENDPOINT, { method: 'POST', redirect: 'error', headers,
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`FlowAccount MCP unavailable (${response.status})`);
      sessionId = response.headers.get('mcp-session-id') || sessionId;
      if (notification && response.status === 202) return;
      const body = await response.text();
      if (notification && !body.trim()) return;
      let message;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        for (const event of body.replaceAll('\r\n', '\n').split('\n\n')) {
          const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (data) { const value = JSON.parse(data); if (value.id === id) message = value; }
        }
      } else message = JSON.parse(body);
      if (!message || message.id !== id || message.error) throw new Error('FlowAccount MCP returned an invalid response');
      return message.result;
    }
    const initialized = await request('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'LINE expense bot', version: '2.0.0' } });
    if (!initialized?.protocolVersion) throw new Error('FlowAccount MCP initialization failed');
    protocol = initialized.protocolVersion;
    await request('notifications/initialized', undefined, true);
    return {
      async listTools() {
        const tools = []; let cursor;
        for (let page = 0; page < 25; page++) {
          const result = await request('tools/list', cursor ? { cursor } : {});
          if (!Array.isArray(result?.tools)) throw new Error('Invalid MCP tool catalog');
          tools.push(...result.tools); cursor = result.nextCursor;
          if (!cursor) return tools;
        }
        throw new Error('MCP tool catalog pagination exceeded');
      },
      async call(name, args = {}) {
        if (!allowed.has(name) || (name === 'expense__create_expense' && args.confirm !== false) || args.payment != null || args.document?.payment != null) throw new Error('This connection supports reads and expense previews only');
        const result = await request('tools/call', { name, arguments: args });
        if (result?.isError) throw new Error('FlowAccount tool failed');
        const value = result?.structuredContent ?? JSON.parse(result?.content?.find(c => c.type === 'text')?.text || '{}');
        if (value?.error || value?.status === false) throw new Error('FlowAccount tool rejected the request');
        return value;
      },
    };
  };
}
