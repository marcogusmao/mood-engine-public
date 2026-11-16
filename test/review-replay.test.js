'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=process.env.REVIEW_ROOT||path.resolve(__dirname,'..'),SN=require(path.join(root,'lib/learning/snapshot')),S=require(path.join(root,'lib/learning/schema')),B=require(path.join(root,'lib/learning/binary')),R=require(path.join(root,'test-support/integration-reference')),P=require(path.join(root,'lib/posters')),replay=require(path.join(root,'lib/learning/replay')).replaySelection;
const catalogs=out=>Object.fromEntries(SN.filesUnder(path.join(out,'catalog')).map(p=>[path.relative(out,p),JSON.parse(fs.readFileSync(p))]));
function runBuild(temp,mode,extra=[]){const env={...process.env,MOOD_DATE:'2026-10-10'};delete env.NODE_TEST_CONTEXT;const r=spawnSync(process.execPath,['build.js','--offline','--cache-only','--out',path.join(temp,'.context',mode),'--learning',mode,'--private-dir',path.join(temp,'.context/private'),'--captured-at','2026-10-10T12:00:00.000Z',...extra],{cwd:temp,env,encoding:'utf8',maxBuffer:20*1024*1024});a.equal(r.status,0,r.stderr);a.match(r.stdout,/0 TMDB calls/);return r.stdout;}
function area(){const temp=fs.mkdtempSync(path.join(root,'.context/review-replay-'));for(const rel of ['tools','lib','web','scripts','cache','data','build.js','verify.js','config.json','learning.config.json'])fs.cpSync(path.join(root,rel),path.join(temp,rel),{recursive:true});fs.mkdirSync(path.join(temp,'.context'));return temp;}
function snapshot(temp){const priv=path.join(temp,'.context/private/snapshots');return SN.verifySnapshot(path.join(priv,fs.readdirSync(priv)[0]));}
for(const stale of [false,true])test('real Pillow redraw, '+(stale?'obsolete':'absent')+' source state, off/shadow, two exact independent replays',async()=>{
 const temp=area();try{
 const capture=await R.capture(temp),target=[...P.collectTargets(capture.plan).values()].find(t=>P.hasNumbers(P.shown(t.ratings)));
 const planned=new Set(P.collectTargets(capture.plan).keys()),indexOnly=capture.index.films.filter(e=>!planned.has(e.tt)&&e.year).sort((a,b)=>a.tt.localeCompare(b.tt))[0];
 fs.rmSync(path.join(temp,'cache/posters-out'),{recursive:true,force:true});fs.rmSync(path.join(temp,'cache/posters-raw'),{recursive:true,force:true});fs.mkdirSync(path.join(temp,'cache/posters-out'));fs.mkdirSync(path.join(temp,'cache/posters-raw'));
 for(const tt of [target.tt,indexOnly.tt])fs.copyFileSync(path.join(root,'test/fixtures/learning/cover.jpg'),path.join(temp,'cache/posters-raw',tt+'.jpg'));
 const stateFile=path.join(temp,'cache/posters.json');if(stale){fs.writeFileSync(stateFile,JSON.stringify({version:1,items:{[target.tt]:{h:'0000000000000000'},[indexOnly.tt]:{h:'0000000000000000'}}}));fs.copyFileSync(path.join(root,'test/fixtures/learning/cover.jpg'),path.join(temp,'cache/posters-out',target.tt+'.jpg'));}else fs.rmSync(stateFile,{force:true});
 const prior=fs.existsSync(stateFile)?fs.readFileSync(stateFile,'utf8'):null;
 for(const mode of ['off','shadow']){a.match(runBuild(temp,mode),/2 drawn/);a.equal(fs.existsSync(stateFile)?fs.readFileSync(stateFile,'utf8'):null,prior);}
 const bytes=fs.readFileSync(path.join(temp,'cache/posters-out',target.tt+'.jpg'));a.notEqual(B.digest(bytes),B.digest(fs.readFileSync(path.join(root,'test/fixtures/learning/cover.jpg'))));a.deepEqual(catalogs(path.join(temp,'.context/off')),catalogs(path.join(temp,'.context/shadow')));
 const snap=snapshot(temp),input=snap.bodies['inputs.json'];a.equal(input.schemaVersion,2);a(Object.values(input.binarySources).every(e=>!('data' in e)&&fs.existsSync(path.join(snap.dir,e.file))),'13/10/2026: the covers are files of the snapshot, not base64 inside inputs.json');a.equal(input.sources['cache/posters.json']?.items[target.tt]?.h,stale?'0000000000000000':undefined);
 const one=replay(snap,temp),two=replay(snap,temp);a.deepEqual(one,two);a.equal(one.hash,S.hash(catalogs(path.join(temp,'.context/shadow'))));a.equal(one.covers['posters/'+target.tt+'.jpg'],B.digest(bytes));a.equal(Object.keys(one.covers).length,2);a(one.covers['posters/'+indexOnly.tt+'.jpg']);a(one.indexHash);
 a.equal(B.digest(fs.readFileSync(path.join(temp,'.context/off/posters',target.tt+'.jpg'))),B.digest(bytes));
 for(const change of [i=>{i.effectivePosterState.items.tt999999999={h:'0000000000000000'};},i=>{delete i.binarySources['cache/posters-out/'+indexOnly.tt+'.jpg'];},i=>{i.effectiveOptions.executable='/tmp/untrusted';},i=>{i.effectivePosterState=null;},i=>{i.binarySources['cache/posters-out/tt999999999.jpg']=i.binarySources['cache/posters-out/'+target.tt+'.jpg'];}]){
 const bad=structuredClone(snap),dir=path.join(temp,'.context/tampered');fs.mkdirSync(dir,{recursive:true});fs.cpSync(path.join(snap.dir,'binaries'),path.join(dir,'binaries'),{recursive:true});change(bad.bodies['inputs.json']);for(const f of bad.manifest.inputFiles){f.sha256=S.hash(bad.bodies[f.path]);fs.writeFileSync(path.join(dir,f.path),S.canonical(bad.bodies[f.path]));}const {id,...rest}=bad.manifest;bad.manifest.id=S.hash(rest);fs.writeFileSync(path.join(dir,'manifest.json'),S.canonical(bad.manifest));a.throws(()=>SN.verifySnapshot(dir),/poster|field/);
 }
 if(!stale){
  const legacy=structuredClone(snap),dir=path.join(temp,'.context/legacy-contract');fs.mkdirSync(dir,{recursive:true});fs.cpSync(path.join(snap.dir,'binaries'),path.join(dir,'binaries'),{recursive:true});fs.rmSync(path.join(dir,legacy.bodies['inputs.json'].binarySources['cache/posters-out/'+indexOnly.tt+'.jpg'].file));
  delete legacy.bodies['baseline.json'].data.index;
  delete legacy.bodies['inputs.json'].binarySources['cache/posters-out/'+indexOnly.tt+'.jpg'];
  delete legacy.bodies['inputs.json'].effectivePosterState.items[indexOnly.tt];
  for(const f of legacy.manifest.inputFiles){f.sha256=S.hash(legacy.bodies[f.path]);fs.writeFileSync(path.join(dir,f.path),S.canonical(legacy.bodies[f.path]));}
  const {id,...rest}=legacy.manifest;legacy.manifest.id=S.hash(rest);fs.writeFileSync(path.join(dir,'manifest.json'),S.canonical(legacy.manifest));
  const checked=SN.verifySnapshot(dir),oldReplay=replay(checked,temp);a.deepEqual(Object.keys(oldReplay.covers),['posters/'+target.tt+'.jpg']);a.equal(oldReplay.indexHash,null);a.equal(oldReplay.zeroNetwork,true);
 }

 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('CLI separator and skip flags frozen as data; replay matches actually published catalogs and original config bytes',()=>{
 const temp=area();try{const before=fs.readFileSync(path.join(temp,'config.json'),'utf8');runBuild(temp,'shadow',['--description-separator',' — ','--skip-posters']);const snap=snapshot(temp);a.equal(snap.bodies['inputs.json'].sourceBytes['config.json'],before);a(Object.values(catalogs(path.join(temp,'.context/shadow'))).some(c=>c.metas.some(m=>m.description?.includes(' — '))));const one=replay(snap,temp),two=replay(snap,temp);a.deepEqual(one,two);a.equal(one.hash,S.hash(catalogs(path.join(temp,'.context/shadow'))));a.deepEqual(one.covers,{});a.deepEqual(snap.bodies['inputs.json'].effectiveOptions,{descriptionSeparator:' — ',skipFriends:false,skipPosters:true});}finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('v2.3 language table is frozen, hashed, and local changes refused',()=>{const temp=area();try{const names=SN.sourceFiles(temp);a(names.includes('tools/selo/language-countries.json'));const input={sourceBytes:Object.fromEntries(B.rendererText.map(n=>[n,fs.readFileSync(path.join(temp,n),'utf8')])),binarySources:B.capture(temp)};B.rendererIdentity(temp,input);fs.appendFileSync(path.join(temp,'tools/selo/language-countries.json'),' ');a.throws(()=>B.rendererIdentity(temp,input),/identity mismatch.*language-countries/);}finally{fs.rmSync(temp,{recursive:true,force:true});}});

test('skip-friends selection is reproduced from restricted effective flag',()=>{const temp=area();try{runBuild(temp,'shadow',['--skip-friends','--skip-posters']);const snap=snapshot(temp);a.equal(snap.bodies['inputs.json'].effectiveOptions.skipFriends,true);a.equal(replay(snap,temp).hash,S.hash(catalogs(path.join(temp,'.context/shadow'))));}finally{fs.rmSync(temp,{recursive:true,force:true});}});
