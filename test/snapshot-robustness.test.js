'use strict';
// 13/10/2026 — follow-up to the CI failure of run 38434366364 (see test/snapshot-binaries.test.js). Three remaining risks of the shadow snapshot, each with the test that fails if it returns:
//  (e) LS.capture sat OUTSIDE the try in build.js: any error in it stopped the whole build, with the public output already computed. It is inside now: the build logs `snapshot failed: <reason>`, publishes and exits 0.
//  (b) inputs.json held every source twice, `sources` (parsed) and `sourceBytes` (the exact text): cache/tmdb.json alone is 12 MB. Now it holds sourceBytes only; `sources` is rebuilt by verifySnapshot.
//  (a) the cap of 1 GiB of binaries (the real set is ~431 MiB): capture logs the total and its percent of the cap, and going over it is an error that names the cap (kind binary-total-exceeded), not "Invalid string length".
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const B=require('../lib/learning/binary'),SN=require('../lib/learning/snapshot'),S=require('../lib/learning/schema'),inline=require('../test-support/legacy-binary-map');
const REPO=path.resolve(__dirname,'..');
function area(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'mood-robust-'));fs.writeFileSync(path.join(root,'config.json'),'{}');for(const n of B.rendererBinary){fs.mkdirSync(path.dirname(path.join(root,n)),{recursive:true});fs.copyFileSync(path.join(REPO,n),path.join(root,n));}return root;}
function snapshot(root,extra={}){return SN.capture({root,dir:path.join(root,'private'),date:'2026-10-10',capturedAt:'2026-10-10T12:00:00.000Z',...extra});}
function reseal(dir,mutate){const file=path.join(dir,'inputs.json'),input=JSON.parse(fs.readFileSync(file,'utf8')),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));mutate(input,manifest);fs.writeFileSync(file,S.canonical(input));manifest.inputFiles.find(f=>f.path==='inputs.json').sha256=S.hash(input);const {id,...rest}=manifest;manifest.id=S.hash(rest);fs.writeFileSync(path.join(dir,'manifest.json'),S.canonical(manifest));}
const withArea=fn=>()=>{const root=area();try{fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}};
const underDir=dir=>SN.filesUnder(dir);
const count=(text,needle)=>text.split(needle).length-1;

// ---- (e) the build survives a capture that throws -------------------------------------------------------------------------------------------------------------------------------
function buildArea(){const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mood-robust-build-'));for(const rel of ['tools','lib','web','scripts','cache','data','build.js','verify.js','config.json','learning.config.json'])fs.cpSync(path.join(REPO,rel),path.join(temp,rel),{recursive:true});return temp;}
function runBuild(temp,mode){const env={...process.env,MOOD_DATE:'2026-10-10'};delete env.NODE_TEST_CONTEXT;return spawnSync(process.execPath,['build.js','--offline','--cache-only','--skip-posters','--out',path.join(temp,'out-'+mode),'--learning',mode,'--private-dir',path.join(temp,'private'),'--captured-at','2026-10-10T12:00:00.000Z'],{cwd:temp,env,encoding:'utf8',maxBuffer:20*1024*1024});}
const catalogs=out=>Object.fromEntries(underDir(path.join(out,'catalog')).map(p=>[path.relative(out,p),JSON.parse(fs.readFileSync(p))]));

test('(e) shadow build whose snapshot cannot be written: logs `snapshot failed`, exits 0 and publishes the same catalogs as off',()=>{
 const temp=buildArea();try{
  // The destination of the snapshots is a plain file, so capture fails when it creates snapshots/<id>.tmp (ENOTDIR). Nothing before capture touches that path.
  fs.mkdirSync(path.join(temp,'private'),{recursive:true});fs.writeFileSync(path.join(temp,'private/snapshots'),'not a directory');
  const off=runBuild(temp,'off');a.equal(off.status,0,off.stderr);
  const shadow=runBuild(temp,'shadow');
  a.equal(shadow.status,0,'the failed snapshot must not stop the build: '+shadow.stderr.slice(-600));
  a.match(shadow.stdout,/snapshot failed: /);
  a.doesNotMatch(shadow.stdout,/Shadow: \d+ candidates/,'no evaluation of a snapshot that does not exist');
  // the usage line of capture reaches the build's log (the build hands its `log` to capture), and the failure leaves its own report
  a.match(shadow.stdout,/^ +Snapshot binaries: \d+ names, \d+ files, \d+ bytes \(/m);
  a.doesNotMatch(shadow.stdout,/snapshot report not written/);
  const report=JSON.parse(fs.readFileSync(path.join(temp,'private/reports/unavailable.json'),'utf8'));
  a.deepEqual({status:report.status,productionPolicy:report.productionPolicy},{status:'not_evaluated',productionPolicy:'baseline-v2'});
  a.match(report.reason,/^snapshot failed: /);
  const published=catalogs(path.join(temp,'out-shadow'));
  a(Object.keys(published).length>0,'public catalogs were produced');
  a.deepEqual(published,catalogs(path.join(temp,'out-off')),'public output is the same as with learning off');
  a(fs.existsSync(path.join(temp,'out-shadow/manifest.json')),'the addon manifest was published');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('(e) the report of the failure cannot be written either: the build still exits 0 and logs `snapshot report not written`',()=>{
 const temp=buildArea();try{
  fs.mkdirSync(path.join(temp,'private'),{recursive:true});fs.writeFileSync(path.join(temp,'private/snapshots'),'not a directory');fs.writeFileSync(path.join(temp,'private/reports'),'not a directory');
  const shadow=runBuild(temp,'shadow');
  a.equal(shadow.status,0,shadow.stderr.slice(-600));
  a.match(shadow.stdout,/snapshot failed: /);a.match(shadow.stdout,/snapshot report not written: Error/);
  a(Object.keys(catalogs(path.join(temp,'out-shadow'))).length>0,'public catalogs were produced');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

// ---- (b) each source is on disk once --------------------------------------------------------------------------------------------------------------------------------------
test('(b) a cache source appears once in the snapshot on disk; verify rebuilds `sources` from the exact text',withArea(root=>{
 const marker='UNIQ-'+'7f3a91c2e8b4d605';
 fs.mkdirSync(path.join(root,'cache'));
 const doc={marker,pad:Array.from({length:3000},(_,i)=>({i,t:'film number '+i}))},text=JSON.stringify(doc);
 fs.writeFileSync(path.join(root,'cache/lists.json'),text);
 const dir=snapshot(root),files=underDir(dir);
 const all=files.map(f=>fs.readFileSync(f,'latin1')).join('\n');
 a.equal(count(all,marker),1,'the bytes of the cache are stored once in the snapshot, not as parsed copy plus text');
 const raw=fs.readFileSync(path.join(dir,'inputs.json'),'utf8'),input=JSON.parse(raw);
 a(!Object.hasOwn(input,'sources'),'inputs.json has no parsed copy');
 a.equal(input.sourceBytes['cache/lists.json'],text);
 const sources=Buffer.byteLength(text)+2;
 a(Buffer.byteLength(raw)<sources*1.6+20000,'inputs.json is about the size of the sources it holds once: '+Buffer.byteLength(raw)+' bytes for '+Buffer.byteLength(text)+' of cache');
 const checked=SN.verifySnapshot(dir);
 a.deepEqual(checked.bodies['inputs.json'].sources['cache/lists.json'],doc);
 a.equal(checked.bodies['inputs.json'].sources['config.json'] && Object.keys(checked.bodies['inputs.json'].sources['config.json']).length,0);
 a.equal(snapshot(root),dir,'same inputs, same immutable snapshot');
}));

test('(b) a snapshot written earlier today, with both `sources` and `sourceBytes`, still verifies; a mismatch between the two is refused',withArea(root=>{
 fs.mkdirSync(path.join(root,'cache'));fs.writeFileSync(path.join(root,'cache/lists.json'),'{"a":1}');
 const dir=snapshot(root);
 reseal(dir,i=>{i.sources=Object.fromEntries(Object.entries(i.sourceBytes).map(([k,v])=>[k,k.endsWith('.json')?JSON.parse(v):v]));});
 a.deepEqual(SN.verifySnapshot(dir).bodies['inputs.json'].sources['cache/lists.json'],{a:1});
 reseal(dir,i=>{i.sources['cache/lists.json']={a:2};});
 a.throws(()=>SN.verifySnapshot(dir),/Frozen source hash mismatch/);
}));

test('(b) with only sourceBytes, a text that is not the manifest\'s hash, a path outside the allowed list or a non-text body is refused even with the index hash recomputed',withArea(root=>{
 fs.mkdirSync(path.join(root,'cache'));fs.writeFileSync(path.join(root,'cache/lists.json'),'{"a":1}');
 const dir=snapshot(root),inputs=fs.readFileSync(path.join(dir,'inputs.json'),'utf8'),manifest=fs.readFileSync(path.join(dir,'manifest.json'),'utf8');
 const restore=()=>{fs.writeFileSync(path.join(dir,'inputs.json'),inputs);fs.writeFileSync(path.join(dir,'manifest.json'),manifest);};
 for(const [change,message] of [
  [i=>{i.sourceBytes['cache/lists.json']='{"a":2}';},/Frozen source hash mismatch/],
  [(i,m)=>{i.sourceBytes['data/letterboxd/../outside.json']='{}';m.sourceFileHashes['data/letterboxd/../outside.json']=S.hash('{}');},/Invalid frozen source path/],
  [i=>{i.sourceBytes['cache/lists.json']=5;},/Frozen source hash mismatch/],
  [i=>{i.sourceBytes=['x'];},/Invalid source bytes/],
  [i=>{delete i.sourceBytes['config.json'];},/Source references mismatch|Missing frozen config/],
 ]){restore();reseal(dir,change);a.throws(()=>SN.verifySnapshot(dir),message,String(change));}
}));

// ---- (a) the cap: the log says how close, and going over it is a clear error -------------------------------------------------------------------------------------------------------
test('(a) capture logs the binaries\' total bytes and the percent of the cap',withArea(root=>{
 const lines=[];snapshot(root,{log:m=>lines.push(m)});
 const bytes=B.rendererBinary.reduce((n,x)=>n+fs.statSync(path.join(root,x)).size,0);
 a.equal(lines.length,1);
 a.match(lines[0],new RegExp('^Snapshot binaries: '+B.rendererBinary.length+' names, '+B.rendererBinary.length+' files, '+bytes+' bytes \\('));
 a.match(lines[0],/= \d+(\.\d)?% of the 1024\.0 MiB cap$/);
 const entry=n=>({length:n,sha256:'a'.repeat(64),file:'binaries/'+'a'.repeat(64)});
 const ten={};for(let i=1;i<=10;i++)ten['cache/posters-out/tt'+i+'.jpg']=entry(20*1024*1024);
 a.deepEqual(B.usage(ten),{names:10,files:1,bytes:10*20*1024*1024,limit:B.MAX_TOTAL,percent:19.5});
 a.match(B.describe(ten),/10 names, 1 files, 209715200 bytes \(200\.0 MiB\) = 19\.5% of the 1024\.0 MiB cap/);
}));

test('(a) binaries past MAX_TOTAL: capture stops with an error that names the cap (kind binary-total-exceeded), before reading any picture, and never "Invalid string length"',withArea(root=>{
 // 52 sparse files of exactly 20 MiB (the per-file limit) = 1,040 MiB > 1 GiB. Only sizes are read before the total is compared.
 const out=path.join(root,'cache/posters-out');fs.mkdirSync(out,{recursive:true});
 const ids=Array.from({length:52},(_,i)=>'tt'+(i+1));
 for(const tt of ids){const f=path.join(out,tt+'.jpg');fs.writeFileSync(f,Buffer.from([255,216,255]));fs.truncateSync(f,20*1024*1024);}
 const plan={board:[{id:'r',items:ids.map(id=>({id,poster:'https://x.example/posters/'+id+'.jpg'}))}],discover:[]};
 const lines=[];let error=null;
 try{snapshot(root,{baseline:{plan,index:null},log:m=>lines.push(m)});}catch(e){error=e;}
 a(error,'capture must refuse');
 a.equal(error.kind,'binary-total-exceeded');a.equal(error.limit,B.MAX_TOTAL);a.equal(error.total,B.rendererBinary.reduce((n,x)=>n+fs.statSync(path.join(root,x)).size,0)+52*20*1024*1024);
 a.match(error.message,/^Binary sources total \d+ exceeds limit 1073741824 \(\d+ names, 10\d\.\d% of the cap\): raise MAX_TOTAL/);
 a.doesNotMatch(error.message,/Invalid string length/);
 a.deepEqual(lines,[],'nothing was logged as captured');
 a(!fs.existsSync(path.join(root,'private/snapshots'))||fs.readdirSync(path.join(root,'private/snapshots')).length===0,'no half-written snapshot is left');
 // and one 20 MiB file is still the largest binary allowed
 fs.truncateSync(path.join(out,'tt1.jpg'),20*1024*1024+1);
 a.throws(()=>B.capture(root,plan),/Invalid binary length/);
}));

// ---- the shape that really existed until today: schema 1, every binary inline, and `sources` beside `sourceBytes` ----------------------------------------------------------------
test('(b) a schema-1 snapshot as it was really written (base64 inline, sources AND sourceBytes) still verifies; a source that differs from its text is refused',withArea(root=>{
 fs.mkdirSync(path.join(root,'cache'));fs.writeFileSync(path.join(root,'cache/lists.json'),'{"a":1}');
 const dir=snapshot(root),index=JSON.parse(fs.readFileSync(path.join(dir,'inputs.json'),'utf8')).binarySources;
 reseal(dir,i=>{i.schemaVersion=1;i.binarySources=inline(root,index);i.sources=Object.fromEntries(Object.entries(i.sourceBytes).map(([k,v])=>[k,k.endsWith('.json')?JSON.parse(v):v]));});
 fs.rmSync(path.join(dir,'binaries'),{recursive:true});
 const old=SN.verifySnapshot(dir),input=old.bodies['inputs.json'];
 a.equal(input.schemaVersion,1);a.deepEqual(input.sources['cache/lists.json'],{a:1});a.equal(input.sourceBytes['cache/lists.json'],'{"a":1}');
 a.deepEqual(B.reader(input,old.dir).names.sort(),[...B.rendererBinary].sort());
 reseal(dir,i=>{i.sources['cache/lists.json']={a:2};});
 a.throws(()=>SN.verifySnapshot(dir),/Frozen source hash mismatch/);
}));
