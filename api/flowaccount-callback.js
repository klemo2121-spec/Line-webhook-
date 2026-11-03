import { createExpenseStore } from '../lib/expense-store.js';
import { createFlowOAuth } from '../lib/flowaccount-oauth.js';

export const maxDuration = 60;
export function createCallback({ env = process.env, oauth = createFlowOAuth({ redis: createExpenseStore({ env }), env }) } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (env.MCP_CONNECTIONS_ENABLED !== 'true') return res.status(404).send('Not found');
    if (req.method !== 'GET') return res.status(405).send('Method not allowed');
    try {
      const params = new URLSearchParams();
      for (const field of ['state', 'code', 'iss', 'error']) {
        const value = req.query?.[field];
        if (value !== undefined && typeof value !== 'string') throw new Error('Invalid callback parameter');
        if (value !== undefined) params.set(field, value);
      }
      await oauth.complete(params);
      return res.status(200).send('FlowAccount connected. Return to LINE and send flow status. No expense or payment was created.');
    } catch {
      return res.status(400).send('Connection was not completed. Return to LINE and send flow connect.');
    }
  };
}
export default createCallback();
