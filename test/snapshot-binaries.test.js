'use strict';
// 13/10/2026 — run 38434366364 (nightly CI): the build in shadow mode died with "Invalid string length" once the covers' cache held 11,103 JPEGs. inputs.json carried every
// published cover as base64 (575 MB, past V8's 536,870,888-character string limit) and capture, hash and verify handled it as ONE string. Schema 2: inputs.json keeps an index
// {name:{length,sha256,file}} and each binary is its own file, binaries/<sha256>, written, hashed and verified one at a time. The end-to-end replay from those files is in
// test/review-replay.test.js (real covers); the build at the real size is in test/learning-integration.test.js and test/learning-smoke.test.js.
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const B=require('../lib/learning/binary'),SN=require('../lib/learning/snapshot'),S=require('../lib/learning/schema'),inline=require('../test-support/legacy-binary-map');
const REPO=path.resolve(__dirname,'..'),COVER=path.join(REPO,'test/fixtures/learning/cover.jpg');
function area(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'mood-bin-'));fs.writeFileSync(path.join(root,'config.json'),'{}');for(const n of B.rendererBinary){fs.mkdirSync(path.dirname(path.join(root,n)),{recursive:true});fs.copyFileSync(path.join(REPO,n),path.join(root,n));}return root;}
function snapshot(root){return SN.capture({root,dir:path.join(root,'private'),date:'2026-10-10',capturedAt:'2026-10-10T12:00:00.000Z'});}
function reseal(dir,mutate){const file=path.join(dir,'inputs.json'),input=JSON.parse(fs.readFileSync(file,'utf8')),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));mutate(input);fs.writeFileSync(file,S.canonical(input));manifest.inputFiles.find(f=>f.path==='inputs.json').sha256=S.hash(input);const {id,...rest}=manifest;manifest.id=S.hash(rest);fs.writeFileSync(path.join(dir,'manifest.json'),S.canonical(manifest));}
const withArea=fn=>()=>{const root=area();try{fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}};

test('capture with 3 binaries: inputs.json holds an index and no base64; each binary is a file named by its hash; verify accepts',withArea(root=>{
 const dir=snapshot(root),raw=fs.readFileSync(path.join(dir,'inputs.json'),'utf8'),input=JSON.parse(raw);
 for(const name of B.rendererBinary)a(!raw.includes(fs.readFileSync(path.join(root,name)).toString('base64').slice(0,200)),'no base64 of '+name+' in inputs.json');
 a(!raw.includes('"encoding"')&&!raw.includes('"data"'));
 a.equal(input.schemaVersion,2);
 a.deepEqual(Object.keys(input.binarySources).sort(),[...B.rendererBinary].sort());
 for(const name of B.rendererBinary){
  const bytes=fs.readFileSync(path.join(root,name)),e=input.binarySources[name];
  a.deepEqual(Object.keys(e).sort(),['file','length','sha256']);
  a.deepEqual({length:e.length,sha256:e.sha256,file:e.file},{length:bytes.length,sha256:B.digest(bytes),file:'binaries/'+B.digest(bytes)});
  a.deepEqual(fs.readFileSync(path.join(dir,e.file)),bytes);
 }
 a.deepEqual(fs.readdirSync(path.join(dir,'binaries')).sort(),B.rendererBinary.map(n=>input.binarySources[n].sha256).sort());
 const checked=SN.verifySnapshot(dir);a.equal(checked.dir,path.resolve(dir));
 a.equal(snapshot(root),dir,'the same inputs are the same immutable snapshot');
}));

test('a binary changed by one byte, truncated, missing, swapped for a symlink or added beside the index is refused',withArea(root=>{
 const dir=snapshot(root),input=JSON.parse(fs.readFileSync(path.join(dir,'inputs.json'),'utf8')),entry=input.binarySources[B.rendererBinary[0]],file=path.join(dir,entry.file),good=fs.readFileSync(file);
 const flipped=Buffer.from(good);flipped[Math.floor(good.length/2)]^=1;fs.writeFileSync(file,flipped);a.throws(()=>SN.verifySnapshot(dir),/hash mismatch/);
 fs.writeFileSync(file,good.subarray(0,good.length-1));a.throws(()=>SN.verifySnapshot(dir),/length mismatch/);
 fs.rmSync(file);a.throws(()=>SN.verifySnapshot(dir),/Missing frozen binary/);
 fs.symlinkSync(path.join(root,B.rendererBinary[0]),file);a.throws(()=>SN.verifySnapshot(dir),/Symlink/);
 fs.rmSync(file);fs.writeFileSync(file,good);a(SN.verifySnapshot(dir));
 fs.writeFileSync(path.join(dir,'binaries',B.digest(Buffer.from('not listed'))),'not listed');a.throws(()=>SN.verifySnapshot(dir),/Unlisted frozen binary/);
}));

test('an index rewritten with coherent hashes still cannot name another file, another length or a path outside the cover/flag/renderer list',withArea(root=>{
 const dir=snapshot(root),name=B.rendererBinary[0],original=fs.readFileSync(path.join(dir,'inputs.json'),'utf8'),manifest=fs.readFileSync(path.join(dir,'manifest.json'),'utf8');
 const restore=()=>{fs.writeFileSync(path.join(dir,'inputs.json'),original);fs.writeFileSync(path.join(dir,'manifest.json'),manifest);};
 for(const [change,message] of [
  [i=>{i.binarySources[name].file='binaries/../inputs.json';},/Invalid binary file/],
  [i=>{i.binarySources[name].file='../'+i.binarySources[name].file;},/Invalid binary file/],
  [i=>{i.binarySources[name].length+=1;},/length mismatch/],
  [i=>{i.binarySources[name].sha256='0'.repeat(64);i.binarySources[name].file='binaries/'+'0'.repeat(64);},/Missing frozen binary|Unlisted/],
  [i=>{i.binarySources[name].data='AAAA';},/Unknown field/],
  [i=>{i.binarySources['tools/selo/planted.py']=i.binarySources[name];},/Unexpected (frozen source path|binary source)/],
  [i=>{i.binarySources['cache/posters-raw/tt1.jpg']=i.binarySources[name];},/Unexpected binary source/],
  [i=>{delete i.binarySources;},/Missing binary index/],
 ]){restore();reseal(dir,change);a.throws(()=>SN.verifySnapshot(dir),message,String(change));}
}));

test('the covers a plan publishes are indexed and written once per distinct content; a cover that is not a JPEG is refused at capture and at verify',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mood-bin-')),out=path.join(root,'cache/posters-out'),dest=path.join(root,'snapshot/binaries');
 try{
  fs.mkdirSync(out,{recursive:true});fs.mkdirSync(dest,{recursive:true});
  for(const tt of ['tt1','tt2'])fs.copyFileSync(COVER,path.join(out,tt+'.jpg'));
  const other=Buffer.concat([fs.readFileSync(COVER).subarray(0,-2),Buffer.from([0,255,217])]);fs.writeFileSync(path.join(out,'tt3.jpg'),other);
  const plan={board:[{id:'r',items:['tt1','tt2','tt3'].map(id=>({id,poster:'https://x.example/posters/'+id+'.jpg'}))}],discover:[]};
  const index=B.capture(root,plan);
  a.deepEqual(Object.keys(index).sort(),['cache/posters-out/tt1.jpg','cache/posters-out/tt2.jpg','cache/posters-out/tt3.jpg']);
  a.equal(index['cache/posters-out/tt1.jpg'].file,index['cache/posters-out/tt2.jpg'].file);
  B.write(root,index,dest);a.equal(fs.readdirSync(dest).length,2,'identical covers are one file');
  a.equal(B.verifyFiles(path.join(root,'snapshot'),index),3);
  fs.writeFileSync(path.join(out,'tt3.jpg'),Buffer.from('not a picture'));a.throws(()=>B.capture(root,plan),/Invalid JPEG/);
  fs.writeFileSync(path.join(out,'tt3.jpg'),other);
  const changed=Buffer.concat([other,Buffer.from([1])]);fs.writeFileSync(path.join(out,'tt3.jpg'),changed);
  fs.rmSync(dest,{recursive:true});fs.mkdirSync(dest);a.throws(()=>B.write(root,index,dest),/changed during capture/);
  const bogus=Buffer.from('not a picture');fs.writeFileSync(path.join(root,'snapshot/binaries',B.digest(bogus)),bogus);
  a.throws(()=>B.verifyFiles(path.join(root,'snapshot'),{'cache/posters-out/tt9.jpg':{length:bogus.length,sha256:B.digest(bogus),file:'binaries/'+B.digest(bogus)}}),/Invalid JPEG/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('the total of 1 GiB (raised from 512 MiB on 13/10/2026: one file per binary, no string; the real set is ~431 MiB) and the 20 MiB per file still bound the index',()=>{
 const sha='a'.repeat(64),entry=(n,length)=>({length,sha256:sha,file:'binaries/'+sha});
 const many={};for(let i=1;i<=52;i++)many['cache/posters-out/tt'+i+'.jpg']=entry(i,20*1024*1024);
 a.throws(()=>B.validateIndex(many),/exceed 1 GiB/);
 a.throws(()=>B.validateIndex({'cache/posters-out/tt1.jpg':entry(1,20*1024*1024+1)}),/Invalid binary length/);
 a.equal(B.validateIndex({'cache/posters-out/tt1.jpg':entry(1,20*1024*1024)}).length,1);
});

test('snapshots written before 13/10/2026 (schema 1, base64 inline) still verify and read back the same bytes',withArea(root=>{
 const dir=snapshot(root),index=JSON.parse(fs.readFileSync(path.join(dir,'inputs.json'),'utf8')).binarySources,fromFiles=B.reader({schemaVersion:2,binarySources:index},dir),v2={names:fromFiles.names,read:n=>fromFiles.read(n),sha:n=>fromFiles.sha(n)},kept=Object.fromEntries(v2.names.map(n=>[n,v2.read(n)]));
 v2.read=n=>kept[n];
 reseal(dir,i=>{i.schemaVersion=1;i.binarySources=inline(root,index);});fs.rmSync(path.join(dir,'binaries'),{recursive:true});
 const old=SN.verifySnapshot(dir),v1=B.reader(old.bodies['inputs.json'],old.dir);
 a.deepEqual(v1.names.sort(),v2.names.sort());
 for(const name of v1.names){a.deepEqual(v1.read(name),v2.read(name));a.equal(v1.sha(name),v2.sha(name));a.deepEqual(v1.read(name),fs.readFileSync(path.join(root,name)));}
 reseal(dir,i=>{const e=i.binarySources[B.rendererBinary[0]];e.data=Buffer.from(e.data,'base64').fill(1).toString('base64');});
 a.throws(()=>SN.verifySnapshot(dir),/hash mismatch/);
}));
