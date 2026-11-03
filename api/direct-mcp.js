import {createHash,timingSafeEqual} from 'node:crypto';
import {createBrowserJobs} from '../lib/browser-jobs.js';
import {pushBrowserMessage} from '../lib/line-push.js';
import {createDirectMcpGateway,ReceiptQuestion} from '../lib/direct-mcp-gateway.js';

export const maxDuration=60;
export function createDirectMcpEndpoint({env=process.env,jobs=createBrowserJobs({env,send:pushBrowserMessage}),gateway=createDirectMcpGateway({env,jobs,send:pushBrowserMessage})}={}){
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(env.BROWSER_WORKER_ENABLED!=='true')return res.status(404).json({error:'Not found'});
    const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers?.authorization||'')?.[1];
    const expected=Buffer.from(env.BROWSER_WORKER_KEY_SHA256||'','hex'),actual=createHash('sha256').update(token||'').digest();
    if(!token||expected.length!==32||!timingSafeEqual(actual,expected))return res.status(401).json({error:'Unauthorized'});
    if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
    const {action,...input}=req.body||{};
    if(!/^[a-f0-9-]{36}$/.test(input.workerId||''))return res.status(400).json({error:'Invalid worker identity'});
    try{return res.status(200).json(await gateway(action,input));}
    catch(e){return res.status(409).json({error:String(e.message).slice(0,250),...(e instanceof ReceiptQuestion?{question:e.question}:{})});}
  };
}
export default createDirectMcpEndpoint();
