'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),S=require('./schema'),P=require('./paths');
const rendererText=['tools/selo/render.py','tools/selo/selo.py','tools/selo/LiberationSans-LICENSE.txt','tools/selo/language-countries.json','tools/selo/countries.json'];
const rendererBinary=['tools/selo/LiberationSans-Bold.ttf','tools/selo/lb-dots-crop.png','tools/selo/imdb-48-crop.png'];
const MAX_TOTAL=1024*1024*1024,MAX_ONE=20*1024*1024,DIR='binaries';
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const isFlag=name=>/^cache\/flags\/[a-z]{2}\.png$/.test(name);
function flagPng(bytes){S.assert(bytes.length>=57&&bytes.length<=65536&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Invalid flag PNG');let at=8,first=true,ended=false;while(at+12<=bytes.length){const len=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);S.assert(at+12+len<=bytes.length,'Invalid flag PNG chunk');if(first){S.assert(type==='IHDR'&&len===13,'Invalid flag PNG header');const w=bytes.readUInt32BE(at+8),h=bytes.readUInt32BE(at+12);S.assert(w>0&&h>0&&w<=256&&h<=256,'Invalid flag PNG dimensions');first=false;}at+=len+12;if(type==='IEND'){S.assert(len===0&&at===bytes.length,'Invalid flag PNG end');ended=true;break;}}S.assert(ended,'Invalid flag PNG end');return bytes;}
function allowed(name){P.sourcePath(name);S.assert(rendererBinary.includes(name)||isFlag(name)||/^cache\/posters-out\/tt\d+\.jpg$/.test(name),'Unexpected binary source');}
// What the bytes of one frozen binary must look like, by name: a flag is a small PNG, a cover is a JPEG.
function content(name,bytes){if(isFlag(name))flagPng(bytes);if(name.endsWith('.jpg'))require('./public').jpeg(bytes);}

// Schema 1 (until 13/10/2026): every binary inline in inputs.json as base64. Kept ONLY to read snapshots already on disk. Writing it again is what broke
// the CI on 13/10/2026: with 11,103 covers the base64 of the whole map is 575 MB, past V8's 536,870,888-character string limit.
function validate(map={}){S.assert(map&&typeof map==='object'&&!Array.isArray(map),'Invalid binary sources');S.assert(Object.keys(map).length<=20000,'Too many binary sources');S.assert(Object.keys(map).filter(isFlag).length<=300,'Too many frozen flags');let total=0;const result={};for(const [name,value] of Object.entries(map)){allowed(name);S.keys(value,['encoding','length','sha256','data']);S.assert(value.encoding==='base64'&&typeof value.data==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data),'Invalid binary base64');S.assert(Number.isInteger(value.length)&&value.length>0&&value.length<=MAX_ONE,'Invalid binary length');total+=value.length;S.assert(total<=MAX_TOTAL,'Binary sources exceed 1 GiB');const bytes=Buffer.from(value.data,'base64');S.assert(bytes.toString('base64')===value.data&&bytes.length===value.length,'Binary length mismatch');S.assert(digest(bytes)===value.sha256,'Binary hash mismatch');content(name,bytes);result[name]=bytes;}return result;}

// Schema 2 (inputs.json schemaVersion 2): inputs.json keeps only an index {name:{length,sha256,file}}; the bytes are one file each in <snapshot>/binaries/<sha256>
// (identical bytes, such as a cover reused by several films, are one file). No point holds all the binaries as one string or one buffer.
function validateIndex(index={}){
 S.assert(index&&typeof index==='object'&&!Array.isArray(index),'Invalid binary sources');
 const names=Object.keys(index);
 S.assert(names.length<=20000,'Too many binary sources');S.assert(names.filter(isFlag).length<=300,'Too many frozen flags');
 let total=0;
 for(const name of names){
  allowed(name);const e=index[name];S.keys(e,['length','sha256','file']);
  S.assert(Number.isInteger(e.length)&&e.length>0&&e.length<=MAX_ONE,'Invalid binary length');
  S.assert(typeof e.sha256==='string'&&/^[a-f0-9]{64}$/.test(e.sha256),'Invalid binary hash');
  S.assert(e.file===DIR+'/'+e.sha256,'Invalid binary file');
  total+=e.length;S.assert(total<=MAX_TOTAL,'Binary sources exceed 1 GiB');
 }
 return names;
}
function sourceNames(root,plan,index){const names=rendererBinary.filter(n=>fs.existsSync(path.join(root,n)));const flags=path.join(root,'cache/flags');if(fs.existsSync(flags)){P.noAliases(flags,path.resolve(root));for(const name of fs.readdirSync(flags))names.push('cache/flags/'+name);}if(plan)for(const tt of require('./plan-posters').publishedIds(plan,index))names.push('cache/posters-out/'+tt+'.jpg');return names;}
// The index of the binaries under root (renderer fonts and pictures, flags, and the covers the plan publishes). Reads the files one at a time and keeps only
// length and sha256; write() puts the bytes into a snapshot afterwards.
function capture(root,plan,index=null){
 const names=sourceNames(root,plan,index);let total=0;
 for(const name of names){allowed(name);const file=path.join(root,name);P.noAliases(file,path.resolve(root));const stat=fs.statSync(file);S.assert(stat.isFile(),'Binary source is not regular');S.assert(stat.size>0&&stat.size<=MAX_ONE,'Invalid binary length');total+=stat.size;}
 if(total>MAX_TOTAL){const err=new Error('Binary sources total '+total+' exceeds limit '+MAX_TOTAL+' ('+names.length+' names, '+Math.round(total/MAX_TOTAL*1000)/10+'% of the cap): raise MAX_TOTAL in lib/learning/binary.js or freeze fewer covers');err.kind='binary-total-exceeded';err.total=total;err.limit=MAX_TOTAL;throw err;}
 const out={};
 for(const name of names){allowed(name);const file=path.join(root,name);P.noAliases(file,path.resolve(root));S.assert(fs.statSync(file).isFile(),'Binary source is not regular');const bytes=fs.readFileSync(file);content(name,bytes);const sha256=digest(bytes);out[name]={length:bytes.length,sha256,file:DIR+'/'+sha256};}
 validateIndex(out);return out;
}
// How much of the cap an index uses, for the log of capture. The cap counts the declared bytes of every name; `files` is what lands on disk (identical bytes are one file).
// 13/10/2026: the real set is ~431 MiB of the 1 GiB, so the line shows how much room is left before capture refuses.
function usage(index){let bytes=0;const files=new Set();for(const e of Object.values(index)){bytes+=e.length;files.add(e.sha256);}return {names:Object.keys(index).length,files:files.size,bytes,limit:MAX_TOTAL,percent:Math.round(bytes/MAX_TOTAL*1000)/10};}
function describe(index){const u=usage(index),mib=n=>(n/1048576).toFixed(1);return 'Snapshot binaries: '+u.names+' names, '+u.files+' files, '+u.bytes+' bytes ('+mib(u.bytes)+' MiB) = '+u.percent+'% of the '+mib(u.limit)+' MiB cap';}
// Writes the bytes of every indexed binary as <dest>/<sha256> (dest exists and is private). Each source is read again and must still be the bytes indexed.
function write(root,index,dest){
 validateIndex(index);const written=new Set();
 for(const [name,e] of Object.entries(index)){
  const file=path.join(root,name);P.noAliases(file,path.resolve(root));
  const bytes=fs.readFileSync(file);
  S.assert(bytes.length===e.length&&digest(bytes)===e.sha256,'Binary source changed during capture: '+name);
  if(written.has(e.sha256))continue;
  fs.writeFileSync(path.join(dest,e.sha256),bytes,{flag:'wx',mode:0o600});written.add(e.sha256);
 }
}
// One frozen binary read back from the snapshot at dir: size, sha256 and the picture format are checked on every read.
function readFrozen(dir,index,name){
 const e=index[name];S.assert(e,'Missing frozen binary: '+name);
 const file=path.join(dir,e.file);P.noAliases(file,path.resolve(dir));
 let stat;try{stat=fs.lstatSync(file);}catch(err){if(err.code==='ENOENT')throw new Error('Missing frozen binary: '+name);throw err;}
 S.assert(stat.isFile()&&stat.size===e.length,'Binary length mismatch');
 const bytes=fs.readFileSync(file);
 S.assert(bytes.length===e.length&&digest(bytes)===e.sha256,'Binary hash mismatch');
 content(name,bytes);return bytes;
}
// Every indexed binary is present with its declared size, sha256 and format, and binaries/ holds nothing the index does not list.
function verifyFiles(dir,index){
 const names=validateIndex(index),base=path.join(dir,DIR),want=new Set(),seen=new Set();
 P.noAliases(base,path.resolve(dir));
 for(const name of names){
  const e=index[name];want.add(e.sha256);
  const kind=e.sha256+(isFlag(name)?'f':name.endsWith('.jpg')?'j':'o');
  if(seen.has(kind))continue;seen.add(kind);
  readFrozen(dir,index,name);
 }
 let present=[];try{present=fs.readdirSync(base);}catch(err){if(err.code!=='ENOENT')throw err;}
 for(const f of present)S.assert(want.has(f),'Unlisted frozen binary: '+f);
 return names.length;
}
// The binaries of an inputs.json body as {names, sha(name), read(name)}, whatever its schema. Schema 2 needs the snapshot folder.
function reader(input,dir){
 if(input.schemaVersion===2){
  S.assert(typeof dir==='string'&&dir,'Snapshot directory required');const index=input.binarySources||{};validateIndex(index);
  return {names:Object.keys(index),sha:name=>index[name].sha256,read:name=>readFrozen(dir,index,name)};
 }
 const map=validate(input.binarySources||{});
 return {names:Object.keys(map),sha:name=>digest(map[name]),read:name=>map[name]};
}
function rendererIdentity(root,input){for(const name of [...rendererText,...rendererBinary]){const expected=rendererText.includes(name)?input.sourceBytes[name]:input.binarySources?.[name];S.assert(expected,'Missing frozen renderer component: '+name);const file=path.join(root,name);P.noAliases(file,path.resolve(root));S.assert(fs.existsSync(file)&&fs.statSync(file).isFile(),'Missing local renderer component: '+name);const bytes=fs.readFileSync(file);S.assert(rendererText.includes(name)?bytes.toString('utf8')===expected:digest(bytes)===expected.sha256,'Local renderer identity mismatch: '+name);}}
module.exports={MAX_TOTAL,usage,describe,rendererText,rendererBinary,digest,validate,validateIndex,capture,write,readFrozen,verifyFiles,reader,rendererIdentity,isFlag,flagPng,DIR};
