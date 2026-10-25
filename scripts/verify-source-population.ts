import path from 'node:path';
import fs from 'node:fs/promises';
import {db} from '../src/db.js';
import {git} from '../src/collectors/github.js';
import {hash,root} from '../src/config.js';

// Re-enumerate immutable Git objects independently of the collection engine.
// This audit covers the public Git demo, not deleted or inaccessible material.
export async function verifySourcePopulation(run:any,t:any,evidence:any[],check:(name:string,passed:boolean,details?:any)=>void) {
  let commits=0,documents=0;const mismatches:any[]=[];
  for(const e of evidence) {
    const repository=t.repositories.find((r:any)=>r.repository_id===e.source_id);
    if(e.kind==='commit') {
      const body=await git(path.resolve(root,repository?.mirror_path||e.metadata.mirror_path),['cat-file','commit',e.revision]);
      const author=body.match(/^author .*<([^>]+)> (\d+) [+-]\d+$/m);
      const committer=body.match(/^committer .*<([^>]+)> (\d+) [+-]\d+$/m);
      if(author?.[1].toLowerCase()===e.metadata.author_email.toLowerCase()&&Number(committer?.[2])*1000===new Date(e.occurred_at).getTime()&&e.body.includes(e.revision)) commits++;
      else mismatches.push({id:e.id,reason:'identity_time_sha'});
    }
    if(e.metadata.surrogate) {
      const body=await git(path.resolve(root,repository.mirror_path),['cat-file','blob',e.metadata.blob_sha]);
      if(body===e.body)documents++;else mismatches.push({id:e.id,reason:'docs_blob'});
    }
  }
  check('git_identity_time_and_sha',commits===evidence.filter(e=>e.kind==='commit').length,{verified:commits,mismatches});
  check('git_document_original_blobs',documents===evidence.filter(e=>e.metadata.surrogate).length,{verified:documents});
  for(const repo of t.repositories) {
    const inv=(await db.query("SELECT details FROM inventory WHERE collection_id=$1 AND source_id=$2 AND object_key='git-ref-inventory' AND kind='population'",[run.collection_id,repo.repository_id])).rows[0]?.details;
    if(!inv){check('git_population_'+repo.repository_id,false,{reason:'missing_ref_inventory'});continue;}
    const refs=[...new Set([inv.head,...inv.refs.split('\n').filter(Boolean).map((line:string)=>line.split(' ')[1])])] as string[];
    const dir=path.resolve(root,repo.mirror_path);
    const expected=(await git(dir,['log',...refs,'--format=%H%x00%cI'])).trim().split('\n').filter(Boolean).filter(line=>{const time=Date.parse(line.split('\0')[1]);return time>=Date.parse(t.period.start_inclusive)&&time<Date.parse(t.period.end_exclusive);}).map(line=>line.split('\0')[0]);
    const collected=evidence.filter(e=>e.source_id===repo.repository_id&&e.kind==='commit').map(e=>e.object_id);
    check('git_population_'+repo.repository_id,new Set(expected).size===collected.length&&collected.every(id=>expected.includes(id)),{expected:new Set(expected).size,collected:collected.length});
    const contexts=evidence.filter(e=>e.source_id===repo.repository_id&&e.kind==='context');
    check('period_context_'+repo.repository_id,contexts.length>0&&contexts.every(e=>e.metadata.as_of_period_end===true),{anchor:inv.context_anchor});
    const snapshot=(await db.query('SELECT output FROM management_snapshots WHERE evaluation_id=$1 AND repository_id=$2',[run.id,repo.repository_id])).rows[0]?.output;
    const entries=(await git(dir,['ls-tree','-rlz',inv.context_anchor])).split('\0').filter(Boolean).flatMap(line=>{const m=line.match(/^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/);return m?[{mode:m[1],sha:m[2],bytes:Number(m[3]),path:m[4]}]:[];});
    check('repository_tree_manifest_'+repo.repository_id,!!snapshot&&snapshot.anchor===inv.context_anchor&&hash(entries)===snapshot.manifest_hash&&entries.length===snapshot.file_population,{files:entries.length,indexed:snapshot?.indexed_source_files});
  }
  for(const filename of ['actual-correction.json','actual-correction-identity.json']) {
    const proof=JSON.parse(await fs.readFile('runtime/verification/'+filename,'utf8'));
    const previous=(await db.query('SELECT person_id,output FROM portfolios WHERE evaluation_id=$1',[proof.before_evaluation_id])).rows;
    check('previous_report_immutable_'+filename,proof.original_portfolio_hashes.every((entry:any)=>{const p=previous.find(p=>p.person_id===entry.person_id);return p&&hash(p.output)===entry.hash;})&&evidence.find(e=>e.id===proof.evidence_id)?.raw_hash===proof.raw_hash,{previous_people:previous.length});
  }
}
