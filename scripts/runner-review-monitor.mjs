// Monitor only local worker state. No AI requests or browser control here.
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const exec=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url)),privateRoot=path.join(root,'.local/browser');
let last='';
while(true){
  try {
    const status=JSON.parse(await readFile(path.join(privateRoot,'runner-status.json'),'utf8'));
    if(status.at!==last&&['setup_blocked','blocked'].includes(status.state)&&status.reason==='Receipt needs review'){
      const current=JSON.parse((await exec(process.execPath,[path.join(root,'scripts/browser-worker.mjs'),'claim'],{windowsHide:true,cwd:root})).stdout);
      if(current.job?.status==='claimed'&&!current.job.plan){
        const file=path.join(privateRoot,'review-monitor-action.json');await writeFile(file,JSON.stringify({id:current.job.id}));
        await exec(process.execPath,[path.join(root,'scripts/browser-worker.mjs'),'request-info',file],{windowsHide:true,cwd:root});
        await writeFile(path.join(privateRoot,'runner-command.json'),JSON.stringify({action:'start'}));
      }
      last=status.at;
    }
  }catch{ /* Retain the financial lock on all uncertain errors. */ }
  await new Promise(resolve=>setTimeout(resolve,2000));
}
