// CI status is an API fact, not an inference from a commit title or test code.
export function functionalExecutionEvidence(evidence:any[],related:any[],asOf:string){
  const commits=new Set(related.filter(e=>e.kind==='commit').map(e=>e.revision));
  const repositories=new Set(related.map(e=>e.source_id));const boundary=Date.parse(asOf);const results:any[]=[];
  for(const e of evidence){
    if(e.kind!=='ci_context'||!repositories.has(e.source_id)||!commits.has(e.metadata?.head_sha))continue;
    let body:any;try{body=JSON.parse(e.body);}catch{continue;}
    const checks=(Array.isArray(body.check_runs)?body.check_runs:[]).filter((c:any)=>c.status==='completed'&&c.completed_at&&Number.isFinite(Date.parse(c.completed_at))&&Date.parse(c.completed_at)<=boundary&&(!c.head_sha||c.head_sha===e.metadata.head_sha)).map((c:any)=>({id:String(c.id),name:String(c.name||'이름 미확인'),conclusion:c.conclusion||'unknown',completed_at:c.completed_at,url:c.html_url||e.url}));
    if(checks.length)results.push({source_id:e.id,url:e.url,head_sha:e.metadata.head_sha,checks});
  }
  return results;
}
export function executionObservation(results:any[]){
  const n=results.reduce((sum,r)=>sum+r.checks.length,0);
  return n?`연결된 커밋에서 기간 경계 이전에 완료된 CI check 결과 ${n}건을 확인했습니다. 각 결과의 상태와 범위는 별도 실행 근거에서 확인해야 합니다.`:'연결된 변경 원문을 확인했습니다. 수집 범위에서 CI·테스트 실행 결과는 확인하지 못했습니다.';
}
export function rejectUnobservedExecution(texts:string[],results:any[]){
  if(results.some(r=>r.checks.some((c:any)=>c.conclusion==='success')))return;
  for(const text of texts)for(const clause of text.split(/[\n.!?;,，]/)){
    const execution=/(?:테스트|CI|빌드|tests?|build).{0,65}(?:통과|성공|passed|succeeded)/i.test(clause);
    const unconfirmed=/미확인|확인하지 못|확인되지 않|확인할 수 없|검증되지|검증하지 못|검증할 수 없|제공되지|미제공|관찰되지|성공 여부|통과 여부|근거.{0,12}없|not (?:observed|verified|confirmed)|unverified|unknown|no evidence/i.test(clause);
    if(execution&&!unconfirmed)throw new Error('CI·테스트 실행 근거 없이 통과·성공을 단정할 수 없습니다. 코드·테스트 변경과 실행 결과를 구분하고 미확인 범위를 명시하세요');
  }
}
