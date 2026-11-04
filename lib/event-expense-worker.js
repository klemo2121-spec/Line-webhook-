import {buildDirectExpensePlan,normalizePayee} from './direct-expense-policy.js';

function missingFact(receipt,error){
  if(!receipt?.date||/date|readability/.test(error.message)&&receipt.readable!==true)return 'date';
  if(typeof receipt?.total!=='number'||receipt.total<=0)return 'amount';
  if(!receipt.vendor&&!receipt.payeeName||/identity|Supplier\/payee/.test(error.message))return 'identity';
  if(/purpose|category/.test(error.message))return 'purpose';
  return null;
}

// The image reader proposes facts only. This deterministic coordinator owns all
// accounting operations, uses server-built plans, and never retries a create.
export function createEventExpenseProcessor({worker,gateway,extract,loadExtraction=async()=>null,markExtractionStarted=async()=>{},saveExtraction=async()=>{},onState=async()=>{}}){
  let running;
  async function processQueue(){
    let processed=0,rules,currentJobId;
    try{
      while(processed<20){
        let current=await worker('direct_claim',{});
        if(current.idle){await onState({state:'waiting',processed});return {idle:true,processed};}
        if(current.completed){processed++;continue;}
        if(current.awaitingInfo){processed++;continue;}
        if(current.blocked)throw Error(current.reason||'Receipt needs review');
        let job=current.job;const id=job?.id;
        if(!id||job.workflow!=='mcp_individual_v1')throw Error('Unsupported receipt workflow');
        currentJobId=id;
        await onState({state:'processing',jobId:id});
        if(job.status==='claimed'&&!job.plan){
          rules||=(await worker('direct_rules',{})).config;
          if(!rules)throw Error('Private recognition rules are unavailable');
          let receipt=await loadExtraction(current,rules);
          if(!receipt){await markExtractionStarted(current,rules);receipt=await extract(current,rules);await saveExtraction(current,rules,receipt);}
          // Owner captions can arrive while the image is being read. Re-read
          // their latest data before deciding that anything needs a question.
          const latest=await worker('direct_context',{id});
          if(latest.job?.status!=='claimed'||latest.job.plan)throw Error('Receipt state changed during reading');
          current={...current,...latest};job=current.job;
          const contextVersion=job.contextVersion||0;
          if(receipt.kind==='other'){
            // Classification is a model opinion, never authority to discard an
            // original. Bank-app screenshots are frequently valid payment slips.
            if((await worker('request_info',{id,question:'document',contextVersion})).retry)continue;
            processed++;continue;
          }
          let plan;
          try{plan=buildDirectExpensePlan(receipt,current,rules);}
          catch(error){
            const question=missingFact(receipt,error);
            if(!question)throw error;
            if((await worker('request_info',{id,question,contextVersion})).retry)continue;
            processed++;continue;
          }
          const name=plan.document.contact_name;
          const result=await gateway('contacts',{id,search:name});
          if(result.hasMore)throw Error('Contact search is incomplete; review before choosing a payee');
          const rule=rules.payeeRules.find(r=>r.id===plan.recognition?.id);
          const aliases=[name,...(rule?.aliases||[])].map(normalizePayee);
          const matches=result.contacts.filter(c=>aliases.includes(normalizePayee(c.name)));
          const unique=[...new Map(matches.map(c=>[c.id,c])).values()];
          if(unique.length>1){if((await worker('request_info',{id,question:'identity',contextVersion})).retry)continue;processed++;continue;}
          const existingContact=unique[0];
          const payload={id,receipt,contextVersion,...(existingContact?{existingContact}:{})};
          let preview;
          try{preview=await gateway('preview',payload);}
          catch(error){
            if(error.question){if((await worker('request_info',{id,question:error.question,contextVersion})).retry)continue;processed++;continue;}
            throw error;
          }
          if(preview.retry)continue;
          const planned=await worker('direct_plan',{...payload,preview});
          if(planned.retry)continue;
          job.status=planned.status;job.plan=planned.plan;
        }
        if(job.status==='planned'){
          // Submit persists write-started on the server before the ONE call.
          // A transport error goes to recovery on the next event, never here again.
          await gateway('submit',{id});job.status='writing';
        }
        if(['writing','saved'].includes(job.status)){
          await gateway('verify',{id});
          await worker('direct_complete',{id,documentVerified:true});
          processed++;await onState({state:'completed',jobId:id});
        }else throw Error('Receipt state needs reconciliation');
      }
      return {more:true,processed};
    }catch(error){await onState({state:'blocked',jobId:currentJobId,reason:String(error.message).slice(0,250)});throw error;}
  }
  return {drain(){if(running)return running;running=processQueue().finally(()=>{running=null;});return running;}};
}

export function parseWakeFrames(buffer,chunk){
  const parts=(buffer+chunk).replaceAll('\r\n','\n').split('\n\n');
  const tail=parts.pop();
  const wake=parts.some(frame=>frame.split('\n').filter(l=>l.startsWith('data:')).some(line=>{
    const data=line.slice(5).trim();
    if(/^(?:subscribe|message),/.test(data))return true;
    try{const j=JSON.parse(data),v=j.result||j;return Array.isArray(v)&&['subscribe','message'].includes(v[0]);}catch{return false;}
  }));
  if(tail.length>65536)throw Error('Invalid event frame');
  return {tail,wake};
}
