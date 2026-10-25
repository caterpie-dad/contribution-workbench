import {hash,TeamConfig} from '../config.js';
import {splitEvidence} from '../evaluation/validate.js';
import {sourceProfile,effectiveRoles} from '../evaluation/provenance.js';
export function sourceFacts(e:any,t:TeamConfig,corrections:any[]){return {generation:'deterministic_source_facts',assessment_status:'source_facts_indexed',parts:[],units:splitEvidence(e,t).map(u=>u.unit_id),facts:{source_hash:hash(e.body),title:e.title,kind:e.kind,profile:sourceProfile(e),roles:effectiveRoles(e,t,corrections)},notice:'코드가 원문·역할·변경 형태를 색인했습니다. 개별 커밋의 의도·난도·품질을 AI로 채점한 결과가 아닙니다. 기능 단위 평가에서 전체 원문을 사용합니다.'};}
