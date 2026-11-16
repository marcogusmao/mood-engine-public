import * as V from './storage-contract.js';
// Production counters are volatile. Only the local fixture opts into persistence.
// A fixture snapshot includes its forthcoming response flush; flush asserts that cost.
export class Meter {
 constructor(storage,prefix,{persistent=false}={}){
  this.storage=storage;this.prefix=prefix;this.pending={reads:0,writes:0,queries:0};
  this.available=true;this.persistent=persistent;
  if(!persistent)return;
  this.exec(`CREATE TABLE IF NOT EXISTS ${prefix}_metrics (id INTEGER PRIMARY KEY, reads INTEGER, writes INTEGER, queries INTEGER)`);
  this.exec(`INSERT OR IGNORE INTO ${prefix}_metrics VALUES (1,0,0,0)`);
 }
 exec(sql,...args){
  const cursor=this.storage.sql.exec(sql,...args),rows=cursor.toArray();
  this.pending.queries++;
  if(typeof cursor.rowsRead!=='number'||typeof cursor.rowsWritten!=='number')this.available=false;
  else {this.pending.reads+=cursor.rowsRead;this.pending.writes+=cursor.rowsWritten;}
  return rows;
 }
 flush(){
  if(!this.persistent)return;
  const p=this.pending;
  const cursor=this.storage.sql.exec(`UPDATE ${this.prefix}_metrics SET reads=reads+?,writes=writes+?,queries=queries+? WHERE id=1`,p.reads+1,p.writes+1,p.queries+1);
  cursor.toArray();
  if(typeof cursor.rowsRead==='number')V.check(cursor.rowsRead===1&&cursor.rowsWritten===1,'METRICS_ACCOUNTING_CHANGED');
  this.pending={reads:0,writes:0,queries:0};
 }
 snapshot(){
  if(!this.persistent)return {
   ...this.pending,available:this.available,
   reads:this.available?this.pending.reads:null,writes:this.available?this.pending.writes:null,
   databaseSize:this.storage.sql.databaseSize??null,
   boundary:'volatile since instance construction; explicit collection, no SQL writes'
  };
  const r=this.exec(`SELECT * FROM ${this.prefix}_metrics WHERE id=1`)[0];
  return {
   reads:this.available?r.reads+this.pending.reads+1:null,
   writes:this.available?r.writes+this.pending.writes+1:null,
   queries:r.queries+this.pending.queries+1,available:this.available,
   databaseSize:this.storage.sql.databaseSize??null,
   boundary:'includes the response flush; its one read/write is asserted by flush()'
  };
 }
}
let isolatePins=0,isolateMaxPins=0;
export function createWillReleaseClass({now=()=>Date.now(),pause=async()=>{},meterOptions={}}={}){
 return class WillRelease {
 constructor(ctx){this.ctx=ctx;this.storage=ctx.storage;this.m=new Meter(ctx.storage,'release',meterOptions);this.pins=0;this.maxPins=0;this.cancelled=0;
 this.q('CREATE TABLE IF NOT EXISTS slot_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
 this.q('CREATE TABLE IF NOT EXISTS chunks (ordinal INTEGER PRIMARY KEY, bytes INTEGER, sha256 TEXT, data BLOB)');
 this.q('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, offset INTEGER, bytes INTEGER, sha256 TEXT) WITHOUT ROWID');
 this.q('CREATE TABLE IF NOT EXISTS file_pages (page INTEGER PRIMARY KEY, canonicalBytes TEXT, sha256 TEXT)');
 this.q('CREATE TABLE IF NOT EXISTS control_receipts (operationId TEXT PRIMARY KEY, command TEXT, receipt TEXT) WITHOUT ROWID');
 if(!this.state())this.save({slotEpoch:0,phase:'FREE',controlVersion:0});this.m.flush();}
 q(...a){return this.m.exec(...a);}
 state(){return JSON.parse(this.q('SELECT value FROM slot_state WHERE id=1')[0]?.value||'null');}
 save(s){this.q('INSERT INTO slot_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',V.canonical(s));}
 tx(fn){return this.storage.transactionSync(fn);}
 budget(){V.check((this.storage.sql.databaseSize||0)<=V.LIMITS.slotPhysicalBytes,'STORAGE_BUDGET_DEFERRED');}
 validRef(r,s=this.state()){V.ref(r,false);V.check(s.allocation&&V.sameRef(r,s.allocation),'STALE_EPOCH');return s;}
 writable(p){V.permit(p);const s=this.validRef(p);V.check(s.phase==='WRITING'&&s.fence===p.writerFence&&p.leaseEpoch===s.allocation.leaseEpoch&&s.allocation.allocationHash===p.allocationHash&&p.expiresAt>now(),'WRITE_FENCED');return s;}
 async put(p,body){this.writable(p);const canonical=p.action==='page'?V.canonical(V.filePage(body)):null;
 const bytes=p.action==='chunk'?body:V.utf8(canonical);V.check(bytes instanceof Uint8Array&&bytes.length<=(p.action==='chunk'?V.LIMITS.blockBytes:V.LIMITS.pageBytes),'BODY_BOUNDS');
 const h=await V.hash(bytes);await pause('slot:put:after-hash',this);
 return this.tx(()=>{const s=this.writable(p),a=s.allocation;
 if(p.action==='chunk'){const expected=Math.min(V.LIMITS.blockBytes,a.packBytes-p.address*V.LIMITS.blockBytes);V.check(p.address<a.chunkCount&&bytes.length===expected,'CHUNK_BOUNDS');const old=this.q('SELECT bytes,sha256 FROM chunks WHERE ordinal=?',p.address)[0];if(old){V.check(old.bytes===bytes.length&&old.sha256===h,'PUT_CONFLICT');return {duplicate:true};}this.q('INSERT INTO chunks VALUES (?,?,?,?)',p.address,bytes.length,h,bytes);}
 else {V.check(p.address<Math.ceil(a.fileCount/64)&&body.length===Math.min(64,a.fileCount-p.address*64),'PAGE_BOUNDS');const old=this.q('SELECT canonicalBytes FROM file_pages WHERE page=?',p.address)[0];if(old){V.check(old.canonicalBytes===canonical,'PUT_CONFLICT');return {duplicate:true};}
 for(const f of body){V.check(f.offset+f.bytes<=a.packBytes,'FILE_BOUNDS');V.check(!this.q('SELECT path FROM files WHERE path=?',f.path)[0],'DUPLICATE_PATH');this.q('INSERT INTO files VALUES (?,?,?,?)',f.path,f.offset,f.bytes,f.sha256);}this.q('INSERT INTO file_pages VALUES (?,?,?)',p.address,canonical,h);}
 this.budget();return {duplicate:false,sha256:h};});}
 async fileHash(f){const bytes=new Uint8Array(f.bytes);let pos=0;
 while(pos<f.bytes){const at=f.offset+pos,ordinal=Math.floor(at/V.LIMITS.blockBytes),chunk=this.q('SELECT data FROM chunks WHERE ordinal=?',ordinal)[0];V.check(chunk,'INCOMPLETE_PACK');const raw=new Uint8Array(chunk.data),start=at%V.LIMITS.blockBytes,n=Math.min(raw.length-start,f.bytes-pos);V.check(n>0,'INCOMPLETE_PACK');bytes.set(raw.subarray(start,start+n),pos);pos+=n;}
 return V.hash(bytes);}
 receipt(c,s,result={}){return {...V.publicRef(c),operationId:c.operationId,controlVersion:c.controlVersion,action:c.action,args:c.args,phase:s.phase,...result};}
 remember(c,r){this.q('INSERT INTO control_receipts VALUES (?,?,?)',c.operationId,V.canonical(c),V.canonical(r));this.q('DELETE FROM control_receipts WHERE operationId IN (SELECT operationId FROM control_receipts ORDER BY operationId LIMIT MAX(0,(SELECT COUNT(*) FROM control_receipts)-16))');}
 recalled(c){const old=this.q('SELECT command,receipt FROM control_receipts WHERE operationId=?',c.operationId)[0];if(old){V.check(old.command===V.canonical(c),'CONTROL_CONFLICT');return JSON.parse(old.receipt);}}
 async control(c){V.control(c);const old=this.recalled(c);if(old)return old;
 let s=this.state();if(c.action==='status'){this.validRef(c,s);return this.receipt(c,s,{sealReceipt:s.sealReceipt||null,terminal:s.terminal||null,progress:s.progress||null,...(s.phase==='WRITING'?{counts:{chunks:this.q('SELECT COUNT(*) AS n FROM chunks')[0].n,files:this.q('SELECT COUNT(*) AS n FROM files')[0].n,pages:this.q('SELECT COUNT(*) AS n FROM file_pages')[0].n}}:{})});}
 if(c.action==='init'){
 await V.validateAllocation(c.args.allocation);V.check(V.sameRef(c,c.args.allocation),'INIT_REF');await pause('slot:init:before-commit',this);
 // Transport failure does not cancel a received init. Recheck its durable
 // receipt inside the commit transaction, after every await. A replay returns
 // only the historical receipt; it never restores state over freeze or retire.
 return this.tx(()=>{const committed=this.recalled(c);if(committed)return committed;s=this.state();V.check(s.phase==='FREE'&&c.slotEpoch===s.slotEpoch+1,'INIT_EPOCH');V.check(V.integer(c.args.writerFence,1),'WRITE_FENCED');const a=c.args.allocation;V.check(1.2*a.packBytes+V.utf8(V.canonical(a)).length+2*1024*1024<=V.LIMITS.slotPhysicalBytes,'STORAGE_BUDGET_DEFERRED');
 this.q('DELETE FROM control_receipts');s={slotEpoch:c.slotEpoch,phase:'WRITING',allocation:a,fence:c.args.writerFence,controlVersion:c.controlVersion};this.save(s);this.budget();const r=this.receipt(c,s);this.remember(c,r);return r;});}
 this.validRef(c,s);V.check(c.controlVersion>=s.controlVersion,'STALE_CONTROL');
 if(c.action==='seal')return this.seal(c);
 return this.tx(()=>{s=this.validRef(c);V.check(c.controlVersion>=s.controlVersion,'STALE_CONTROL');
 if(c.action==='freeze'){V.check(['WRITING','FROZEN','SEALING','SEALED'].includes(s.phase)&&c.args.writerFence>s.fence,'WRITE_FENCED');s.fence=c.args.writerFence;if(['WRITING','SEALING'].includes(s.phase))s.phase='FROZEN';}
 if(c.action==='retire'){V.check(['WRITING','FROZEN','SEALED','SEALING','RETIRING'].includes(s.phase),'INVALID_PHASE');V.check(V.integer(c.args.writerFence,1)&&c.args.writerFence>=s.fence,'WRITE_FENCED');s.phase='RETIRING';s.fence=c.args.writerFence;}
 if(c.action==='gc'){V.check(['RETIRING','GC'].includes(s.phase),'GC_NOT_RETIRED');if(this.pins)return this.receipt(c,s,{waitingPins:this.pins,done:false});s.phase='GC';
 const cursor=s.progress?.gc||{files:null,chunks:null,file_pages:null,deleted:0};let budget=128;for(const [table,key] of [['files','path'],['chunks','ordinal'],['file_pages','page']]){if(!budget)break;const rows=this.q(`SELECT ${key} FROM ${table} ORDER BY ${key} LIMIT ?`,budget);for(const row of rows){this.q(`DELETE FROM ${table} WHERE ${key}=?`,row[key]);cursor[table]=row[key];cursor.deleted++;}budget-=rows.length;}
 const left=['files','chunks','file_pages'].some(t=>this.q(`SELECT 1 AS n FROM ${t} LIMIT 1`)[0]);s.progress={remaining:left,gc:cursor};if(!left){s.phase='FREE';s.terminal={operationId:c.operationId,slotEpoch:c.slotEpoch};}}
 s.controlVersion=c.controlVersion;this.save(s);this.budget();const r=this.receipt(c,s,{done:s.phase==='FREE',physicalBytes:this.storage.sql.databaseSize??null,...(c.action==='freeze'?{sealReceipt:s.sealReceipt||null}:{}),...(c.action==='gc'?{cursor:s.progress.gc}:{})});if(c.action!=='gc'||s.phase==='FREE')this.remember(c,r);return r;});}
 async seal(c){let s=this.validRef(c);if(s.phase==='SEALED')return this.receipt(c,s,{sealReceipt:s.sealReceipt});V.check(['WRITING','FROZEN','SEALING'].includes(s.phase),'INVALID_PHASE');
 if(!s.progress||s.phase!=='SEALING'){V.check(this.q('SELECT COUNT(*) AS n FROM chunks')[0].n===s.allocation.chunkCount&&this.q('SELECT COUNT(*) AS n FROM file_pages')[0].n===Math.ceil(s.allocation.fileCount/64),'INCOMPLETE_PACK');const f=await V.rootStart('files'),h=await V.rootStart('chunks');this.tx(()=>{s=this.validRef(c);V.check(['WRITING','FROZEN'].includes(s.phase)&&c.controlVersion>=s.controlVersion,'STALE_CONTROL');s.phase='SEALING';s.controlVersion=c.controlVersion;s.progress={page:0,chunk:0,filesRoot:f,chunksRoot:h,offset:0,lastPath:null};this.save(s);});}
 s=this.validRef(c);const before=V.canonical(s.progress),p={...s.progress},a=s.allocation;
 if(p.page<Math.ceil(a.fileCount/64)){
 const row=this.q('SELECT canonicalBytes FROM file_pages WHERE page=?',p.page)[0];V.check(row,'INCOMPLETE_PACK');const page=V.filePage(JSON.parse(row.canonicalBytes));V.check(page[0].offset===p.offset&&(!p.lastPath||V.comparePath(p.lastPath,page[0].path)<0),'MAP_CONTINUITY');
 for(const f of page)V.check(await this.fileHash(f)===f.sha256,'FILE_HASH');p.filesRoot=await V.rootNext(p.filesRoot,page);p.offset=page.at(-1).offset+page.at(-1).bytes;p.lastPath=page.at(-1).path;p.page++;
 }else if(p.chunk<a.chunkCount){const rows=this.q('SELECT ordinal,bytes,sha256 FROM chunks WHERE ordinal>=? ORDER BY ordinal LIMIT 64',p.chunk);V.check(rows.length===Math.min(64,a.chunkCount-p.chunk),'INCOMPLETE_PACK');rows.forEach((r,i)=>V.check(r.ordinal===p.chunk+i,'CHUNK_CONTINUITY'));p.chunksRoot=await V.rootNext(p.chunksRoot,rows);p.chunk+=rows.length;}
 const done=p.page===Math.ceil(a.fileCount/64)&&p.chunk===a.chunkCount;
 let sealReceipt=null;if(done){for(const [path,key] of [['files.json','fileManifestSha256'],['publication.json','receiptSha256'],['data/person.json','personContextSha256']]){const f=this.q('SELECT sha256 FROM files WHERE path=?',path)[0];V.check(f?.sha256===a[key],'PUBLIC_DESCRIPTOR_HASH');}V.check(p.offset===a.packBytes&&p.filesRoot===a.filesRoot&&p.chunksRoot===a.chunksRoot,'SEAL_ROOT');const value={...V.publicRef(a),allocationHash:a.allocationHash,filesRoot:p.filesRoot,chunksRoot:p.chunksRoot,packBytes:a.packBytes,fileCount:a.fileCount,chunkCount:a.chunkCount,sealVersion:1,sealed:true};sealReceipt={...value,sha256:await V.hash(V.canonical(value))};}
 await pause('slot:seal:before-commit',this);return this.tx(()=>{s=this.validRef(c);V.check(s.phase==='SEALING'&&s.controlVersion===c.controlVersion&&V.canonical(s.progress)===before,'STALE_CONTROL');s.progress=p;if(done){s.phase='SEALED';s.sealReceipt=sealReceipt;}this.save(s);const r=this.receipt(c,s,{done,sealReceipt});if(done)this.remember(c,r);return r;});}
 read(ref,path,head=false){const s=this.validRef(ref);V.check(s.phase==='SEALED','READ_RETIRED');V.path(path);const f=this.q('SELECT path,offset,bytes,sha256 FROM files WHERE path=?',path)[0];V.check(f,'NOT_FOUND');
 const headers={'Content-Length':String(f.bytes),'Content-Type':path.endsWith('.jpg')?'image/jpeg':'application/octet-stream','ETag':'"'+f.sha256+'"','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'*'};if(head)return new Response(null,{headers});V.check(this.pins<V.LIMITS.streams&&isolatePins<V.LIMITS.streams*4,'STREAM_LIMIT');this.pins++;isolatePins++;isolateMaxPins=Math.max(isolateMaxPins,isolatePins);this.maxPins=Math.max(this.maxPins,this.pins);let pos=0,closed=false;const started=now();const release=()=>{if(!closed){closed=true;this.pins--;isolatePins--;clearTimeout(timer);}};let controller;const timer=setTimeout(()=>{if(!closed){controller?.error(Error('STREAM_DEADLINE'));release();}},V.LIMITS.streamMs);
 const stream=new ReadableStream({start(c){controller=c;},pull:async c=>{try{await pause('slot:read:before-pull',this);if(now()-started>=V.LIMITS.streamMs)throw Error('STREAM_DEADLINE');const current=this.validRef(ref);V.check(['SEALED','RETIRING'].includes(current.phase),'READ_RETIRED');if(pos===f.bytes){c.close();release();return;}const at=f.offset+pos,row=this.q('SELECT data FROM chunks WHERE ordinal=?',Math.floor(at/V.LIMITS.blockBytes))[0];V.check(row,'INCOMPLETE_PACK');const raw=new Uint8Array(row.data),start=at%V.LIMITS.blockBytes,n=Math.min(raw.length-start,f.bytes-pos);V.check(n>0,'INCOMPLETE_PACK');pos+=n;c.enqueue(raw.slice(start,start+n));}catch(e){c.error(e);release();}},cancel:()=>{this.cancelled++;release();}} ,{highWaterMark:0});return new Response(stream,{headers});}
 async execute(action,body,bytes){if(action==='put')return this.put(body,bytes);
 if(['page','manifest'].includes(action)){V.keys(body,action==='page'?['ref','page']:['ref']);V.ref(body.ref);const s=this.validRef(body.ref);V.check(['WRITING','FROZEN','SEALING','SEALED'].includes(s.phase),'READ_RETIRED');if(action==='manifest')return {allocation:s.allocation,sealReceipt:s.sealReceipt||null};V.check(V.integer(body.page,0,Math.ceil(s.allocation.fileCount/64)-1));const page=this.q('SELECT canonicalBytes FROM file_pages WHERE page=?',body.page)[0];V.check(page,'NOT_FOUND');return JSON.parse(page.canonicalBytes);}
if(action==='read')return this.read(body.ref,body.path,body.head);if(action==='chunk'){V.keys(body,['ref','ordinal']);V.ref(body.ref);const s=this.validRef(body.ref);V.check(['WRITING','FROZEN','SEALING','SEALED'].includes(s.phase),'READ_RETIRED');V.check(V.integer(body.ordinal,0,s.allocation.chunkCount-1));const c=this.q('SELECT data FROM chunks WHERE ordinal=?',body.ordinal)[0];V.check(c,'NOT_FOUND');return new Response(c.data);}
 if(action==='metrics'){const phase=this.state().phase;return {...this.m.snapshot(),pins:this.pins,maxPins:this.maxPins,cancelled:this.cancelled,isolatePins,isolateMaxPins,phase};}return this.control(body);}
 async fetch(request){try{const action=new URL(request.url).pathname.slice(1);let body,bytes;if(action==='put'){body=JSON.parse(request.headers.get('X-Internal-Permit'));bytes=body.action==='page'?await request.json():new Uint8Array(await request.arrayBuffer());}else body=await request.json();const result=await this.execute(action,body,bytes);return result instanceof Response?result:Response.json(result);}catch(e){return Response.json({error:e.message},{status:409});}}
 };
}
export const WillRelease=createWillReleaseClass();
