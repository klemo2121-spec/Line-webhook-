import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../.local/browser/', import.meta.url));
const config = JSON.parse(await readFile(path.join(root,'config.json'),'utf8'));
if (config.baseUrl !== 'https://line-webhook-xiju.vercel.app' || !/^[a-f0-9-]{36}$/.test(config.workerId)) throw Error('Invalid worker destination/identity');
const keyScript = fileURLToPath(new URL('./browser-secrets.py',import.meta.url));
const python = process.env.BROWSER_WORKER_PYTHON || path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const { stdout:token } = await promisify(execFile)(python,[keyScript,'read'],{windowsHide:true});
if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw Error('Invalid protected worker credential');
const [command, inputPath] = process.argv.slice(2);
let action = ({claim:'claim',plan:'plan','write-started':'write_started',saved:'saved',complete:'complete',fail:'fail',dismiss:'dismiss',archive:'archive_prepared','archive-complete':'complete'})[command];
if (!action) throw Error('Use claim | plan FILE | write-started FILE | saved FILE | archive FILE | archive-complete FILE | complete FILE | fail FILE');
let input = {};
if (action !== 'claim') {
  if (!inputPath) throw Error('A local JSON input file is required');
  input = JSON.parse(await readFile(inputPath,'utf8'));
}
let archiveResult;
if (command === 'archive' || command === 'archive-complete') {
  const current = JSON.parse(await readFile(path.join(root,'current.json'),'utf8'));
  if (current.job.id !== input.id || current.job.status !== 'saved') throw Error('Claim the saved job again before using its ZIP fallback');
  const archiveScript = fileURLToPath(new URL('./receipt-archive.py',import.meta.url));
  if (command === 'archive') {
    const p=current.job.plan,e=current.job.evidence;
    if (!p || !e || input.limitObserved !== true || !['image_count_limit','attachment_count_limit'].includes(input.limitReason) || !input.limitMessage || !Array.isArray(input.inventory) || !Array.isArray(input.files)) throw Error('Supply the actual image/attachment count error and all existing document image downloads');
    if (input.files.some(f=>f.source!=='existing')) throw Error('Current original is supplied automatically from the claimed job');
    const spec={scope:{companyId:e.companyId,recordId:String(e.recordId),serial:e.serial,month:p.month,bucket:p.bucket},inventory:input.inventory,limitObserved:true,limitReason:input.limitReason,limitMessage:String(input.limitMessage).slice(0,500),files:[...input.files,{path:current.imagePath,sourceName:current.job.filename,source:'current'}]};
    const specPath=path.join(current.folder,'archive-input.json');await writeFile(specPath,JSON.stringify(spec,null,2));
    const result=await promisify(execFile)(python,[archiveScript,'build',specPath,current.folder],{windowsHide:true,maxBuffer:2*1024*1024});
    archiveResult=JSON.parse(result.stdout);
    await writeFile(path.join(current.folder,'archive-expected.json'),JSON.stringify(archiveResult.archive,null,2));
    input={id:input.id,archive:archiveResult.archive};
  } else {
    const archive=current.job.archive;
    if (!archive || !input.downloadPath || input.reopened !== true) throw Error('Download the saved ZIP after reopening the actual document');
    const expectedPath=path.join(current.folder,'archive-expected.json');await writeFile(expectedPath,JSON.stringify(archive,null,2));
    const result=await promisify(execFile)(python,[archiveScript,'verify',input.downloadPath,expectedPath],{windowsHide:true,maxBuffer:1024*1024});
    const verified=JSON.parse(result.stdout);if(verified.verified!==true)throw Error('Saved ZIP verification failed');
    input={id:input.id,filename:archive.filename,attachmentVerified:true,reopened:true,archiveSha256:verified.sha256,archiveContentsVerified:true,downloadedAfterReopen:true};
  }
}
const response = await fetch(config.baseUrl + '/api/browser-worker', {
  method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
  headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:JSON.stringify({...input,workerId:config.workerId,action}),
});
const data = await response.json();
if (!response.ok) throw Error(data.error || `Worker request failed (${response.status})`);
if (action === 'claim' && data.job) {
  const {job,image,...context} = data;
  if (!/^[a-f0-9]{24}$/.test(job.id) || !new RegExp(`^line-${job.id}\\.(?:jpg|png)$`).test(job.filename) || !['image/jpeg','image/png'].includes(image?.contentType)) throw Error('Invalid queued image');
  const folder = path.join(root,'jobs',job.id); await mkdir(folder,{recursive:true});
  const imagePath = path.join(folder,job.filename);
  await writeFile(imagePath,Buffer.from(image.base64,'base64'));
  const current = {...context,job,imagePath,folder};
  await writeFile(path.join(root,'current.json'),JSON.stringify(current,null,2));
  console.log(JSON.stringify(current,null,2));
} else console.log(JSON.stringify(archiveResult ? {...data,archivePath:archiveResult.path} : data));
