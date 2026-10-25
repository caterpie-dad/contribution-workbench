import {db} from '../db.js';
import {hash,redact} from '../config.js';
import {saveRaw} from '../storage.js';
export type Evidence={source_id:string;object_id:string;revision:string;kind:string;title:string;url:string;occurred_at:string|null;actors:string[];body:string;metadata:Record<string,any>};
export async function inventory(run:string,source:string,key:string,kind:string,status:string,details:unknown={}){const id=hash([run,source,key,kind]);await db.query(`INSERT INTO inventory(id,collection_id,source_id,object_key,kind,status,details) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,details=EXCLUDED.details`,[id,run,source,key,kind,status,details]);}
export async function storeEvidence(run:string,e:Evidence){const id=hash([run,e.source_id,e.object_id,e.revision,e.kind]);const raw=await saveRaw(e.body);await db.query(`INSERT INTO evidence(id,collection_id,source_id,object_id,revision,kind,title,url,occurred_at,actors,raw_hash,body,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,[id,run,e.source_id,e.object_id,e.revision,e.kind,e.title,e.url,e.occurred_at,JSON.stringify(e.actors),raw,e.body,e.metadata]);await inventory(run,e.source_id,e.object_id+'@'+e.revision,e.kind,'complete',{evidence_id:id,raw_hash:raw});return id;}
export async function gap(run:string,source:string,key:string,reason:unknown,populationKnown=false){await inventory(run,source,key,'capability','partial',{reason:redact(reason),population_known:populationKnown});}
export function authHeaders(auth:{scheme:string;token?:string|null;username?:string|null;password?:string|null}):Record<string,string>{if(auth.scheme==='basic')return {Authorization:'Basic '+Buffer.from(`${auth.username||''}:${auth.password||auth.token||''}`).toString('base64')};if(auth.token)return {Authorization:'Bearer '+auth.token};return {};}
export async function request(url:string,headers:Record<string,string>={},attempt=0):Promise<{body:any;next:string|null;rawHash:string}>{
  const response=await fetch(url,{headers:{Accept:'application/json',...headers},signal:AbortSignal.timeout(45000),redirect:'manual'});
  if([429,502,503,504].includes(response.status)&&attempt<2){await new Promise(r=>setTimeout(r,500*(attempt+1)));return request(url,headers,attempt+1);}
  if(!response.ok)throw new Error(`원본 조회 HTTP ${response.status}: ${new URL(url).pathname}`);
  const text=await response.text();const rawHash=await saveRaw(text);let body;try{body=JSON.parse(text);}catch{throw new Error('JSON 원본 대신 로그인 화면 또는 비정상 본문이 반환되었습니다');}
  const match=response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/);const next=match?.[1]||null;
  if(next&&new URL(next,url).origin!==new URL(url).origin)throw new Error('다른 origin의 pagination은 인증 전달 없이 검토해야 합니다');
  return {body,next,rawHash};
}
export async function paginate(url:string,headers:Record<string,string>,visit:(body:any,rawHash:string)=>Promise<void|boolean>){const seen=new Set<string>();let next:string|null=url;while(next){if(seen.has(next))throw new Error('반복 cursor 감지');seen.add(next);const current:string=next;const r=await request(current,headers);if(await visit(r.body,r.rawHash)===false)return;next=r.next?new URL(r.next,current).href:null;}}
