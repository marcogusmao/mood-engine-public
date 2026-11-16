'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),crypto=require('node:crypto');
const BLOCK=262144;
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const contract=()=>import('../worker/src/upload/storage-contract.js');
async function root(type,records){let h=sha('will-storage-v2:'+type);for(let i=0;i<records.length;i+=64)h=sha(h+'\n'+canonical(records.slice(i,i+64)));return h;}
// Sources are explicit files or bounded async iterables. Never walks the repository.
async function writePack({sources,destination}){
 const V=await contract();V.check(Array.isArray(sources)&&sources.length>0&&sources.length<=V.LIMITS.files);
 const sorted=[...sources].sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
 const files=[],chunks=[],whole=crypto.createHash('sha256');let total=0,block=Buffer.alloc(BLOCK),used=0;
 const out=await fsp.open(destination,'wx');
 try{
 for(const source of sorted){V.path(source.path);V.check(!files.length||files.at(-1).path!==source.path,'DUPLICATE_PATH');const h=crypto.createHash('sha256'),offset=total;let size=0;
 const iterable=source.file?fs.createReadStream(source.file,{highWaterMark:BLOCK}):source.open();
 for await(const raw of iterable){const b=Buffer.from(raw);size+=b.length;total+=b.length;V.check(size<=(source.path==='files.json'?V.LIMITS.fileManifestBytes:V.LIMITS.fileBytes)&&total<=V.LIMITS.packBytes,'PACK_BOUNDS');h.update(b);whole.update(b);let written=0;while(written<b.length){const r=await out.write(b,written,b.length-written);V.check(r.bytesWritten>0,'PACK_WRITE');written+=r.bytesWritten;}
 let pos=0;while(pos<b.length){const n=Math.min(BLOCK-used,b.length-pos);b.copy(block,used,pos,pos+n);used+=n;pos+=n;if(used===BLOCK){chunks.push({ordinal:chunks.length,bytes:used,sha256:sha(block)});used=0;}}
 }
 files.push({path:source.path,offset,bytes:size,sha256:h.digest('hex')});
 }
 if(used)chunks.push({ordinal:chunks.length,bytes:used,sha256:sha(block.subarray(0,used))});
 const pages=[];for(let i=0;i<files.length;i+=64){const page=files.slice(i,i+64);V.filePage(page);pages.push(page);}
 return {packBytes:total,fileCount:files.length,chunkCount:chunks.length,files,chunks,pages,filesRoot:await root('files',files),chunksRoot:await root('chunks',chunks),packSha256:whole.digest('hex')};
 }catch(e){await out.close();await fsp.rm(destination,{force:true});throw e;}finally{await out.close().catch(()=>{});}
}
async function* readRange(file,offset,bytes){const V=await contract();V.check(V.integer(offset)&&V.integer(bytes));if(!bytes)return;const stat=await fsp.stat(file);V.check(offset+bytes<=stat.size,'TRUNCATED_PACK');yield* fs.createReadStream(file,{start:offset,end:offset+bytes-1,highWaterMark:BLOCK});}
async function verifyPack(file,descriptor){const V=await contract(),st=await fsp.stat(file);V.check(st.size===descriptor.packBytes,'PACK_SIZE');const whole=crypto.createHash('sha256');for await(const b of readRange(file,0,st.size))whole.update(b);V.check(whole.digest('hex')===descriptor.packSha256,'PACK_HASH');V.check(descriptor.files.length===descriptor.fileCount&&descriptor.chunks.length===descriptor.chunkCount&&descriptor.chunkCount===Math.ceil(st.size/BLOCK),'PACK_COUNTS');let end=0,lastPath=null;for(const f of descriptor.files){V.fileRecord(f);V.check(f.offset===end&&(!lastPath||V.comparePath(lastPath,f.path)<0),'MAP_CONTINUITY');end=f.offset+f.bytes;lastPath=f.path;const h=crypto.createHash('sha256');for await(const b of readRange(file,f.offset,f.bytes))h.update(b);V.check(h.digest('hex')===f.sha256,'FILE_HASH');}V.check(end===st.size,'MAP_CONTINUITY');for(const [i,c] of descriptor.chunks.entries()){V.chunkRecord(c);V.check(c.ordinal===i&&c.bytes===Math.min(BLOCK,st.size-i*BLOCK),'CHUNK_CONTINUITY');const h=crypto.createHash('sha256');for await(const b of readRange(file,i*BLOCK,c.bytes))h.update(b);V.check(h.digest('hex')===c.sha256,'CHUNK_HASH');}V.check(await root('files',descriptor.files)===descriptor.filesRoot&&await root('chunks',descriptor.chunks)===descriptor.chunksRoot,'ROOT_HASH');return true;}
module.exports={writePack,readRange,verifyPack,canonical,sha,root,BLOCK};
