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
const action = ({claim:'claim',plan:'plan','write-started':'write_started',saved:'saved',complete:'complete',fail:'fail'})[command];
if (!action) throw Error('Use claim | plan FILE | write-started FILE | saved FILE | complete FILE | fail FILE');
let input = {};
if (action !== 'claim') {
  if (!inputPath) throw Error('A local JSON input file is required');
  input = JSON.parse(await readFile(inputPath,'utf8'));
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
} else console.log(JSON.stringify(data));
