import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildDirectExpensePlan,directEvidenceFromDocument} from '../lib/direct-expense-policy.js';

const root=fileURLToPath(new URL('../',import.meta.url)),privateRoot=path.join(root,'.local/browser'),local=path.join(privateRoot,'direct');
await mkdir(local,{recursive:true});
const config=JSON.parse(await readFile(path.join(privateRoot,'config.json'),'utf8'));
if(config.baseUrl!=='https://line-webhook-xiju.vercel.app'||!/^[a-f0-9-]{36}$/.test(config.workerId||''))throw Error('Invalid worker origin/identity');
const [command,inputPath]=process.argv.slice(2),input=inputPath?JSON.parse(await readFile(inputPath,'utf8')):{};
const python=process.env.BROWSER_WORKER_PYTHON||path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const currentPath=path.join(local,'current.json');
const loadCurrent=()=>readFile(currentPath,'utf8').then(JSON.parse);
if(command==='prepare'){
  const current=await loadCurrent();if(current.job.status!=='claimed'||current.job.plan)throw Error('Only an untouched claim can be prepared');
  const rules=JSON.parse(await readFile(path.join(local,'known-payees.json'),'utf8'));
  const plan=buildDirectExpensePlan(input.receipt,current,rules,input.existingContact);
  const file=path.join(current.folder,'prepared.json');await writeFile(file,JSON.stringify({id:current.job.id,receipt:input.receipt,existingContact:input.existingContact,plan},null,2));
  console.log(JSON.stringify({file,plan}));
}else if(command==='evidence'){
  const current=await loadCurrent();if(!current.job.plan)throw Error('No immutable plan');
  const evidence=directEvidenceFromDocument(current.job.plan,input),file=path.join(current.folder,'verified-evidence.json');
  await writeFile(file,JSON.stringify({id:current.job.id,evidence},null,2));console.log(JSON.stringify({file,evidence}));
}else{
  const action={configure:'direct_configure',rules:'direct_rules',claim:'direct_claim',plan:'direct_plan','write-started':'direct_write_started',created:'direct_created',saved:'direct_saved',complete:'direct_complete','request-info':'request_info',fail:'fail',inspect:'inspect'}[command];
  if(!action)throw Error('Use configure FILE | rules | claim | prepare FILE | plan FILE | write-started FILE | evidence FILE | saved FILE | complete FILE | request-info FILE | fail FILE | inspect FILE');
  const token=(await promisify(execFile)(python,[path.join(root,'scripts/browser-secrets.py'),'read'],{windowsHide:true})).stdout;
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('Invalid protected worker credential');
  const body=command==='configure'?{config:input}:input;
  const response=await fetch(config.baseUrl+'/api/browser-worker',{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...body,workerId:config.workerId,action})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Worker unavailable');
  if(command==='rules'){
    if(!data.config)throw Error('Individual mode has not been configured');
    await writeFile(path.join(local,'known-payees.json'),JSON.stringify(data.config,null,2));console.log(JSON.stringify({configured:true,rulesPath:path.join(local,'known-payees.json')}));
  }else if(command==='claim'&&data.job){
    const {job,image,...context}=data;
    if(!/^[a-f0-9]{24}$/.test(job.id)||!new RegExp(`^line-${job.id}\\.(?:jpg|png)$`).test(job.filename)||job.workflow!=='mcp_individual_v1'||!['image/jpeg','image/png'].includes(image?.contentType))throw Error('Invalid individual receipt claim');
    const folder=path.join(local,'jobs',job.id),imagePath=path.join(folder,job.filename),bytes=Buffer.from(image.base64,'base64');
    if(createHash('sha256').update(bytes).digest('hex')!==job.imageHash)throw Error('Original image hash mismatch');
    await mkdir(folder,{recursive:true});await writeFile(imagePath,bytes);
    const current={...context,job,folder,imagePath};await writeFile(currentPath,JSON.stringify(current,null,2));
    console.log(JSON.stringify({...context,imagePath,folder,currentPath,job:{id:job.id,status:job.status,override:job.override,answers:job.answers||[],plan:job.plan,creation:job.creation,evidence:job.evidence}}));
  }else{
    if(['plan','write-started','created','saved'].includes(command)){
      const current=await loadCurrent();if(current.job.id!==data.id)throw Error('Worker returned a different job');
      current.job.status=data.status;if(data.plan)current.job.plan=data.plan;if(data.creation)current.job.creation=data.creation;if(command==='saved')current.job.evidence=input.evidence;
      await writeFile(currentPath,JSON.stringify(current,null,2));
    }
    console.log(JSON.stringify(data));
  }
}
