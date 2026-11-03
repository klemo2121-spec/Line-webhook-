import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { categories, assertAwaiting, assertCompanyUrl } from './runner-policy.js';
import {ensureLiveEngine} from './live-receipt-engine.mjs';
const names={online:/Online\s+shop/i,petty_cash:/Petty\s+cash\s+box/i,electricity:/PEA|Electricity/i};
const serialOf=text=>text.match(/EXP\d{10}/)?.[0];
const amountOf=text=>Number(text.replace(/,/g,'').match(/\d+\.\d{2}/)?.[0]);
export class FlowBrowserRunner {
  constructor(page,companyRef){this.page=page;this.ref=companyRef;ensureLiveEngine(page,companyRef,()=>new FlowBrowserRunner(page,companyRef));}
  async openList(){
    const p=this.page,u=new URL(p.url()),route=`/${this.ref}/business/expenses`;
    if(u.origin!=='https://advance.flowaccount.com'||!u.pathname.startsWith('/'+this.ref+'/'))throw Error('FlowAccount login/company needs attention');
    const form=p.locator('#documentForm');
    if(await form.count()){
      const save=form.getByRole('button',{name:/^บันทึกเอกสาร$|^Save$/});
      if(await save.count()&&!await save.isDisabled())throw Error('Unresolved edited document; refusing navigation');
      await form.getByRole('button',{name:/^ปิดหน้าต่าง$|^Close window$/}).click();await form.waitFor({state:'detached'});
    }
    if(new URL(p.url()).pathname!==route){await p.locator(`a[href$="${route}"]`).first().click();await p.waitForURL(url=>url.pathname===route);}
    const tutorial=p.getByRole('dialog').filter({hasText:'บันทึกจ่ายชำระหนี้จ่ายเงินทุน กับ FlowAccount'});
    if(await tutorial.isVisible().catch(()=>false))await tutorial.getByRole('button',{name:'ปิดหน้าต่าง',exact:true}).click();
    await p.getByRole('button',{name:/^สร้างใหม่$|^New$|^Create new$/}).waitFor();assertCompanyUrl(p.url(),this.ref);
  }
  async rows(){return this.page.getByRole('row').filter({hasText:/EXP\d{10}/}).all();}
  async findTarget(plan){
    await this.openList();const hits=[];
    for(let n=0;n<10;n++){
      for(const row of await this.rows()){
        const text=await row.innerText(),serial=serialOf(text);
        if(serial?.startsWith('EXP'+plan.month.replace('-',''))&&names[plan.bucket].test(text))hits.push({serial,text,total:amountOf(text)});
      }
      const next=this.page.getByRole('button',{name:'go to next page',exact:true});
      if(!await next.count()||await next.isDisabled())break;
      const before=(await this.rows())[0];const first=before?await before.innerText():'';
      await next.click();await this.page.waitForFunction(old=>{const rows=[...document.querySelectorAll('tr')];return rows.some(r=>/EXP\d{10}/.test(r.innerText))&&!rows.some(r=>r.innerText===old);},first,{timeout:10000});
      if(n===9)throw Error('Expense list exceeds verified page bound');
    }
    if(hits.length>1)throw Error('More than one monthly document');
    if(hits.length){assertAwaiting(hits[0].text);if(!Number.isFinite(hits[0].total))throw Error('Unreadable existing total');}
    return hits[0];
  }
  async openSerial(serial){await this.openList();for(let n=0;n<10;n++){
    const row=this.page.getByRole('row').filter({hasText:serial});
    if(await row.count()===1){
      try {await row.getByText(serial,{exact:true}).click({timeout:10000});await this.page.locator('#documentForm').waitFor({timeout:10000});await this.page.waitForURL(/\/expenses\/\d+$/,{timeout:10000});}
      catch(error){console.error('Document navigation diagnostic:',error.message);throw error;}
      return this.page.locator('#documentForm');
    }
    const next=this.page.getByRole('button',{name:'go to next page',exact:true});if(!await next.count()||await next.isDisabled())break;
    await next.click();await this.page.waitForTimeout(500);
  }throw Error('Saved document not found');}
  async prepare(plan,target,job){
    const p=this.page;
    if(target)await this.openSerial(target.serial);
    else {await this.openList();await p.getByRole('button',{name:/^สร้างใหม่$|^New$/}).click();await p.getByText(/^เอกสารค่าใช้จ่าย/).click();await p.locator('#documentForm').waitFor();}
    const form=p.locator('#documentForm');
    const before=await form.getByRole('row').allTextContents();
    if(before.some(t=>t.includes(`[LINE:${job.id}]`)))throw Error('Receipt marker already exists; reconcile instead of replaying');
    if(plan.receipt.kind==='payment_slip'&&!target)throw Error('Bank slip requires existing document');
    if(plan.receipt.kind==='receipt'){
      if(!target){
        const label={online:'Online shopping',petty_cash:'Petty cash box',electricity:'PEA (Electricity)'}[plan.bucket];
        await form.getByPlaceholder(/เลือกผู้จำหน่าย|Select supplier/i).fill(`${label} (${plan.month})`);
        for(const id of ['publishedOnPicker','dueDatePicker']){const date=form.locator('#'+id+' input');await date.fill(plan.date.split('-').reverse().join('-'));await date.press('Tab');}
      } else await form.getByRole('button',{name:/^เพิ่มแถวรายการ$|^Add line$/}).click();
      const rows=form.getByRole('row').filter({has: p.getByPlaceholder(/รายละเอียด \(กด Shift|Description/i)});
      const row=target?rows.last():rows.first();
      await row.getByPlaceholder(/รายละเอียด \(กด Shift|Description/i).fill(`${plan.receipt.description} [LINE:${job.id}]`);
      const category=row.getByPlaceholder(/กรุณาเลือก|Please select/i);await category.fill(categories[plan.receipt.category]);
      await row.getByRole('link').filter({hasText:categories[plan.receipt.category]}).last().click();
      const inputs=row.locator('input');if(await inputs.count()!==4)throw Error('Expense row layout changed');
      await inputs.nth(1).fill('1');await inputs.nth(3).fill(String(plan.receipt.total));await inputs.nth(3).press('Tab');
      for(const id of ['isVat','isWithholding'])if(await form.locator('#'+id).isChecked())throw Error('Unexpected tax settings');
      if(Number(await form.locator('#discount-percentage-input').inputValue())!==0)throw Error('Unexpected discount');
    }
    return {before};
  }
  async saveAndAttach(plan,target,current,before){
    const p=this.page,form=p.locator('#documentForm');
    if(plan.receipt.kind==='receipt'){
      await form.getByRole('button',{name:/^บันทึกเอกสาร$|^Save$/}).click();
      await form.getByRole('button',{name:/^บันทึกเอกสาร$|^Save$/}).waitFor({state:'visible'});
      await p.waitForFunction(()=>{const f=document.querySelector('#documentForm');return f&&[...f.querySelectorAll('button')].some(b=>/^(บันทึกเอกสาร|Save)$/.test(b.innerText.trim())&&b.disabled);});
    }
    const serial=(await form.innerText()).match(/EXP\d{10}/)?.[0];if(!serial)throw Error('Missing saved serial');
    if(!await form.getByText(current.job.filename,{exact:true}).count()){
      const choosing=p.waitForEvent('filechooser');await form.getByText(/คลิกเพื่อเลือกไฟล์|Browse to upload/).click();await(await choosing).setFiles(current.imagePath);
      await form.getByText(current.job.filename,{exact:true}).waitFor();
    }
    await form.getByRole('button',{name:/^ปิดหน้าต่าง$|^Close window$/}).click();
    const reopened=await this.openSerial(serial);assertAwaiting(await reopened.innerText());
    const marker=`[LINE:${current.job.id}]`,texts=await reopened.getByRole('row').allTextContents();
    if(plan.receipt.kind==='receipt'&&texts.filter(t=>t.includes(marker)).length!==1)throw Error('Saved receipt marker must occur once');
    for(const old of before.filter(t=>/\d+\.\d{2}/.test(t)&&!/รายละเอียด \(กด Shift|Description/.test(t)))if(!texts.includes(old))throw Error('Existing line changed');
    const date=await reopened.locator('#publishedOnPicker input').inputValue();if(date!==plan.date.split('-').reverse().join('-'))throw Error('Saved month mismatch');
    const text=await reopened.innerText(),expected=plan.afterTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    if(!text.includes(expected))throw Error('Saved total not verified');
    for(const id of ['isVat','isWithholding'])if(await reopened.locator('#'+id).isChecked())throw Error('Saved tax settings mismatch');
    await reopened.getByText(current.job.filename,{exact:true}).click();
    const downloadEvent=p.waitForEvent('download');await p.getByRole('button',{name:/^ดาวน์โหลด$|^Download$/}).last().click();const download=await downloadEvent;
    const bytes=await readFile(await download.path());if(createHash('sha256').update(bytes).digest('hex')!==current.job.imageHash)throw Error('Downloaded attachment differs from original');
    const recordId=p.url().match(/\/expenses\/(\d+)$/)?.[1];if(!recordId)throw Error('Missing saved record ID');
    return {companyId:current.companyId,serial,recordId,date:plan.date,status:'awaiting',paid:0,total:plan.afterTotal,...(plan.receipt.kind==='receipt'?{marker}:{})};
  }
}
