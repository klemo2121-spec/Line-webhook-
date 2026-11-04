// Live private Redis smoke test in a unique disposable test namespace.
// Input file contains credentials temporarily; never prints it or copies it.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createExpenseStore } from '../lib/expense-store.js';
import { createBrowserJobs } from '../lib/browser-jobs.js';
const config = JSON.parse(await readFile(process.argv[2],'utf8'));
const env = { BROWSER_WORKER_ENABLED:'true',EXPENSE_GROUP_IDS:'TEST',EXPENSE_USER_IDS:'TEST',FLOWACCOUNT_COMPANY_ID:'7',FLOWACCOUNT_OAUTH_ENCRYPTION_KEY:Buffer.alloc(32,45).toString('base64'),UPSTASH_REDIS_REST_URL:config.url,UPSTASH_REDIS_REST_TOKEN:config.token };
const redis=createExpenseStore({env}),namespace=`line-expenses:browser:test:${randomUUID()}:`,workerId=randomUUID();
try {
  const jobs=createBrowserJobs({env,redis,storagePrefix:namespace,downloadLineImage:async()=>({contentType:'image/jpeg',base64:Buffer.from('disposable-storage-test').toString('base64')})});
  await jobs.intake({type:'message',source:{groupId:'TEST',userId:'TEST'},message:{type:'image',id:'TEST',quoteToken:'TEST'}});
  const claimed=await jobs.work('claim',{workerId});assert.equal(claimed.job.status,'claimed');assert.equal(claimed.image.base64,Buffer.from('disposable-storage-test').toString('base64'));
  assert.equal(await redis(['LLEN',namespace+'pending']),1);
  console.log(JSON.stringify({liveRedis:'encrypted enqueue/claim passed',namespace:'isolated disposable test'}));
} finally {
  let cursor='0',keys=[];
  do { const page=await redis(['SCAN',cursor,'MATCH',namespace+'*','COUNT','100']);cursor=String(page[0]);keys.push(...page[1]); } while(cursor!=='0');
  if(keys.some(k=>!k.startsWith(namespace)))throw Error('Unexpected cleanup target');
  if(keys.length)await redis(['DEL',...keys]);
}
