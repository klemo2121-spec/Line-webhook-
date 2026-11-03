import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {FlowBrowserRunner} from '../lib/flow-browser-runner.mjs';
test('browser navigation resets pagination and reads role-based rows through the last disabled page',async t=>{
  let chromium;
  try{({chromium}=await import(pathToFileURL(path.join(process.env.USERPROFILE||'', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href));}
  catch{t.skip('Local browser runtime not installed');return;}
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<html><head><meta charset="utf-8"></head><body>
      <a href="/N270466/business/expenses">Expenses</a><button>สร้างใหม่</button>
      <div role="columnheader"><span class="multiple" onclick="document.getElementById('sort').className='sort-btn sort-desc'">วันที่</span><span id="sort" class="sort-btn sort-unset"></span></div><div role="table"><div id="rows"></div></div>
      <li id="first"><button aria-label="go to first page" onclick="i=0;draw()">First</button></li>
      <li id="next"><button aria-label="go to next page" onclick="if(i<1){i++;draw()}">Next</button></li>
      <script>let i=1;function draw(){document.getElementById('rows').innerHTML='<div role="row">'+(i===0?'30-11-2026 EXP2026110001 Online shopping (November) 949.00 รอดำเนินการ':'31-10-2026 EXP2026100001 Other 25.00 รอดำเนินการ')+'</div>';document.getElementById('first').className=i===0?'disabled':'';document.getElementById('next').className=i===1?'disabled':'';}draw();</script>
    </body></html>`}));
    await page.goto('https://advance.flowaccount.com/N270466/business/expenses',{waitUntil:'domcontentloaded',timeout:30000});
    const driver=new FlowBrowserRunner(page,'N270466',{registerEngine:false});
    const target=await driver.findTarget({month:'2026-11',bucket:'online'});
    assert.equal(target.serial,'EXP2026110001');assert.equal(target.total,949);
  }finally{await browser.close();}
});
