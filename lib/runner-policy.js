import { monthEnd } from './months.js';
export const categories={'General expenses':'ค่าใช้จ่ายทั่วไป','Messenger/Postage':'ค่าส่งเอกสาร/เมสเซนเจอร์/ไปรษณีย์',Electricity:'ค่าไฟ'};
export function attachmentReceipt(receipt,job){
  const r={...receipt};
  if(r.kind==='payment_slip'&&['online','petty_cash','electricity'].includes(job.override?.bucket)){
    r.uncertainties=(r.uncertainties||[]).filter(x=>!['unknown_purpose','unknown_category'].includes(x));
    r.bucket=job.override.bucket;r.expenseOnly=false;
  }
  return r;
}
export function receiptPlan(r, current) {
  if(!r||!['receipt','payment_slip'].includes(r.kind)||r.readable!==true||r.currency!=='THB'||typeof r.total!=='number'||r.total<=0||!/^20\d\d-\d\d-\d\d$/.test(r.date||'')||new Date(r.date+'T00:00:00Z').toISOString().slice(0,10)!==r.date||!r.vendor||r.uncertainties?.length)throw Error('Receipt needs review');
  if(r.kind==='receipt'&&(!categories[r.category]||r.expenseOnly!==true||Number(r.withholding)!==0))throw Error('Expense purpose/category needs review');
  if(r.kind==='payment_slip'&&!['online','petty_cash','electricity'].includes(current.job.override?.bucket))throw Error('Monthly group needs review');
  const month=current.job.override.month||r.date.slice(0,7),bucket=current.job.override.bucket||r.bucket;
  if(!['online','petty_cash','electricity'].includes(bucket))throw Error('Monthly group needs review');
  return {companyId:current.companyId,month,bucket,date:monthEnd(month),receipt:r,status:'awaiting',paid:0};
}
export function assertAwaiting(text) {
  if(/ชำระเงินแล้ว|paid|approved|อนุมัติแล้ว/i.test(text)||!/รอดำเนินการ|awaiting/i.test(text))throw Error('Target document is paid, approved or has unknown status');
}
export function assertCompanyUrl(url,ref) {
  const u=new URL(url);
  if(u.origin!=='https://advance.flowaccount.com'||!u.pathname.startsWith('/'+ref+'/business/expenses'))throw Error('FlowAccount login/company needs attention');
}
export function wakeFrames(buffer,chunk) {
  const text=(buffer+chunk).replace(/\r\n/g,'\n');const parts=text.split('\n\n');
  return {tail:parts.pop(),wake:parts.some(frame=>/^data:\s*(?:subscribe|message),/m.test(frame))};
}
