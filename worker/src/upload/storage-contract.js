// Shared validation for the isolated v2 protocol. No production route imports this module.
export const LIMITS = Object.freeze({packBytes:671088640,files:30002,fileManifestBytes:2097152,fileBytes:8388608,blockBytes:262144,pageRecords:64,pageBytes:32768,pathBytes:512,slotPhysicalBytes:850000000,coordinatorPhysicalBytes:350000000,metadataBytes:8388608,streams:8,streamMs:20000,gcBatch:128});
export const canonical = v => {
  if(v===null || typeof v!=='object') { const s=JSON.stringify(v); if(s===undefined)throw Error('INVALID_DTO');return s; }
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
};
export const utf8 = s=>new TextEncoder().encode(s);
export const hash = async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof v==='string'?utf8(v):v)),b=>b.toString(16).padStart(2,'0')).join('');
export function check(ok, code='INVALID_DTO'){if(!ok)throw Error(code);}
export function keys(v,required,optional=[]){check(v&&typeof v==='object'&&!Array.isArray(v));check(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k)));return v;}
export const integer=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
export const isHash=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
export const comparePath=(a,b)=>{const x=utf8(a),y=utf8(b);for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length;};
export function path(p){check(typeof p==='string'&&utf8(p).length<=LIMITS.pathBytes&&p.length>0&&p===p.normalize('NFC')&&!/[\\%?#\u0000-\u001f\u007f]/.test(p)&&!p.startsWith('/')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'),'INVALID_PATH');check(!/[\ud800-\udfff]/u.test(p),'INVALID_PATH');return p;}
export const refFields=['storageVersion','personId','revision','slot','slotEpoch'];
export function ref(v,closed=true){if(closed)keys(v,refFields);check(v.storageVersion===2&&v.personId==='friend-a'&&/^r-[a-f0-9]{32}$/.test(v.revision)&&integer(v.slot,0,3)&&integer(v.slotEpoch,1),'INVALID_REF');return v;}
export const publicRef=v=>Object.fromEntries(refFields.map(k=>[k,v[k]]));
export const sameRef=(a,b)=>refFields.every(k=>a[k]===b[k]);
export const allocationFields=[...refFields,'requestId','generation','leaseEpoch','runId','runAttempt','codeSha','builtAt','packBytes','fileCount','chunkCount','filesRoot','chunksRoot','receiptSha256','fileManifestSha256','personContextSha256'];
export function allocation(a){keys(a,[...allocationFields,'allocationHash']);ref(a,false);check(typeof a.requestId==='string'&&a.requestId.length<=100&&a.requestId.length>0&&integer(a.generation,1)&&integer(a.leaseEpoch,1)&&/^\d+$/.test(a.runId)&&/^\d+$/.test(a.runAttempt)&&/^[a-f0-9]{40}$/.test(a.codeSha)&&new Date(a.builtAt).toISOString()===a.builtAt);check(integer(a.packBytes,0,LIMITS.packBytes)&&integer(a.fileCount,1,LIMITS.files)&&a.chunkCount===Math.ceil(a.packBytes/LIMITS.blockBytes));for(const k of ['filesRoot','chunksRoot','receiptSha256','fileManifestSha256','personContextSha256','allocationHash'])check(isHash(a[k]));return a;}
export async function validateAllocation(a){allocation(a);const {allocationHash,...body}=a;check(await hash(canonical(body))===allocationHash,'ALLOCATION_HASH');return a;}
export async function rootStart(type){check(['files','chunks'].includes(type));return hash('will-storage-v2:'+type);}
export const rootNext=(prev,page)=>hash(prev+'\n'+canonical(page));
export function fileRecord(f){keys(f,['path','offset','bytes','sha256']);path(f.path);check(integer(f.offset)&&integer(f.bytes,0,f.path==='files.json'?LIMITS.fileManifestBytes:LIMITS.fileBytes)&&isHash(f.sha256));return f;}
export function chunkRecord(c){keys(c,['ordinal','bytes','sha256']);check(integer(c.ordinal,0,2559)&&integer(c.bytes,1,LIMITS.blockBytes)&&isHash(c.sha256));return c;}
export function filePage(p){check(Array.isArray(p)&&p.length>0&&p.length<=64&&utf8(canonical(p)).length<=LIMITS.pageBytes);p.forEach(fileRecord);for(let i=1;i<p.length;i++)check(comparePath(p[i-1].path,p[i].path)<0&&p[i].offset===p[i-1].offset+p[i-1].bytes,'MAP_CONTINUITY');return p;}
export const permitFields=[...refFields,'allocationHash','action','address','leaseEpoch','writerFence','expiresAt'];
export function permit(p){keys(p,permitFields);ref(p,false);check(isHash(p.allocationHash)&&['chunk','page'].includes(p.action)&&integer(p.address,0)&&integer(p.leaseEpoch,1)&&integer(p.writerFence,1)&&integer(p.expiresAt,1));return p;}
export function control(c){keys(c,[...refFields,'operationId','controlVersion','action','args']);ref(c,false);check(typeof c.operationId==='string'&&c.operationId.length>0&&c.operationId.length<=128&&integer(c.controlVersion,1)&&['init','freeze','seal','retire','gc','status'].includes(c.action));const fields={init:['allocation','writerFence'],freeze:['writerFence'],seal:[],retire:['writerFence'],gc:[],status:[]};keys(c.args,fields[c.action]);return c;}
export function pair(p){keys(p,['requestId','generation','leaseEpoch','codeSha','builtAt','snapshotId','contentSha256','publicRef','allocationHash','sealReceiptSha256','receiptSha256','fileManifestSha256','personContextSha256']);ref(p.publicRef);check(typeof p.snapshotId==='string'&&p.snapshotId.length>0&&integer(p.generation,1)&&integer(p.leaseEpoch,1));for(const k of ['contentSha256','allocationHash','sealReceiptSha256','receiptSha256','fileManifestSha256','personContextSha256'])check(isHash(p[k]));return p;}
export async function sealReceipt(r){keys(r,[...refFields,'allocationHash','filesRoot','chunksRoot','packBytes','fileCount','chunkCount','sealVersion','sealed','sha256']);ref(r,false);check(r.sealVersion===1&&r.sealed===true&&integer(r.packBytes,0,LIMITS.packBytes)&&integer(r.fileCount,1,LIMITS.files)&&r.chunkCount===Math.ceil(r.packBytes/LIMITS.blockBytes));for(const k of ['allocationHash','filesRoot','chunksRoot','sha256'])check(isHash(r[k]));const {sha256,...value}=r;check(await hash(canonical(value))===sha256,'SEAL_RECEIPT_HASH');return r;}
