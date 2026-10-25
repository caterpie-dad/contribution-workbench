import React,{useState} from 'react';
import {assignedRepositories} from '../src/management/participation.js';
type Row=Record<string,any>;
const kinds:Record<string,string>={development:'기능 개발',improvement:'기능 개선',documentation:'문서·사용 안내',quality:'품질·검증',maintenance:'유지관리',design:'설계·분석',assets:'프로젝트 자료'};
const activityLanguage=(text:string)=>text.replace(/메타데이터/g,'부가 정보').replace(/파일 핸들링/g,'파일 사용');
const dimensions:Record<string,string>={problem_solving:'문제 해결',implementation_scope_and_consistency:'구현 완결성',verification:'검증',collaboration:'협업',reusable_knowledge:'재사용 지식'};
export function Difficulty({level,label='구현 난도'}:{level:number|null;label?:string}){
  const names=['분석 중','기초','보통','중상','높음','매우 높음'];
  return <div className="difficulty-scale"><div><span>{label}</span><strong>{level?names[level]:'분석 중'} <small>{level?`${level} / 5`:''}</small></strong></div><div className="difficulty-segments" aria-label={label+' '+(level??'분석 중')}>{[1,2,3,4,5].map(n=><i key={n} className={level&&n<=level?'filled':''}/>)}</div></div>;
}
function RepoChips({ids,onRepository}:{ids:string[];onRepository?:(id:string)=>void}){return <div className="repo-chips">{ids.map(id=>onRepository?<button key={id} onClick={()=>onRepository(id)}><span>⌘</span>{id} ↗</button>:<span key={id}><b>⌘</b>{id}</span>)}</div>;}
function Activities({items,compact=false,onCorrect}:{items:Row[];compact?:boolean;onCorrect?:(ids:string[])=>void}){return <div className={'activity-list'+(compact?' compact':'')}>{items.map((a,i)=><article className="activity-item" key={i}><div className={'activity-icon '+a.kind}>{a.kind==='documentation'?'▤':a.kind==='quality'?'✓':a.kind==='assets'?'▧':'⌘'}</div><div className="activity-copy"><div className="activity-topline"><span className={'activity-kind '+a.kind}>{kinds[a.kind]||'주요 활동'}</span>{a.delivery==='branch'&&<span className="delivery-label">브랜치 작업</span>}{a.delivery==='mixed'&&<span className="delivery-label">일부 반영</span>}{!compact&&<span className="activity-repo">{a.repository_id}</span>}</div><h3>{activityLanguage(a.title)}</h3>{!compact&&<p>{activityLanguage(a.outcome)}</p>}{a.quality_note&&<span className="quality-label">{a.quality_note}</span>}{onCorrect&&<button className="activity-correct text-button" onClick={()=>onCorrect(a.feature_ids)}>내용 교정</button>}</div>{!compact&&a.difficulty&&<span className="activity-difficulty">과제 난도 <b>{a.difficulty}</b>/5</span>}</article>)}</div>;}

export function RepositoryEvaluation({repositories,briefs,memberBriefs,profiles,people,features,period,canCorrect,focusId,onPerson,onEvidence,onCorrect}:{repositories:Row[];briefs:Row[];memberBriefs:Row[];profiles:Row[];people:Row[];features:Row[];period?:Row;canCorrect:boolean;focusId:string;onPerson:(id:string)=>void;onEvidence:(id:string)=>void;onCorrect:(repo:Row)=>void}){
  const [search,setSearch]=useState('');
  const visible=repositories.filter(r=>(r.repository_id+' '+(briefs.find(b=>b.repository_id===r.repository_id)?.purpose||'')).toLowerCase().includes(search.toLowerCase()));
  return <section className="repository-evaluation"><div className="evaluation-section-heading"><div><span className="eyebrow">REPOSITORY PORTFOLIO</span><h2>팀이 만드는 시스템 <span>{repositories.length}</span></h2></div><input aria-label="저장소 검색" placeholder="저장소 검색" value={search} onChange={e=>setSearch(e.target.value)}/></div><div className="repository-grid">{visible.map((repo,i)=>{
    const brief=briefs.find(b=>b.repository_id===repo.repository_id),profile=profiles.find(p=>p.repository_id===repo.repository_id);
    const related=people.filter(p=>assignedRepositories(p,period).includes(repo.repository_id)||features.some(f=>f.repository_id===repo.repository_id&&f.person_id===p.person_id));
    return <article className={'repository-card'+(focusId===repo.repository_id?' highlighted':'')} key={repo.repository_id} id={'repository-'+repo.repository_id}>
      <div className="repo-card-heading"><div className={'repo-symbol palette-'+i%3}>⌘</div><div><span className="eyebrow">{brief?.system_type||'시스템 분석 중'}</span><h2><a href={repo.url} target="_blank" rel="noreferrer">{brief?.display_name||repo.repository_id} <span>↗</span></a></h2></div><span className="repo-card-number">{String(i+1).padStart(2,'0')}</span></div>
      <p className="repo-card-purpose">{brief?.purpose||'저장소 전체 구조를 분석하고 있습니다.'}</p>
      <div className="tech-stack">{(brief?.technology_stack||[]).map((s:string)=><span key={s}>{s}</span>)}</div>
      <div className="repo-functions"><span className="card-label">핵심 기능</span><div>{(brief?.capabilities||[]).map((s:string,j:number)=><div key={j}><span>✓</span>{s}</div>)}</div></div>
      <div className="repo-difficulty-block"><Difficulty level={brief?.difficulty.level??profile?.difficulty.level??null}/>{brief?.difficulty.reason&&<p>{brief.difficulty.reason}</p>}</div>
      <div className="repo-participants"><div className="card-label">참여 팀원 <b>{related.length}</b></div><div>{related.map((p:Row)=>{const active=memberBriefs.find(b=>b.person_id===p.person_id)?.activities?.filter((a:Row)=>a.repository_id===repo.repository_id)||[];return <button className="participant-chip" key={p.person_id} onClick={()=>onPerson(p.person_id)}><span>{p.display_name.slice(-2)}</span>{p.display_name}<small>{[...new Set(active.map((a:Row)=>kinds[a.kind]))].slice(0,2).join(' · ')||'담당'}</small></button>;})}</div></div>
      <footer><button className="text-button" onClick={()=>onEvidence(repo.repository_id)}>근거 보기 ↗</button><button className="text-button" disabled={!canCorrect||!profile} onClick={()=>profile&&onCorrect(profile)}>설명·난도 교정</button></footer>
    </article>;
  })}</div>{!visible.length&&<div className="empty">표시할 저장소가 없습니다.</div>}</section>;
}

export function MemberGrid({people,portfolios,briefs,decisions,onPerson,onRepository}:{people:Row[];portfolios:Row[];briefs:Row[];decisions:Row;onPerson:(id:string)=>void;onRepository:(id:string)=>void}){
  const [repoFilter,setRepoFilter]=useState('all'),[search,setSearch]=useState('');
  const allRepos=[...new Set(people.flatMap(p=>[...p.repository_assignments.map((a:Row)=>a.repository_id),...(briefs.find(b=>b.person_id===p.person_id)?.repository_ids||[])]))] as string[];
  const shown=people.filter(p=>{const ids=briefs.find(b=>b.person_id===p.person_id)?.repository_ids||p.repository_assignments.map((a:Row)=>a.repository_id);return (repoFilter==='all'||ids.includes(repoFilter))&&p.display_name.includes(search);});
  return <section><div className="evaluation-section-heading"><div><span className="eyebrow">TEAM CONTRIBUTIONS</span><h2>팀원별 주요 기여 <span>{people.length}</span></h2></div><div className="member-filters"><select aria-label="참여 저장소 필터" value={repoFilter} onChange={e=>setRepoFilter(e.target.value)}><option value="all">전체 저장소</option>{allRepos.map(r=><option key={r}>{r}</option>)}</select><input aria-label="팀원 검색" placeholder="팀원 검색" value={search} onChange={e=>setSearch(e.target.value)}/></div></div><div className="people-grid executive-people-grid">{shown.map((p,i)=>{
    const output=portfolios.find(x=>x.person_id===p.person_id)?.output,brief=briefs.find(b=>b.person_id===p.person_id),decision=decisions?.[p.person_id];
    return <article className="person-card executive-person-card" data-person-id={p.person_id} key={p.person_id}>
      <button className="person-open" disabled={!output} onClick={()=>onPerson(p.person_id)} aria-label={p.display_name+' 기여도 보기'}><div className={'avatar color-'+i%4}>{p.display_name.slice(-2)}</div><div><h3>{p.display_name}</h3><span>{decision?'관리자 검토 완료':brief?'기여도 분석 완료':'분석 중'}</span></div><span className="arrow">↗</span></button>
      <RepoChips ids={brief?.repository_ids||p.repository_assignments.map((a:Row)=>a.repository_id)} onRepository={onRepository}/>
      <h4 className="representative-activity-heading">대표 활동</h4>{brief?<><Activities items={brief.activities} compact/></>:<div className="card-skeleton"><i/><i/><i/></div>}
      <footer>{decision?.grade&&<span>{decision.grade}</span>}<button className="text-button" disabled={!output} onClick={()=>onPerson(p.person_id)}>평가 보기 →</button></footer>
    </article>;
  })}</div>{!shown.length&&<div className="empty">조건에 맞는 팀원이 없습니다.</div>}</section>;
}

export function MemberDetail({person,portfolio,brief,profiles,decision,review,canCorrect,onBack,onRepository,onEvidence,onReview,onCorrect}:{person:Row;portfolio:Row;brief?:Row;profiles:Row[];decision?:Row;review?:Row;canCorrect:boolean;onBack:()=>void;onRepository:(id:string)=>void;onEvidence:()=>void;onReview:()=>void;onCorrect:(ids:string[])=>void}){
  const repos=brief?.repository_ids||person.repository_assignments.map((a:Row)=>a.repository_id);
  const scored=Object.entries(dimensions).filter(([key])=>portfolio.dimensions?.[key]?.score!=null);
  const activityKinds=[...new Set((brief?.activities||[]).map((a:Row)=>kinds[a.kind]||'주요 활동'))] as string[];
  const levels=(brief?.activities||[]).map((a:Row)=>a.difficulty).filter((n:any)=>typeof n==='number');
  const delivery=(brief?.activities||[]).some((a:Row)=>a.delivery==='mixed')?'일부 반영':(brief?.activities||[]).some((a:Row)=>a.delivery==='branch')?((brief?.activities||[]).some((a:Row)=>a.delivery==='integrated')?'일부 반영':'브랜치 작업'):(brief?.activities||[]).some((a:Row)=>a.delivery==='integrated')?'기본 브랜치 반영':'자료 갱신';
  return <section className="member-detail"><div className="member-back-row"><button className="text-button" onClick={onBack}>← 팀원 목록</button><div><button className="secondary" onClick={onEvidence}>근거 보기 ↗</button><button className="secondary" disabled={!canCorrect||!!review} onClick={onReview}>{review?'관리자 검토 기록 있음':'원문 대조 · 관리자 검토'}</button></div></div>
    <div className="member-hero"><div className="avatar">{person.display_name.slice(-2)}</div><div><span className="eyebrow">CONTRIBUTION PROFILE</span><h2>{person.display_name}</h2><RepoChips ids={repos} onRepository={onRepository}/></div><div className="member-decision"><span>{decision?'관리자 최종 결정':review?'관리자 검토 기록 있음':'평가 상태'}</span><strong>{decision?.grade||'검토 중'}</strong></div></div>
    <div className="member-detail-layout"><section className="panel member-activities"><div className="section-heading"><h2>대표 활동</h2></div>{brief?<Activities items={brief.activities} onCorrect={canCorrect?onCorrect:undefined}/>:<div className="card-skeleton"><i/><i/></div>}</section>
    <section className="panel contribution-assessment"><span className="eyebrow">CONTRIBUTION ASSESSMENT</span><h2>기여도 평가</h2><dl className="contribution-facts"><div><dt>기여 분야</dt><dd>{activityKinds.map(k=><span key={k}>{k}</span>)}</dd></div>{levels.length>0&&<div><dt>대표 과제 난도</dt><dd><strong>{Math.max(...levels)}</strong><small> / 5</small></dd></div>}<div><dt>반영 범위</dt><dd>{delivery}</dd></div></dl>{scored.length>0&&<><div className="assessment-rows">{scored.map(([key,name])=>{const score=portfolio.dimensions[key].score;return <div className="assessment-row" key={key}><span>{name}</span><div className="assessment-dots">{[1,2,3,4,5].map(n=><i key={n} className={n<=score?'filled':''}/>)}</div><strong>{score}<small> / 5</small></strong></div>;})}</div><div className="assessment-scale"><span>1 · 심각한 미충족</span><span>3 · 역할에 부합</span><span>5 · 탁월</span></div></>}<div className="assessment-repositories"><span className="card-label">참여 시스템</span>{repos.map((id:string)=>{const r=profiles.find(r=>r.repository_id===id);return <button key={id} onClick={()=>onRepository(id)}><strong>{r?.display_name||id} ↗</strong><span>시스템 난도 {r?.difficulty.level??'—'} / 5</span></button>;})}</div></section></div>
  </section>;
}
