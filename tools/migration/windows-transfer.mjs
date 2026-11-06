// Local Windows handover only. Never creates accounting documents or starts a worker.
import {readFile,writeFile,mkdir,access,copyFile,rename,lstat} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {generateKeyPair,createPrivateKey,randomBytes,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {seal,unseal,digest,fingerprint} from './transfer-crypto.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const LOCAL=path.join(ROOT,'.local'),HERE=path.join(LOCAL,'migration'),BROWSER=path.join(LOCAL,'browser');
const run=promisify(execFile),keypair=promisify(generateKeyPair);
const sourceFile=path.join(HERE,'SOURCE-COMPUTER.json'),publicFile=path.join(HERE,'receiver-public.json'),privateFile=path.join(HERE,'receiver-private.dpapi');
const exists=p=>access(p).then(()=>true,()=>false),json=p=>readFile(p,'utf8').then(JSON.parse);
const [mode,inputFile,expectedFingerprint]=process.argv.slice(2);

async function identity(){
  const user=(await run('whoami.exe',['/user','/fo','csv','/nh'],{windowsHide:true})).stdout;
  const sid=user.match(/S-1-5-[\d-]+/)?.[0];
  const registry=(await run('reg.exe',['query','HKLM\\SOFTWARE\\Microsoft\\Cryptography','/v','MachineGuid'],{windowsHide:true})).stdout;
  const machine=registry.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]+)/i)?.[1];
  if(!sid||!machine)throw Error('Cannot establish this Windows machine/account');
  return {computer:hostname(),binding:digest(machine.toLowerCase()+'|'+sid)};
}
async function restrict(folder){
  await mkdir(folder,{recursive:true});
  for(const p of [LOCAL,folder])if((await lstat(p)).isSymbolicLink())throw Error('Migration folders must not be links');
  const user=(await run('whoami.exe',[],{windowsHide:true})).stdout.trim();
  await run('icacls.exe',[folder,'/inheritance:r','/grant:r',user+':(OI)(CI)F','SYSTEM:(OI)(CI)F'],{windowsHide:true});
}
async function protectedBytes(data,decrypt=false){
  const python=process.env.LINE_MIGRATION_PYTHON||path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  if(!await exists(python))throw Error('Python runtime missing; set LINE_MIGRATION_PYTHON to its verified executable');
  const code="import importlib.util,sys; spec=importlib.util.spec_from_file_location('handover_protection',sys.argv[2]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); sys.stdout.buffer.write(m.protect(sys.stdin.buffer.read(),sys.argv[1]=='unprotect'))";
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-c',code,decrypt?'unprotect':'protect',path.join(ROOT,'scripts/runner-secrets.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0;
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>131072)child.kill();else chunks.push(chunk);});
    child.stderr.resume();child.on('error',()=>reject(Error('Protected credential subprocess unavailable')));
    child.on('close',exit=>exit===0&&size<=131072?resolve(Buffer.concat(chunks)):reject(Error('Windows could not protect/unprotect this file on this account')));
    child.stdin.on('error',()=>{});child.stdin.end(data);
  });
}
async function assertNoListener(){
  const code="$p=@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object {$_.CommandLine -match 'event-expense-worker\\.mjs'}); if($p.Count -gt 0){exit 7}";
  try{await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true});}
  catch{throw Error('A receipt listener may be running on this machine; import refused');}
}
async function writeNew(p,value){await writeFile(p,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
function configValid(v){return v?.baseUrl==='https://line-webhook-xiju.vercel.app'&&/^[a-f0-9-]{36}$/.test(v.workerId||'');}
function validatePayload(v){
  if(!configValid(v?.config)||!/^[-A-Za-z0-9_]{43}$/.test(v.workerToken||'')||!v.runner?.apiKey?.startsWith('sk-')||typeof v.runner.model!=='string'||!v.runner.model||['worker-key.dpapi','runner-key.dpapi'].some(n=>!/^[a-f0-9]{64}$/.test(v.sourceCipherHashes?.[n]||'')))throw Error('Invalid protected worker payload');
}

async function main(){
  if(process.platform!=='win32')throw Error('This handover helper requires Windows');
  const me=await identity();
  if(mode==='source-info'){
    if(await exists(sourceFile)){const s=await json(sourceFile);if(s.binding!==me.binding)throw Error('Source computer already recorded; do not replace it');return {sourceComputer:s.computer,recorded:true};}
    await restrict(HERE);await writeNew(sourceFile,{...me,createdAt:new Date().toISOString()});return {sourceComputer:me.computer,recorded:true};
  }
  const source=await json(sourceFile);
  if(!/^[a-f0-9]{64}$/.test(source.binding||''))throw Error('Missing valid source computer record');
  if(mode==='selftest'){
    const clear=randomBytes(32),sealed=await protectedBytes(clear),back=await protectedBytes(sealed,true);
    const passed=clear.equals(back);clear.fill(0);back.fill(0);if(!passed)throw Error('Windows protection self-test failed');
    return {windowsProtection:true,computer:me.computer,isSource:source.binding===me.binding,networkCalls:0,credentialsExported:false};
  }
  if(mode==='receiver-init'){
    if(me.binding===source.binding)throw Error('Run receiver-init on the NEW computer, not the old source computer');
    if(await exists(publicFile)||await exists(privateFile))throw Error('Receiver already initialized; inspect existing files instead of replacing them');
    await assertNoListener();await restrict(HERE);
    const keys=await keypair('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'der'}});
    try{await writeFile(privateFile,await protectedBytes(keys.privateKey),{flag:'wx',mode:0o600});}finally{keys.privateKey.fill(0);}
    const fp=fingerprint(keys.publicKey);await writeNew(publicFile,{format:'line-windows-recipient-v1',...me,fingerprint:fp,publicKey:keys.publicKey,createdAt:new Date().toISOString()});
    return {publicFile,recipientFingerprint:fp,computer:me.computer,privateKeyRemainsOnThisComputer:true,networkCalls:0};
  }
  if(mode==='export'){
    if(me.binding!==source.binding)throw Error('Export must run on the OLD source computer');
    const target=await json(path.resolve(inputFile||''));
    if(target?.format!=='line-windows-recipient-v1'||target.binding===source.binding||!/^[a-f0-9]{64}$/.test(target.binding||'')||target.fingerprint!==expectedFingerprint||fingerprint(target.publicKey)!==expectedFingerprint)throw Error('New-computer public identity does not match the supplied fingerprint');
    const config=await json(path.join(BROWSER,'config.json'));
    const workerCipher=await readFile(path.join(BROWSER,'worker-key.dpapi')),runnerCipher=await readFile(path.join(BROWSER,'runner-key.dpapi'));
    const workerClear=await protectedBytes(workerCipher,true),runnerClear=await protectedBytes(runnerCipher,true);
    try{
      const runner=JSON.parse(runnerClear.toString('utf8'));runner.model||='gpt-4.1-mini';
      const payload={config,workerToken:workerClear.toString('ascii'),runner,receiverBinding:target.binding,sourceCipherHashes:{'worker-key.dpapi':digest(workerCipher),'runner-key.dpapi':digest(runnerCipher)}};
      validatePayload(payload);const envelope=seal(payload,target.publicKey,expectedFingerprint,source.binding);
      const file=path.join(HERE,'worker-transfer-'+Date.now()+'.encrypted.json');await writeNew(file,envelope);
      return {encryptedFile:file,sha256:digest(await readFile(file)),recipientFingerprint:expectedFingerprint,recipientComputer:target.computer,networkCalls:0,plaintextSecretFiles:0};
    }finally{workerClear.fill(0);runnerClear.fill(0);}
  }
  if(mode==='import'){
    if(me.binding===source.binding)throw Error('Import must run on the NEW computer');
    await assertNoListener();const target=await json(publicFile);
    if(target.binding!==me.binding)throw Error('Receiver was prepared for a different Windows account');
    const envelopeBytes=await readFile(path.resolve(inputFile||''));if(envelopeBytes.length>262144)throw Error('Transfer file is too large');
    const envelopeHash=digest(envelopeBytes),receiptFile=path.join(HERE,'import-result.json');
    if(await exists(receiptFile)){const r=await json(receiptFile);if(r.envelopeHash===envelopeHash&&r.imported===true)return {...r,alreadyImported:true};throw Error('A different import is already recorded; inspect before replacing it');}
    const privateDer=await protectedBytes(await readFile(privateFile),true);let privateKey;
    try{privateKey=createPrivateKey({key:privateDer,type:'pkcs8',format:'der'});}finally{privateDer.fill(0);}
    const payload=unseal(JSON.parse(envelopeBytes.toString('utf8')),privateKey,source.binding);validatePayload(payload);
    if(payload.receiverBinding!==me.binding||target.fingerprint!==fingerprint(privateKey))throw Error('Protected payload targets another Windows account');
    if(await exists(path.join(BROWSER,'config.json'))){const c=await json(path.join(BROWSER,'config.json'));if(!configValid(c)||c.workerId!==payload.config.workerId)throw Error('Existing worker configuration differs; import refused');}
    for(const name of ['worker-key.dpapi','runner-key.dpapi'])if(await exists(path.join(BROWSER,name))&&digest(await readFile(path.join(BROWSER,name)))!==payload.sourceCipherHashes[name])throw Error('Existing credential differs from the old backup; import refused');
    await restrict(BROWSER);
    const workerClear=Buffer.from(payload.workerToken),runnerClear=Buffer.from(JSON.stringify(payload.runner));
    try{
      const protectedFiles=[['worker-key.dpapi',await protectedBytes(workerClear)],['runner-key.dpapi',await protectedBytes(runnerClear)]];
      for(const [name,data] of protectedFiles){const test=await protectedBytes(data,true),expected=name==='worker-key.dpapi'?workerClear:runnerClear;try{if(!test.equals(expected))throw Error('New Windows credential verification failed');}finally{test.fill(0);}}
      // Validate every target before any replacement. Keep original ciphertexts.
      for(const [name] of protectedFiles){const original=path.join(BROWSER,name),backup=original+'.before-machine-transfer';if(await exists(original)){if(await exists(backup))throw Error('Prior import backup exists; inspect an interrupted import');await copyFile(original,backup);}}
      for(const [name,data] of protectedFiles){const original=path.join(BROWSER,name),temp=original+'.'+randomUUID()+'.tmp';await writeFile(temp,data,{flag:'wx',mode:0o600});await rename(temp,original);}
      const cfg=path.join(BROWSER,'config.json');if(!await exists(cfg))await writeNew(cfg,payload.config);
      const result={imported:true,envelopeHash,computer:me.computer,workerId:payload.config.workerId,createdAt:new Date().toISOString(),workerStarted:false,networkCalls:0};await writeNew(receiptFile,result);return result;
    }finally{workerClear.fill(0);runnerClear.fill(0);}
  }
  throw Error('Use source-info | selftest | receiver-init | export PUBLIC_FILE EXPECTED_FINGERPRINT | import ENCRYPTED_FILE');
}
main().then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{process.stderr.write(String(e.message)+'\n');process.exitCode=1;});
