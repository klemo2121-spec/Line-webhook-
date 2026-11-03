import {readFile,writeFile,mkdir,open,unlink,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createEventExpenseProcessor,parseWakeFrames} from '../lib/event-expense-worker.js';
import {createReceiptReader} from '../lib/receipt-reader.js';

const root=fileURLToPath(new URL('../',import.meta.url)),privateRoot=path.join(root,'.local/browser'),local=path.join(privateRoot,'event');
await mkdir(local,{recursive:true});
const config=JSON.parse(await readFile(path.join(privateRoot,'config.json'),'utf8'));
if(config.baseUrl!=='https://line-webhook-xiju.vercel.app'||!/^[a-f0-9-]{36}$/.test(config.workerId||''))throw Error('Invalid worker configuration');
const python=path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const run=promisify(execFile),readSecret=async name=>(await run(python,[path.join(root,`scripts/${name}.py`),'read'],{windowsHide:true})).stdout;
const token=await readSecret('browser-secrets');
if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('Invalid protected worker identity');
const secrets=JSON.parse(await readSecret('runner-secrets'));
const model=secrets.model||'gpt-4.1-mini'; // Preserve the already configured, budgeted reader model.
const atomic=async(file,data)=>{const temp=file+'.tmp';await writeFile(temp,JSON.stringify(data,null,2));await rename(temp,file);};
const state=async data=>atomic(path.join(local,'status.json'),{at:new Date().toISOString(),pid:process.pid,...data});
async function rpc(endpoint,action,input={}){
  const response=await fetch(config.baseUrl+endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(70000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...input,workerId:config.workerId,action})});
  let data;try{data=await response.json();}catch{throw Error('Worker returned an invalid response');}
  if(!response.ok){const error=Error(data.error||'Receipt service unavailable');error.question=data.question;throw error;}
  return data;
}
const worker=async(action,input)=>{
  const data=await rpc('/api/browser-worker',action,input);
  if(action==='direct_claim'&&data.job){
    const {job,image}=data;
    if(!/^[a-f0-9]{24}$/.test(job.id)||job.workflow!=='mcp_individual_v1'||!['image/jpeg','image/png'].includes(image?.contentType)||
      createHash('sha256').update(Buffer.from(image.base64,'base64')).digest('hex')!==job.imageHash)throw Error('Original receipt identity/hash mismatch');
  }
  return data;
},gateway=(action,input)=>rpc('/api/direct-mcp',action,input);
const mode=process.argv[2];
if(!['check','start','once'].includes(mode))throw Error('Use check | start | once');
if(mode==='check'){
  const mcp=await gateway('preflight');
  const response=await fetch('https://api.openai.com/v1/models/'+encodeURIComponent(model),{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${secrets.apiKey}`}});
  if(!response.ok)throw Error(`Configured AI reader unavailable (${response.status})`);
  console.log(JSON.stringify({...mcp,aiModel:model,apiCredential:true,quotaVerified:false,automaticProcessing:false}));process.exit(0);
}
const lockPath=path.join(local,'worker.lock');
let lock;
try{lock=await open(lockPath,'wx');await lock.writeFile(String(process.pid));}
catch{
  const pid=Number(await readFile(lockPath,'utf8').catch(()=>0));
  let alive=true;try{process.kill(pid,0);}catch{alive=false;}
  if(alive||!Number.isInteger(pid)||pid<=0)throw Error('Event worker lock already exists; inspect before restarting');
  await unlink(lockPath);lock=await open(lockPath,'wx');await lock.writeFile(String(process.pid));
}
const usagePath=path.join(local,'usage.json');
async function reserveUsage(){
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok'}).format(new Date());
  let usage=JSON.parse(await readFile(usagePath,'utf8').catch(()=>'{}'));
  if(usage.day!==day)usage={day,requests:0};
  if(usage.requests>=25)throw Error('Daily receipt AI limit reached; no top-up or paid upgrade');
  usage.requests++;await atomic(usagePath,usage);
}
const cacheKey=(current,rules)=>createHash('sha256').update(JSON.stringify([current.job.imageHash,current.job.answers||[],current.job.override||{},rules])).digest('hex');
const cachePath=current=>{
  if(!/^[a-f0-9]{24}$/.test(current.job?.id||''))throw Error('Invalid receipt identity');
  return path.join(local,`receipt-${current.job.id}.json`);
};
const processor=createEventExpenseProcessor({worker,gateway,extract:createReceiptReader({apiKey:secrets.apiKey,model,reserveUsage}),onState:state,
  loadExtraction:async(current,rules)=>{const c=JSON.parse(await readFile(cachePath(current),'utf8').catch(()=>'null'));return c?.key===cacheKey(current,rules)?c.receipt:null;},
  saveExtraction:async(current,rules,receipt)=>atomic(cachePath(current),{key:cacheKey(current,rules),receipt})});
const stop=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop.abort());
try{
  await gateway('preflight');
  if(mode==='once'){await processor.drain();}
  else{
    await processor.drain();
    let failures=0;
    while(!stop.signal.aborted){
      try{
        // Reconnect acknowledgement also drains the durable queue: a message
        // arriving during disconnection cannot be stranded. Empty queues use no AI.
        const response=await fetch(config.baseUrl+'/api/browser-events',{redirect:'error',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.any([stop.signal,AbortSignal.timeout(58000)])});
        if(!response.ok)throw Error(`Event connection unavailable (${response.status})`);
        const decoder=new TextDecoder();let tail='';
        for await(const bytes of response.body){
          const parsed=parseWakeFrames(tail,decoder.decode(bytes,{stream:true}));tail=parsed.tail;
          if(parsed.wake){await processor.drain();failures=0;}
        }
      }catch(error){
        if(stop.signal.aborted)break;
        if(!/timeout|aborted/i.test(error.message))await state({state:'blocked',reason:String(error.message).slice(0,250)});
        failures++;
      }
      const delay=Math.min(30000,1000*2**Math.min(failures,5));
      await new Promise(resolve=>{const done=()=>{clearTimeout(timer);stop.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,delay);stop.signal.addEventListener('abort',done,{once:true});});
    }
  }
}catch(error){await state({state:'blocked',reason:String(error.message).slice(0,250)});throw error;}
finally{if(stop.signal.aborted)await state({state:'stopped'});await lock.close();await unlink(lockPath).catch(()=>{});}
