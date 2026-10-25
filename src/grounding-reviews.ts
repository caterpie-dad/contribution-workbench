import {transaction} from './db.js';

// A human review is a separate, append-only record. It never changes AI output.
export async function reviewGrounding(id:string,personId:string,body:any,actor:string){
  if(typeof body.reason!=='string'||!body.reason.trim()||typeof body.reviewed_summary!=='string'||!body.reviewed_summary.trim())throw new Error('원문 검토 이유와 관리자가 확인한 설명이 필요합니다');
  if(!Array.isArray(body.citations)||!body.citations.length)throw new Error('검토에는 정확한 원문 인용이 필요합니다');
  return transaction(async c=>{
    const run=(await c.query('SELECT * FROM evaluation_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!run||run.status!=='review_required')throw new Error('관리자 검토 대기 중인 평가만 검토할 수 있습니다');
    const portfolio=(await c.query('SELECT output FROM portfolios WHERE evaluation_id=$1 AND person_id=$2',[id,personId])).rows[0]?.output;
    if(!portfolio?.generation?.startsWith('llm_'))throw new Error('AI 해석 초안의 관리자 검토 대상이 아닙니다');
    if(body.portfolio_hash!==portfolio.validation_hash)throw new Error('검토 대상 초안 버전이 다릅니다');
    for(const citation of body.citations){
      if(!portfolio.considered_evidence_ids.includes(citation.evidence_id)||typeof citation.quote!=='string'||citation.quote.trim().length<8)throw new Error('해당 팀원의 근거와 8자 이상의 원문 인용이 필요합니다');
      const evidence=(await c.query('SELECT body FROM evidence WHERE id=$1 AND collection_id=$2',[citation.evidence_id,run.collection_id])).rows[0];
      if(!evidence?.body.includes(citation.quote))throw new Error('검토 인용이 원문과 일치하지 않습니다');
    }
    await c.query('INSERT INTO grounding_reviews(evaluation_id,person_id,portfolio_hash,reviewed_summary,reason,citations,actor) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,personId,portfolio.validation_hash,body.reviewed_summary.trim(),body.reason.trim(),JSON.stringify(body.citations),actor]);
    await c.query('INSERT INTO audit_events(actor,action,target_id,details) VALUES($1,$2,$3,$4)',[actor,'grounding.manager_reviewed',id,{person_id:personId,portfolio_hash:portfolio.validation_hash,citations:body.citations}]);
    return {ok:true};
  });
}
