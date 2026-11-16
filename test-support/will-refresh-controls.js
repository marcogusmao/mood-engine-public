'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),base=path.join(root,'.context/will-refresh-controls');
const source=fs.readFileSync(path.join(root,'lib/person-refresh.js'),'utf8');
const cases=[
 ['before-followed',()=>fs.readFileSync(path.join(base,'before-followed.js'),'utf8')],
 ['account-partial-removal',s=>s.replace('merged=complete?new Map():new Map(old)','merged=new Map()')],
 ['account-partial-rating',s=>s.replace('rating=!complete&&prior?prior[3]:r.rating','rating=r.rating')],
 ['account-subject',s=>s.replace('result.subjectUser!==user','false')],
 ['run-stop',s=>s.replace("if(r.status===403||r.status===429||CHALLENGE.test(r.text||''))",'if(false)')],
 ['metadata-redirect',s=>s.replace('r.status!==200||r.url!==url','r.status!==200')],
 ['acquisition-omitted',s=>s.replace("if(cache.following?.user","return cache; if(cache.following?.user")],
 ['baseline',()=>fs.readFileSync(path.join(base,'baseline.js'),'utf8')],
 ['null-rating',s=>s.replace("if (k==='ratings' && r.rating===null)","if (false)")],
 ['uri-overlay',s=>s.replace('const resolve=identityResolver({identities,films,links});','const resolve=uri=>uri;')],
 ['duplicate-page',s=>s.replace('if(batch.some(r=>seen.has(r.uri||r.user)))','if(false)').replace('repeatedPage:repeatedPage||!unique','repeatedPage:repeatedPage').replace('&& unique &&','&& true &&')],
 ['redirect-owner',s=>s.replace("(response.url && response.url!==next)",'false')],
 ['following-missing',s=>s.replace("following:()=>collect('following')","following:()=>Promise.resolve(envelope({dataset:'following'}))")],
 ['early-completion-time',s=>s.replace('completedAt:new Date(clock()).toISOString()','completedAt:startedAt')],
];
let failed=0;
for(const [name,mutate] of cases) {
 const dir=fs.mkdtempSync(path.join(base,name+'-'));
 try {
  for(const file of ['lib','scripts/update-person.js','people.json','test/person-refresh.test.js','test/will-refresh-followed.test.js','test/fixtures','test-support/people/fixture.js','test-support/will-refresh-fixtures.js']) {const target=path.join(dir,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(path.join(root,file),target,{recursive:true});}
  const changed=mutate(source);if(changed===source) throw Error('Mutation did not apply: '+name);
  fs.writeFileSync(path.join(dir,'lib/person-refresh.js'),changed);
  const run=spawnSync(process.execPath,['--test','test/person-refresh.test.js','test/will-refresh-followed.test.js'],{cwd:dir,encoding:'utf8'});
  const output=run.stdout+run.stderr;fs.writeFileSync(path.join(base,name+'.log'),output);
  const failures=Number(output.match(/# fail (\d+)/)?.[1]||0);
  console.log(`${name}: exit=${run.status}, failed tests=${failures}`);
  if(run.status===0||!failures)failed++;
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
if(failed)process.exitCode=1;
