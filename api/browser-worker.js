import { createHash, timingSafeEqual } from 'node:crypto';
import { createBrowserJobs } from '../lib/browser-jobs.js';
import { pushBrowserMessage } from '../lib/line-push.js';

export const maxDuration = 60;
export function createWorkerEndpoint({ env = process.env, jobs = createBrowserJobs({ env, send:pushBrowserMessage }) } = {}) {
  return async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    if (env.BROWSER_WORKER_ENABLED !== 'true') return res.status(404).json({ error:'Not found' });
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers?.authorization || '')?.[1];
    const expected = Buffer.from(env.BROWSER_WORKER_KEY_SHA256 || '', 'hex');
    const actual = createHash('sha256').update(token || '').digest();
    if (!token || expected.length !== actual.length || !timingSafeEqual(expected,actual)) return res.status(401).json({ error:'Unauthorized' });
    if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
    try {
      const { action, ...input } = req.body || {};
      const result = await jobs.work(action,input);
      return res.status(200).json(result);
    } catch (e) { return res.status(409).json({ error:String(e.message).slice(0,250) }); }
  };
}
export default createWorkerEndpoint();
