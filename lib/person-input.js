'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const P=require('./learning/paths'),S=require('./learning/schema');
// Personal config is derived by the current build, never restored from input.
const FILES=['history.json','identities.json','coverage.json','cache/tmdb.json','cache/friends.json','cache/lists.json','cache/imdb-ratings.json','cache/mubi.json','cache/posters.json','cache/front-memory.json'];
const canonical=S.canonical, sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function write(file,value){P.privateTarget(file);P.mkdirPrivate(path.dirname(file));const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,canonical(value),{mode:0o600,flag:'wx'});P.privateTarget(file);fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}}
const validateHistory=require('./person-input-validation').history;
function importArchive({root,privateDir,archive,capturedAt,requestId}){
 const dir=require('./people').privateRoot(root,privateDir);P.mkdirPrivate(dir);
 const stage=fs.mkdtempSync(path.join(dir,'.import-'));
 try{
  execFileSync('python3',['-B',path.join(__dirname,'../scripts/validate-letterboxd-export.py'),path.resolve(archive),path.join(stage,'history.json'),capturedAt,requestId],{timeout:60000,maxBuffer:16384,stdio:['ignore','ignore','pipe']});
  const h=validateHistory(JSON.parse(fs.readFileSync(path.join(stage,'history.json'),'utf8')));
  write(path.join(dir,'history.json'),h);return h;
 }catch(e){throw Error(/EXPORT_[A-Z_]+|ZIP_[A-Z_]+/.exec(String(e.stderr||e.message))?.[0]||'EXPORT_INVALID');}
 finally{fs.rmSync(stage,{recursive:true,force:true});}
}
function loadHistory(h){
 validateHistory(h);const films=new Map(),diary=[];
 const titleUris=new Map();for(const k of ['watched','ratings','watchlist','likes','diary'])for(const r of h[k]){const key=require('./util').filmKey(r.title,r.year);if(!titleUris.has(key))titleUris.set(key,new Set());titleUris.get(key).add(r.uri);}
 const get=r=>{if(!films.has(r.uri))films.set(r.uri,{key:r.uri,uri:r.uri,title:r.title,year:r.year,liked:false,watched:false,watchlist:false,rewatches:0,pendingIdentity:titleUris.get(require('./util').filmKey(r.title,r.year)).size>1});return films.get(r.uri);};
 for(const r of h.watched)get(r).watched=true;
 for(const r of h.ratings)Object.assign(get(r),{watched:true,rating:r.rating,ratedOn:r.date});
 for(const r of h.likes)get(r).liked=true;
 for(const r of h.watchlist)Object.assign(get(r),{watchlist:true,watchlistedOn:r.date});
 for(const r of h.diary){const f=get(r);f.watched=true;if(r.watchedDate&&(!f.lastWatched||r.watchedDate>f.lastWatched))f.lastWatched=r.watchedDate;if(r.rewatch)f.rewatches++;diary.push({key:f.key,title:f.title,year:f.year,rating:r.rating,watchedDate:r.watchedDate,rewatch:r.rewatch,entryId:r.entryId});}
 // A homonym collision remains seen, but cannot borrow a title/year search hit.
 for(const f of films.values())if(f.pendingIdentity){f.rating=null;f.liked=false;f.watchlist=false;}
 return {films,diary:diary.sort((a,b)=>String(b.watchedDate).localeCompare(String(a.watchedDate)))};
}
function snapshot({root,privateDir,sourceRequestId,codeSha,capturedAt,selectionDate}){
 const dir=require('./people').privateRoot(root,privateDir);const files=[];
 for(const name of FILES){const file=path.join(dir,name);P.noAliases(file,dir);if(!fs.existsSync(file))continue;const data=JSON.parse(fs.readFileSync(file,'utf8')),bytes=Buffer.from(canonical(data));files.push({path:name,bytes:bytes.length,sha256:sha(bytes),data});}
 for(const name of FILES.slice(0,3))if(!files.some(f=>f.path===name))throw Error('Snapshot missing required input');
 const out={schemaVersion:1,personId:'friend-a',parserVersion:1,sourceRequestId,codeSha,capturedAt,selectionDate,files:files.sort((a,b)=>a.path.localeCompare(b.path))};validateSnapshot(out);const bytes=Buffer.from(canonical(out));if(bytes.length>64*1024*1024)throw Error('Snapshot too large');return bytes;
}
function validateSnapshot(s){
 if(s.schemaVersion!==1||s.personId!=='friend-a'||s.parserVersion!==1||!Array.isArray(s.files)||!/^[a-f0-9]{40}$/.test(s.codeSha)||!/^\d{4}-\d\d-\d\d$/.test(s.selectionDate)||!Number.isFinite(Date.parse(s.capturedAt)))throw Error('Invalid snapshot');
 if(Object.keys(s).sort().join(',')!==['schemaVersion','personId','parserVersion','sourceRequestId','codeSha','capturedAt','selectionDate','files'].sort().join(','))throw Error('Unknown snapshot field');
 const seen=new Set();let size=0;
 for(const f of s.files){if(!FILES.includes(f.path)||seen.has(f.path)||Object.keys(f).sort().join(',')!=='bytes,data,path,sha256')throw Error('Invalid snapshot file');seen.add(f.path);const b=Buffer.from(canonical(f.data));size+=b.length;if(b.length!==f.bytes||sha(b)!==f.sha256)throw Error('Snapshot hash mismatch');}
 if(size>64*1024*1024||FILES.slice(0,3).some(f=>!seen.has(f)))throw Error('Invalid snapshot bounds');require('./person-input-validation').contents(s);return s;
}
function restore({root,privateDir,bytes}){
 if(bytes.length>64*1024*1024)throw Error('Snapshot too large');let parsed;try{parsed=JSON.parse(bytes);}catch{throw Error('Invalid snapshot JSON');}const s=validateSnapshot(parsed);if(canonical(s)!==bytes.toString('utf8'))throw Error('Noncanonical snapshot');
 const dir=require('./people').privateRoot(root,privateDir);if(fs.existsSync(dir)&&fs.readdirSync(dir).length)throw Error('Restore requires a fresh private directory');
 for(const f of s.files)write(path.join(dir,f.path),f.data);return s;
}
// Versioned gzip envelope: normalized inputs plus exact, verified public bytes.
// No archive extraction, executable content evaluation, or caller-selected destinations.
const PACKAGE_LIMIT=64*1024*1024, EXPANDED_LIMIT=384*1024*1024;
function pack({snapshotBytes,releaseDir}) {
 const snapshotDoc=validateSnapshot(JSON.parse(snapshotBytes));
 const pub=require('./people-publication');pub.verifyRelease(releaseDir);
 const files=pub.walk(releaseDir).map(file=>{const b=fs.readFileSync(file);return {path:path.relative(releaseDir,file).split(path.sep).join('/'),bytes:b.length,sha256:sha(b),base64:b.toString('base64')};}).sort((a,b)=>a.path.localeCompare(b.path));
 const raw=Buffer.from(canonical({packageVersion:1,personId:'friend-a',snapshot:snapshotDoc,release:files}));
 if(raw.length>EXPANDED_LIMIT)throw Error('Package expanded limit');
 const bytes=require('node:zlib').gzipSync(raw,{level:9});if(bytes.length>PACKAGE_LIMIT)throw Error('Snapshot too large');return bytes;
}
function unpack(bytes) {
 if(bytes.length>PACKAGE_LIMIT)throw Error('Snapshot too large');
 if(bytes[0]!==0x1f||bytes[1]!==0x8b){const snapshot=validateSnapshot(JSON.parse(bytes));if(canonical(snapshot)!==bytes.toString('utf8'))throw Error('Noncanonical snapshot');return {snapshot,release:null};}
 const raw=require('node:zlib').gunzipSync(bytes,{maxOutputLength:EXPANDED_LIMIT});
 const doc=JSON.parse(raw);if(canonical(doc)!==raw.toString('utf8'))throw Error('Noncanonical package');S.keys(doc,['packageVersion','personId','snapshot','release']);
 if(doc.packageVersion!==1||doc.personId!=='friend-a'||!Array.isArray(doc.release)||doc.release.length>30002)throw Error('Invalid package');
 validateSnapshot(doc.snapshot);const seen=new Set();let size=0;
 for(const f of doc.release){S.keys(f,['path','bytes','sha256','base64']);
  if(typeof f.path!=='string'||f.path.includes('\\')||f.path.split('/').some(p=>!p||p==='.'||p==='..')||!(require('./learning/public').isPublicFile(f.path)||/^posters\/tt\d+\.jpg$/.test(f.path))||seen.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<0||typeof f.base64!=='string')throw Error('Invalid package path');
  seen.add(f.path);const b=Buffer.from(f.base64,'base64');size+=b.length;
  if(size>256*1024*1024||b.length!==f.bytes||b.toString('base64')!==f.base64||sha(b)!==f.sha256)throw Error('Package hash or size mismatch');
 }
 return doc;
}
function restorePackage({root,privateDir,bytes,releaseDir,descriptor}) {
 const doc=unpack(bytes);restore({root,privateDir,bytes:Buffer.from(canonical(doc.snapshot))});
 if(releaseDir){require('./people').noSymlinks(path.parse(path.resolve(releaseDir)).root,path.resolve(releaseDir));if(!doc.release)throw Error('Prepared package missing release');if(fs.existsSync(releaseDir))throw Error('Release requires fresh directory');
  fs.mkdirSync(releaseDir,{recursive:true});try{for(const f of doc.release){const file=path.join(releaseDir,f.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(f.base64,'base64'),{flag:'wx'});}
   const {receipt}=require('./people-publication').verifyRelease(releaseDir,descriptor);
   if(receipt.codeSha!==doc.snapshot.codeSha||receipt.builtAt!==doc.snapshot.capturedAt||(descriptor?.codeSha&&receipt.codeSha!==descriptor.codeSha))throw Error('Prepared package identity mismatch');
  }catch(e){fs.rmSync(releaseDir,{recursive:true,force:true});throw e;}
 }
 return doc.snapshot;
}
module.exports={pack,unpack,restorePackage,PACKAGE_LIMIT,EXPANDED_LIMIT,FILES,canonical,sha,write,importArchive,validateHistory,loadHistory,snapshot,restore,validateSnapshot};
