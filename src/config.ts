import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import './network.js';

export const root = process.cwd();
export const runtime = path.resolve(root, process.env.CONTRIB_RUNTIME || 'runtime');
const modelSchema = z.object({ model_id: z.string().min(1), display_name: z.string(), enabled: z.boolean(), context_limit_tokens: z.number().positive().nullable().optional(), reasoning_effort:z.enum(['none','minimal','low','medium','high','xhigh']).nullable().optional(), max_output_tokens:z.number().int().positive().nullable().optional() });
const authSchema = z.object({ scheme: z.enum(['none','bearer','basic']).default('bearer'), token: z.string().nullable().optional(), username: z.string().nullable().optional(), password: z.string().nullable().optional() });
const sourceSchema = z.object({ url: z.string().url(), deployment: z.string(), auth: authSchema, api_url: z.string().url().optional() });
const connectionsSchema = z.object({ example_only: z.literal(false), systems: z.object({
  github: sourceSchema,
  confluence: sourceSchema.extend({ transport: z.enum(['rest','mcp']).default('rest'), mcp: z.object({ command: z.string().optional(), args: z.array(z.string()).optional(), url: z.string().url().optional(), env: z.record(z.string(),z.string()).optional(), bindings: z.record(z.string(), z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()).default({}), result_path: z.string().optional() })).optional() }).optional() }),
  opencode: z.object({ server_url: z.string().url(), server_auth: authSchema, transport: z.enum(['sdk','cli']).default('sdk'), manage_process: z.boolean().default(true), llm: z.object({ url: z.string().url(), provider_id: z.string().min(1), protocol: z.enum(['responses','chat_completions']), token: z.string(), strict_tools:z.boolean().optional(), default_model_id: z.string(), models: z.array(modelSchema).min(1) }) })
}), application: z.object({ admin_username: z.string().min(1), admin_password: z.string().min(16), session_secret: z.string().min(32), database_url: z.string().min(1) }) });

export type Connections = z.infer<typeof connectionsSchema>;
export type TeamConfig = {
  schema_version?: string; example_only?: boolean; timezone: string;
  period: { start_inclusive: string; end_exclusive: string; as_of: string };
  sources: { github: { source_id: string; connection_ref: string; ref_scope: string[] }; confluence: { source_id: string; connection_ref: string; roots: {root_id:string;page_id?:string;page_url:string;include_root:boolean;repository_ids?:string[]}[]; [key:string]:unknown } };
  repositories: { repository_id:string;source_id:string;url:string;context_paths:string[]; docs_paths?:string[]; mirror_path?:string }[];
  members: {person_id:string;display_name:string;role_profile:string;identities:{github_login:string;commit_emails:string[];confluence_account_ref:string}; repository_assignments:{repository_id:string;expected_role:string;valid_from:string;valid_until_exclusive:string|null}[]}[];
  evaluation_policy: {rubric_version:string;weights:Record<string,number>;finalization:string;missing_score:null;artifact_mode?:'feature_first'|'full'};
  collection_policy: Record<string,unknown>;
  opencode?: Record<string,unknown>;
  demo?: { docs_surrogate:boolean; github_api:boolean; provenance_notice:string };
};

export function readConnections(): Connections {
  const filename = path.resolve(root, process.env.CONTRIB_CONNECTIONS_FILE || 'config/connections.local.json');
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(filename,'utf8')); } catch { throw new Error('연결 설정 파일을 읽을 수 없습니다: CONTRIB_CONNECTIONS_FILE'); }
  const result=connectionsSchema.safeParse(raw);
  if (!result.success) throw new Error('연결 설정 오류: '+result.error.issues.map(x=>x.path.join('.')+' '+x.code).join(', '));
  const c=result.data; const llm=c.systems.opencode.llm;
  if (new Set(llm.models.map(m=>m.model_id)).size!==llm.models.length) throw new Error('모델 ID가 중복됩니다');
  if (!llm.models.some(m=>m.model_id===llm.default_model_id&&m.enabled)) throw new Error('default_model_id는 사용 허용된 모델이어야 합니다');
  for(const url of [c.systems.github.url,c.systems.confluence.url,c.systems.opencode.server_url,llm.url]) { const u=new URL(url); if(u.username||u.password||u.search) throw new Error('연결 URL에는 자격 정보·query를 넣을 수 없습니다'); }
  return c;
}
export function safeConnections(c:Connections) { return { github:{url:c.systems.github.url,deployment:c.systems.github.deployment,configured:!!c.systems.github.auth.token}, confluence:{url:c.systems.confluence.url,deployment:c.systems.confluence.deployment,transport:c.systems.confluence.transport,configured:!!c.systems.confluence.auth.token||!!c.systems.confluence.mcp}, opencode:{server_url:c.systems.opencode.server_url,provider_id:c.systems.opencode.llm.provider_id,default_model_id:c.systems.opencode.llm.default_model_id,models:c.systems.opencode.llm.models,configured:!!c.systems.opencode.llm.token} }; }
export function resolveModel(c:Connections, selection?:{provider_id:string;model_id:string}) {
  const llm=c.systems.opencode.llm; const selected=selection||{provider_id:llm.provider_id,model_id:llm.default_model_id};
  const model=llm.models.find(m=>m.model_id===selected.model_id&&m.enabled);
  if(selected.provider_id!==llm.provider_id||!model) throw new Error('선택 모델이 허용 목록에 없습니다');
  return {...selected, context_limit_tokens:model.context_limit_tokens??null, protocol:llm.protocol,endpoint:llm.url,strict_tools:llm.strict_tools??(llm.provider_id==='openai'),reasoning_effort:model.reasoning_effort??null,max_output_tokens:model.max_output_tokens??null};
}
export type ResolvedModel = ReturnType<typeof resolveModel>;
export function validateModelSnapshot(c:Connections, snapshot:ResolvedModel) {
  const current=resolveModel(c,{provider_id:snapshot.provider_id,model_id:snapshot.model_id});
  for(const field of ['endpoint','protocol','strict_tools','context_limit_tokens','reasoning_effort','max_output_tokens'] as const) {
    if((snapshot[field]??null)!==(current[field]??null))throw new Error(`모델 ${field} 설정이 실행 snapshot과 다릅니다. 원 설정을 복원하거나 새 평가 실행을 만드세요`);
  }
  return snapshot;
}
export function hash(value:unknown) { return createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex'); }
export function validateTeam(raw:unknown):TeamConfig {
  if(!raw||typeof raw!=='object') throw new Error('팀 설정 객체가 필요합니다');
  function checkSecrets(value:unknown){if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(/^(token|password|api_key|apikey|authorization|session_secret)$/i.test(key))throw new Error('토큰·암호는 팀 설정에 저장할 수 없습니다');checkSecrets(item);}}
  checkSecrets(raw);
  const t=raw as TeamConfig;
  if(!Array.isArray(t.members)||!Array.isArray(t.repositories)||!t.sources||!t.period||!t.evaluation_policy) throw new Error('팀 설정 필수 항목이 누락되었습니다');
  const start=Date.parse(t.period.start_inclusive),end=Date.parse(t.period.end_exclusive);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end) throw new Error('평가 기간이 잘못되었습니다');
  if(!Number.isFinite(Date.parse(t.period.as_of)))throw new Error('관찰 시점이 잘못되었습니다');
  if(Date.parse(t.period.as_of)<end)throw new Error('관찰 시점은 평가 종료 시점 이후여야 합니다. 진행 중인 기간은 종료를 관찰 시점으로 지정하세요');
  const allowedRefs=['default_branch','all_visible_branch_heads','pull_request_heads'];if(!Array.isArray(t.sources.github.ref_scope)||!t.sources.github.ref_scope.length||t.sources.github.ref_scope.some(x=>!allowedRefs.includes(x)))throw new Error('지원하는 Git ref 수집 범위를 지정하세요');
  if(new Set(t.members.map(x=>x.person_id)).size!==t.members.length||new Set(t.repositories.map(x=>x.repository_id)).size!==t.repositories.length) throw new Error('팀원·레포 ID가 중복됩니다');
  if(t.sources.github.connection_ref!=='github'||t.sources.confluence.connection_ref!=='confluence')throw new Error('connection_ref는 github·confluence 연결 키를 참조해야 합니다');
  if(t.repositories.some(repo=>repo.source_id!==t.sources.github.source_id||repo.repository_id===t.sources.confluence.source_id))throw new Error('레포의 source_id 참조 또는 Confluence와 겹친 레포 ID를 확인하세요');
  const ids=new Set(t.repositories.map(x=>x.repository_id));
  const accountOwners=new Map<string,string>();for(const person of t.members){const identities=[...(person.identities?.commit_emails||[]).map(email=>['email',email]),['github',person.identities?.github_login],['confluence',person.identities?.confluence_account_ref]];for(const [namespace,account] of identities){if(!account)continue;const key=namespace+':'+account.toLowerCase();if(accountOwners.has(key)&&accountOwners.get(key)!==person.person_id)throw new Error('동일 계정이 여러 팀원에 연결되었습니다');accountOwners.set(key,person.person_id);}}
  for(const person of t.members){ if(!person.person_id||!person.display_name||!Array.isArray(person.identities?.commit_emails))throw new Error('팀원 계정 매핑이 필요합니다'); for(const r of person.repository_assignments)if(!ids.has(r.repository_id))throw new Error('담당 레포 참조가 없습니다'); }
  const repoUrls=new Set<string>();for(const repo of t.repositories){ if(!/^https?:\/\//.test(repo.url))throw new Error('레포 URL은 HTTP(S)여야 합니다');const u=new URL(repo.url);if(u.username||u.password||u.search)throw new Error('레포 URL에 인증·query를 넣을 수 없습니다');const canonical=(u.origin+u.pathname.replace(/\/$/,'').replace(/\.git$/,'')).toLowerCase();if(repoUrls.has(canonical))throw new Error('같은 레포 URL은 한 번 등록하고 여러 팀원에게 연결하세요');repoUrls.add(canonical); }
  if(!Array.isArray(t.sources.confluence.roots)) throw new Error('Confluence 루트 목록이 필요합니다');for(const item of t.sources.confluence.roots)if(item.repository_ids?.some(id=>!ids.has(id)))throw new Error('Confluence 루트의 repository_ids는 등록된 레포를 참조해야 합니다');
  if(t.evaluation_policy.artifact_mode&&!['feature_first','full'].includes(t.evaluation_policy.artifact_mode))throw new Error('artifact_mode는 feature_first 또는 full이어야 합니다');
  const weights=Object.values(t.evaluation_policy.weights);
  const expectedDimensions=['problem_solving','implementation_scope_and_consistency','verification','collaboration','reusable_knowledge'];if(Object.keys(t.evaluation_policy.weights).length!==expectedDimensions.length||expectedDimensions.some(key=>!(key in t.evaluation_policy.weights)))throw new Error('지원하는 평가 항목 5개의 가중치를 지정하세요');
  if(weights.some(x=>typeof x!=='number'||x<0)||Math.abs(weights.reduce((a,b)=>a+b,0)-1)>1e-8) throw new Error('평가 가중치 합은 1이어야 합니다');
  return t;
}
export function redact(message:unknown):string {
  let text=message instanceof Error?message.message:String(message);
  text=text.replace(/sk-[A-Za-z0-9_-]{10,}/g,'[REDACTED]').replace(/(Bearer|Basic)\s+\S+/gi,'$1 [REDACTED]');
  text=text.replace(/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g,'$1[REDACTED]@');
  try{const c=readConnections();for(const secret of [c.systems.github.auth.token,c.systems.confluence.auth.token,c.systems.opencode.llm.token,c.systems.opencode.server_auth.password,c.systems.opencode.server_auth.token,c.application.admin_password,c.application.session_secret])if(secret)text=text.split(secret).join('[REDACTED]');}catch{}
  return text.slice(0,3000);
}
