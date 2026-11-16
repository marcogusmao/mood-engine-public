'use strict';
const {createHash}=require('node:crypto');
const {canonical,sha}=require('../lib/will-public-pack');
// All data is generated here. Opaque poster bytes are NOT valid JPEG evidence.
function fixture({seed='small',files=70,bytes=3500000}={}){
 if(files<7||bytes<2400000)throw Error('fixture needs >=7 files and >=2400000 bytes');
 const count=files-3,context=Buffer.from(canonical({storageVersion:2,personId:'friend-a',synthetic:true,seed}));
 const pattern=i=>createHash('sha256').update(`${seed}:${i}`).digest();
 function* parts(i,size){const p=pattern(i),block=Buffer.alloc(Math.min(262144,size));if(size)block.fill(p);let offset=0;while(offset<size){const n=Math.min(block.length,size-offset);yield block.subarray(0,n);offset+=n;}}
 const fileHash=(i,size)=>{const h=createHash('sha256');for(const b of parts(i,size))h.update(b);return h.digest('hex');};
 // Hash lengths are fixed; use length-only records until the exact byte budget converges.
 let overhead=context.length+count*140+400,sizes,manifestBytes,receiptBytes;
 for(let pass=0;pass<10;pass++){
 sizes=[0,262143,2100001];let remaining=bytes-overhead-sizes.reduce((a,b)=>a+b,0);if(remaining<0)throw Error('fixture budget too small');
 for(let i=3;i<count;i++){const n=Math.floor(remaining/(count-i));sizes.push(n);remaining-=n;}
 const entries=sizes.map((size,i)=>({path:`posters/tt${String(i).padStart(8,'0')}.jpg`,bytes:size,sha256:'0'.repeat(64)}));entries.unshift({path:'data/person.json',bytes:context.length,sha256:sha(context)});
 const manifest=Buffer.from(canonical(entries)),receipt=Buffer.from(canonical({storageVersion:2,personId:'friend-a',synthetic:true,filesSha256:sha(manifest),personContextSha256:sha(context)}));const actual=context.length+manifest.length+receipt.length;if(actual===overhead)break;overhead=actual;if(pass===9)throw Error('fixture size did not converge');
 }
 const records=sizes.map((size,i)=>({path:`posters/tt${String(i).padStart(8,'0')}.jpg`,bytes:size,sha256:fileHash(i,size)}));records.unshift({path:'data/person.json',bytes:context.length,sha256:sha(context)});
 manifestBytes=Buffer.from(canonical(records));receiptBytes=Buffer.from(canonical({storageVersion:2,personId:'friend-a',synthetic:true,filesSha256:sha(manifestBytes),personContextSha256:sha(context)}));
 const inline=(path,data)=>({path,bytes:data.length,async *open(){yield data;}});
 const sources=sizes.map((size,i)=>({path:`posters/tt${String(i).padStart(8,'0')}.jpg`,bytes:size,async *open(){yield* parts(i,size);}}));sources.push(inline('data/person.json',context),inline('files.json',manifestBytes),inline('publication.json',receiptBytes));
 if(sources.reduce((n,s)=>n+s.bytes,0)!==bytes)throw Error('fixture exact byte budget failed');return sources;
}
module.exports={fixture};
