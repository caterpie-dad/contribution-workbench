import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {readConnections} from '../src/config.js';
import {db,migrate} from '../src/db.js';
import {saveConfiguration,createCollection} from '../src/jobs.js';
import {RestWiki,collectWiki,WikiAdapter,resolveWikiLink} from '../src/collectors/confluence.js';
after(()=>db.end());
test('Confluence 앱 상대 링크는 설정한 context path를 유지하고 외부 호스트를 거부한다',()=>{
  const base='https://wiki.company.example/confluence';
  assert.equal(resolveWikiLink('/rest/api/content/1/child/page?start=100',base),base+'/rest/api/content/1/child/page?start=100');
  assert.equal(resolveWikiLink('/confluence/rest/api/content/1?start=100',base),base+'/rest/api/content/1?start=100');
  assert.equal(resolveWikiLink('?cursor=abc',base,base+'/rest/api/content/1/version?limit=100'),base+'/rest/api/content/1/version?cursor=abc');
  assert.equal(resolveWikiLink('/pages/viewpage.action?pageId=1',base),base+'/pages/viewpage.action?pageId=1');
  assert.equal(resolveWikiLink('/download/attachments/1/file.txt',base),base+'/download/attachments/1/file.txt');
  assert.throws(()=>resolveWikiLink('https://other.example/path',base),/호스트/);
});
test('겹친 루트에서 한 설정이 제외한 루트 본문도 다른 설정이 포함하면 수집한다',async()=>{
  await migrate();const c=structuredClone(readConnections());const t=JSON.parse(fs.readFileSync('design/team-config.example.json','utf8'));
  t.period={start_inclusive:'2025-01-01T00:00:00Z',end_exclusive:'2025-04-01T00:00:00Z',as_of:'2025-04-01T00:00:00Z'};
  t.sources.confluence.roots=[false,true].map((include_root,index)=>({root_id:'overlap-'+index,page_id:'1',page_url:'https://wiki.company.example/pages/1',include_root}));
  const reads:string[]=[];const adapter:WikiAdapter={
    async resolve(){return '1';},
    async page(id){reads.push(id);return {id,title:'Page '+id,body:'<p>Actual page '+id+' revision body</p>',version:1,date:'2025-02-01T00:00:00Z',actor:'analyst',url:'https://wiki.company.example/pages/'+id};},
    async list(operation,id){return {items:operation==='children'&&id==='1'?[{id:'2'}]:operation==='versions'?[{number:1,createdAt:'2025-02-01T00:00:00Z'}]:[],next:null};},async close(){}
  };
  const config=await saveConfiguration(t);const id=await createCollection(config.id,'root-union-contract');await db.query("UPDATE jobs SET status='cancelled' WHERE target_id=$1",[id]);
  await collectWiki(id,t,c,adapter);
  const pages=(await db.query("SELECT object_id FROM evidence WHERE collection_id=$1 AND kind='wiki_page'",[id])).rows.map(e=>e.object_id);
  assert.deepEqual(new Set(pages),new Set(['1','2']));assert.deepEqual(reads,['2','1']);
  assert.equal((await db.query("SELECT count(*) n FROM inventory WHERE collection_id=$1 AND kind='root_membership'",[id])).rows[0].n,'4');
});
test('Cloud 루트 아래 폴더도 계속 탐색해 손자 페이지를 누락하지 않는다',async()=>{await migrate();let folderReads=0;const fixture=http.createServer((req,res)=>{const url=new URL(req.url!,'http://localhost');res.setHeader('Content-Type','application/json');if(url.pathname==='/wiki/api/v2/pages/1/direct-children')return res.end(JSON.stringify({results:[{id:'10',type:'folder'},{id:'2',type:'page'}],_links:{}}));if(url.pathname==='/wiki/api/v2/folders/10/direct-children'){folderReads++;return res.end(JSON.stringify({results:[{id:'3',type:'page'}],_links:{}}));}if(url.pathname.endsWith('/direct-children')||url.pathname.endsWith('/footer-comments')||url.pathname.endsWith('/attachments'))return res.end(JSON.stringify({results:[],_links:{}}));if(url.pathname.endsWith('/versions'))return res.end(JSON.stringify({results:[{number:1,createdAt:'2024-12-01T00:00:00Z'},{number:2,createdAt:'2025-02-01T00:00:00Z'}],_links:{}}));const id=url.pathname.match(/\/pages\/(\d+)$/)?.[1];if(id){const version=Number(url.searchParams.get('version')||2);return res.end(JSON.stringify({id,title:'Cloud page '+id,body:{storage:{value:'<p>Version '+version+' page '+id+' analysis</p>'}},version:{number:version,createdAt:version===1?'2024-12-01T00:00:00Z':'2025-02-01T00:00:00Z',authorId:'cloud-analyst'}}));}res.statusCode=404;res.end('{}');});await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));try{const base=`http://127.0.0.1:${(fixture.address() as any).port}/wiki`;const c=structuredClone(readConnections());c.systems.confluence={url:base,deployment:'cloud',transport:'rest',auth:{scheme:'bearer',token:'fixture'}};const t=JSON.parse(fs.readFileSync('design/team-config.example.json','utf8'));t.period={start_inclusive:'2025-01-01T00:00:00Z',end_exclusive:'2025-04-01T00:00:00Z',as_of:'2025-04-01T00:00:00Z'};t.sources.confluence.roots=[{root_id:'root',page_id:'1',page_url:base+'/spaces/X/pages/1',include_root:true}];const config=await saveConfiguration(t);const id=await createCollection(config.id,'cloud-contract');await db.query("UPDATE jobs SET status='cancelled' WHERE target_id=$1",[id]);await collectWiki(id,t,c,new RestWiki(c.systems.confluence));const pages=(await db.query("SELECT object_id FROM evidence WHERE collection_id=$1 AND kind='wiki_page'",[id])).rows.map(x=>x.object_id);assert.deepEqual(new Set(pages),new Set(['1','2','3']));assert.equal(folderReads,1);assert.equal((await db.query("SELECT status FROM inventory WHERE collection_id=$1 AND object_key='container:10'",[id])).rows[0].status,'complete');}finally{await new Promise<void>(r=>fixture.close(()=>r()));}});
