import { ApiError, CONTRACT, LIMITS, PERSON, canonical, digest, identity, nextScheduled, reject, strictJson, validate, boundedBytes, UUID, REVISION } from './protocol.js';
const DAY = 86400000;
const terminal = new Set(['ready','failed','cancelled','expired']);
export function assertLease(r, actor, epoch, now) {
  if (!r || r.state !== 'processing' || r.leaseEpoch !== epoch || r.runId !== actor.runId || r.runAttempt !== actor.runAttempt || r.leaseExpires <= now) reject(409, 'STALE_LEASE');
}
export function assertOwner(body) { if (body.personId !== PERSON) reject(400, 'WRONG_OWNER'); }
export function publicProjection(p) {
  return p ? { revision:p.revision, publishedAt:p.publishedAt, pagePath:'/mood-engine/u/friend-a/', releasePath:`/mood-engine/u/friend-a/r/${p.revision}/`, addonPath:CONTRACT.addonPath } : null;
}
export function publicationDescriptor(p) {
  return { revision:p.revision,generation:p.generation,codeSha:p.codeSha,runId:p.runId,runAttempt:p.runAttempt,receiptSha256:p.receiptSha256,fileManifestSha256:p.fileManifestSha256,personContextSha256:p.personContextSha256,releasePath:`/mood-engine/u/friend-a/r/${p.revision}/` };
}
// The admin supplies a read-only Actions token; it is forwarded only to this fixed URL,
// never persisted in operation metadata. The exact original attempt must be completed.
export async function verifyTerminalRun({runId,runAttempt,codeSha,token,fetchImpl=fetch}) {
 if(!/^[0-9]+$/.test(runId)||! /^[0-9]+$/.test(runAttempt)||typeof token!=='string'||!token||token.length>4096)reject(403,'TERMINAL_RUN_REQUIRED');
 const res=await fetchImpl(`https://api.github.com/repos/marcogusmao/mood-engine/actions/runs/${runId}/attempts/${runAttempt}`,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'mood-engine-will-admin','X-GitHub-Api-Version':'2022-11-28'}});
 if(!res.ok)reject(409,'TERMINAL_RUN_UNVERIFIED');
 const d=strictJson(new TextDecoder().decode(await boundedBytes(res,65536,{allowEncoding:true})));
 if(String(d.id)!==runId||String(d.run_attempt)!==runAttempt||d.status!=='completed'||!d.conclusion||d.head_sha!==codeSha||d.repository?.full_name!=='marcogusmao/mood-engine'||d.path!=='.github/workflows/mood-engine.yml')reject(409,'RUN_NOT_TERMINAL');
 return true;
}
export function createWillStateClass({ now = Date.now, uuid = () => crypto.randomUUID(), fetchImpl = (...a) => fetch(...a) } = {}) {
return class WillState {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    // Deterministic, idempotent migration. No memory fallback on a SQL failure.
    this.sql.exec('PRAGMA foreign_keys = ON');
    for (const name of ['owner','invitations','credentials','requests','blobs','publications','budgets'])
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, person_id TEXT NOT NULL CHECK(person_id='friend-a'), doc TEXT NOT NULL)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS chunks (blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(blob_id,ordinal))');
    this.sql.exec("INSERT OR IGNORE INTO owner(id,person_id,doc) VALUES('friend-a','friend-a',?)", canonical({personId:PERSON,authEpoch:0,generation:0,activeSnapshotId:null,previousSnapshotId:null,activeRevision:null,previousRevision:null,pending:null,lastRequest:null,lastRefreshDay:null}));
  }
  row(table,id) { const row = this.sql.exec(`SELECT doc FROM ${table} WHERE id=?`,id).toArray()[0]; return row ? strictJson(row.doc) : null; }
  all(table) { return this.sql.exec(`SELECT doc FROM ${table}`).toArray().map(r => strictJson(r.doc)); }
  put(table,id,v) { this.sql.exec(`INSERT INTO ${table}(id,person_id,doc) VALUES(?,'friend-a',?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc`, id,canonical(v)); return v; }
  del(table,id) { this.sql.exec(`DELETE FROM ${table} WHERE id=?`,id); }
  owner() { return this.row('owner',PERSON); }
  saveOwner(o) { this.put('owner',PERSON,o); }
  active(o=this.owner()) { return o.activeRevision ? publicProjection(this.row('publications',o.activeRevision)) : null; }
  statusRequest(r) { return r ? {requestId:r.requestId,generation:r.generation,state:r.state,acceptedAt:r.acceptedAt,nextScheduledAt:r.nextScheduledAt,error:r.error || null} : null; }
  authorize(actor,o=this.owner()) {
    if (actor.role !== 'credential') return;
    const c = this.row('credentials',actor.hash);
    if (!c) reject(401,'CREDENTIAL_INVALID');
    if (c.personId !== PERSON || c.authEpoch !== o.authEpoch || c.revokedAt || c.expires <= now()) reject(403,'CREDENTIAL_EXPIRED');
  }
  budget(key,amount,max) {
    const b = this.row('budgets',key) || { key, personId:PERSON, amount:0,at:now() };
    if (b.amount + amount > max) reject(429,'BUDGET_EXCEEDED',true);
    b.amount += amount; this.put('budgets',key,b);
  }
  reserve(bytes) { const total = this.all('blobs').reduce((n,b)=>n+b.bytes,0); if (total+bytes > LIMITS.storageBytes) reject(503,'STORAGE_LIMIT',true); }
  newBlob(kind,requestId,manifest,leaseEpoch=null) {
    this.reserve(manifest.bytes);
    if(kind==='snapshot') {
      const r=this.request(requestId),o=this.owner(),ids=this.all('blobs').filter(b=>b.kind==='snapshot');
      // A prior sealed candidate remains the source after abandonment, retryable failure
      // or lease expiry. Only this request's older lease may need a fourth slot.
      const source=this.row('blobs',r.sourceBlobId);
      const transit=source?.kind==='snapshot' && source.sealedAt && source.requestId===requestId && source.leaseEpoch<leaseEpoch && o.activeSnapshotId && o.previousSnapshotId && ![o.activeSnapshotId,o.previousSnapshotId].includes(source.blobId);
      if(ids.length>=(transit?4:3)) reject(503,'SNAPSHOT_SLOTS',true);
    } const id=uuid();
    const metadata={bytes:manifest.bytes,chunks:manifest.chunks.map(({ordinal,bytes,sha256})=>({ordinal,bytes,sha256})),...(kind==='archive'?{archiveSha256:manifest.archiveSha256}:{contentSha256:manifest.contentSha256})};
    this.put('blobs',id,{...metadata,blobId:id,personId:PERSON,kind,requestId,leaseEpoch,createdAt:now(),sealedAt:null}); return id;
  }
  chunkRows(id) { return this.sql.exec('SELECT ordinal,bytes,sha256 FROM chunks WHERE blob_id=? ORDER BY ordinal',id).toArray(); }
  completeBlob(b) {
    const rows=this.chunkRows(b.blobId);
    if (rows.length!==b.chunks.length || rows.some((r,i)=>r.ordinal!==i || r.bytes!==b.chunks[i].bytes || r.sha256!==b.chunks[i].sha256)) reject(409,'CHUNK_GAPS');
  }
  request(id) { const r=this.row('requests',id); if (!r || r.personId!==PERSON) reject(404,'REQUEST_UNKNOWN'); return r; }
  lease(r,actor,epoch) { assertLease(r,actor,epoch,now()); }
  claimedBlob(id,actor,epoch,requestId) {
    const b=this.row('blobs',id); if (!b || b.personId!==PERSON) reject(404,'BLOB_UNKNOWN');
    const r=this.request(requestId); this.lease(r,actor,epoch);
    const o=this.owner();
    if (![r.archiveId,r.snapshotId,r.sourceBlobId,o.activeSnapshotId,o.previousSnapshotId].includes(id)) reject(403,'BLOB_FORBIDDEN');
    return { b,r };
  }
  leaseResult(r,o) {
    const active=o.activeSnapshotId ? this.row('blobs',o.activeSnapshotId) : null;
    return identity({requestId:r.requestId,generation:r.generation,kind:r.kind,revision:r.revision,leaseEpoch:r.leaseEpoch,runId:r.runId,runAttempt:r.runAttempt,leaseExpiresAt:new Date(r.leaseExpires).toISOString(),sourceBlobId:r.sourceBlobId || ((r.snapshotId && this.row('blobs',r.snapshotId)?.sealedAt) ? r.snapshotId : r.archiveId || o.activeSnapshotId),publications:[o.activeRevision,o.previousRevision].filter(Boolean).map(id=>publicationDescriptor(this.row('publications',id))),activeSnapshot:active ? this.blobManifest(active) : null});
  }
  blobManifest(b) { return identity({blobId:b.blobId,kind:b.kind,bytes:b.bytes,chunks:b.chunks,contentSha256:b.contentSha256 || b.archiveSha256,sealed:!!b.sealedAt}); }
  finish(r,o,state,error=null) { r.state=state; r.error=error; r.finishedAt=now(); this.put('requests',r.requestId,r); if (o.pending===r.requestId) o.pending=null; this.saveOwner(o); }
  cleanup() {
    const o=this.owner(), t=now();
    for (const r of this.all('requests')) {
      if (r.state==='uploading' && t-r.createdAt>=DAY) this.finish(r,o,'expired',{code:'UPLOAD_EXPIRED',retryable:false});
      else if (r.state==='queued' && r.archiveId && !r.snapshotId && t-r.createdAt>=7*DAY) this.finish(r,o,'failed',{code:'ARCHIVE_EXPIRED',retryable:false});
    }
    const protectedIds=new Set([o.activeSnapshotId,o.previousSnapshotId,...this.all('requests').filter(r=>!terminal.has(r.state)).map(r=>r.sourceBlobId)]);
    for (const b of this.all('blobs')) {
      const r=this.row('requests',b.requestId);
      if (b.kind==='snapshot' && r && !terminal.has(r.state)) protectedIds.add(b.blobId);
      if (protectedIds.has(b.blobId)) continue;
      if ((b.kind==='archive' && (t-b.createdAt>=7*DAY || !r || terminal.has(r.state) || (r.snapshotId && this.row('blobs',r.snapshotId)?.sealedAt))) || (b.kind==='snapshot' && (!r || terminal.has(r.state) || t-b.createdAt>=7*DAY))) this.del('blobs',b.blobId);
    }
    const ended=this.all('requests').filter(r=>terminal.has(r.state)).sort((a,b)=>b.finishedAt-a.finishedAt);
    for (let i=0;i<ended.length;i++) if (i>=20 || t-ended[i].finishedAt>30*DAY) this.del('requests',ended[i].requestId);
    for (const b of this.all('budgets')) if (t-b.at>2*DAY) this.del('budgets',b.key);
    for (const c of this.all('credentials')) if (c.expires<t && t-c.expires>DAY) this.del('credentials',c.hash);
    for (const inv of this.all('invitations')) if (t-inv.expires>30*DAY) this.del('invitations',inv.inviteId);
    const keep=new Set([o.activeRevision,o.previousRevision,...this.all('requests').filter(r=>!terminal.has(r.state)).map(r=>r.revision)]);
    for (const p of this.all('publications')) if (!keep.has(p.revision) && t-(p.acknowledgedAt||p.preparedAt)>30*DAY) this.del('publications',p.revision);
  }
  async alarm() { this.ctx.storage.transactionSync(()=>this.cleanup()); await this.ctx.storage.setAlarm(now()+DAY); }
  execute(name,p,body,actor,chunk) {
    const o=this.owner(); this.authorize(actor,o); if(body) assertOwner(body);
    const today=new Date(now()).toISOString().slice(0,10);
    if (name==='publication') return [200,identity({state:o.activeRevision?'ready':'not_ready',activePublication:this.active(o)})];
    if (name==='invitations') {
      const existing=this.row('invitations',body.inviteId);
      if(existing) { if(existing.tokenHash!==body.tokenHash || existing.expires!==Date.parse(body.expiresAt)) reject(409,'IMMUTABLE_CONFLICT'); return [200,identity({authEpoch:existing.authEpoch})]; }
      if (o.authEpoch!==body.expectedAuthEpoch) reject(409,'AUTH_EPOCH');
      const expires=Date.parse(body.expiresAt); if(expires<=now() || expires>now()+7*DAY) reject(400,'INVITE_EXPIRY');
      o.authEpoch++; this.saveOwner(o);
      for(const i of this.all('invitations')) { i.revokedAt=now(); this.put('invitations',i.inviteId,i); }
      for(const c of this.all('credentials')) { c.revokedAt=now(); this.put('credentials',c.hash,c); }
      this.put('invitations',body.inviteId,{inviteId:body.inviteId,personId:PERSON,tokenHash:body.tokenHash,expires,authEpoch:o.authEpoch,consumedAt:null,credentialHash:null,revokedAt:null});
      return [201,identity({authEpoch:o.authEpoch})];
    }
    if(name==='revoke') {
      if(o.authEpoch!==body.expectedAuthEpoch) reject(409,'AUTH_EPOCH'); o.authEpoch++; this.saveOwner(o); return [200,identity({authEpoch:o.authEpoch})];
    }
    if(name==='session') {
      const inv=this.row('invitations',body.inviteId);
      if(!inv || inv.tokenHash!==actor.hash) reject(401,'INVITE_INVALID');
      if(inv.authEpoch!==o.authEpoch || inv.revokedAt || inv.expires<=now()) reject(403,'INVITE_EXPIRED');
      if(inv.consumedAt!==null) {
        if(inv.credentialHash!==actor.credentialHash) reject(409,'INVITE_USED');
        const c=this.row('credentials',inv.credentialHash); if(!c || c.expires<=now()) reject(403,'CREDENTIAL_EXPIRED');
        return [200,identity({expiresAt:new Date(c.expires).toISOString()})];
      }
      inv.consumedAt=now(); inv.credentialHash=actor.credentialHash; this.put('invitations',inv.inviteId,inv);
      const c={hash:actor.credentialHash,personId:PERSON,authEpoch:o.authEpoch,expires:now()+30*DAY,revokedAt:null}; this.put('credentials',c.hash,c);
      return [201,identity({expiresAt:new Date(c.expires).toISOString()})];
    }
    if(name==='status') {
      this.budget(`status:${o.authEpoch}:${Math.floor(now()/3600000)}`,1,LIMITS.statusReadsPerHour);
      const r=o.pending?this.request(o.pending):o.lastRequest?this.row('requests',o.lastRequest):null;
      return [200,identity({state:r?.state || (o.activeRevision?'ready':'not_ready'),request:this.statusRequest(r),activePublication:this.active(o),pollAfterSeconds:60})];
    }
    if(name==='uploads') {
      const old=this.row('requests',body.requestId);
      if(old) { if(old.intake!==canonical(body)) reject(409,'IMMUTABLE_CONFLICT'); return [200,this.allocation(old)]; }
      if(o.pending) reject(409,'REQUEST_BUSY');
      this.budget(`uploads:${today}`,1,LIMITS.maxUploadsPerDay); this.budget(`bytes:${today}`,body.bytes,LIMITS.archiveBytesPerDay);
      const archiveId=this.newBlob('archive',body.requestId,body);
      const r={personId:PERSON,requestId:body.requestId,generation:++o.generation,kind:body.kind,intake:canonical(body),archiveId,snapshotId:null,state:'uploading',createdAt:now(),acceptedAt:null,nextScheduledAt:null,attempts:0,leaseEpoch:0,error:null};
      o.pending=r.requestId; o.lastRequest=r.requestId; this.put('requests',r.requestId,r); this.saveOwner(o); return [201,this.allocation(r)];
    }
    if(name==='uploadStatus') {
      this.budget(`status:${o.authEpoch}:${Math.floor(now()/3600000)}`,1,LIMITS.statusReadsPerHour);
      const r=this.request(p.requestId); return [200,identity({...this.statusRequest(r),received:r.archiveId?this.chunkRows(r.archiveId).map(c=>c.ordinal):[],activePublication:this.active(o),pollAfterSeconds:60})];
    }
    if(name==='uploadChunk' || name==='snapshotChunk') {
      let b,r;
      if(name==='uploadChunk') { r=this.request(p.requestId); if(r.state!=='uploading') reject(409,'INVALID_TRANSITION'); b=this.row('blobs',r.archiveId);  }
      else { ({b,r}=this.claimedBlob(p.blobId,actor,p.leaseEpoch,p.requestId)); if(b.kind!=='snapshot' || b.leaseEpoch!==r.leaseEpoch || b.blobId!==r.snapshotId) reject(409,'STALE_LEASE'); }
      if(!b || b.sealedAt) reject(409,'BLOB_SEALED');
      const expected=b.chunks[p.ordinal];
      if(!expected || expected.bytes!==chunk.bytes.byteLength || expected.sha256!==chunk.hash) reject(409,'CHUNK_MISMATCH');
      const old=this.sql.exec('SELECT sha256,bytes FROM chunks WHERE blob_id=? AND ordinal=?',b.blobId,p.ordinal).toArray()[0];
      if(old) { if(old.sha256!==chunk.hash || old.bytes!==chunk.bytes.byteLength) reject(409,'IMMUTABLE_CONFLICT'); return [204,null]; }
      this.sql.exec('INSERT INTO chunks(blob_id,ordinal,bytes,sha256,data) VALUES(?,?,?,?,?)',b.blobId,p.ordinal,chunk.bytes.byteLength,chunk.hash,chunk.bytes); return [204,null];
    }
    if(name==='complete' || name==='cancel') {
      const r=this.request(p.requestId);
      if(name==='cancel') { if(r.state==='cancelled') return [200,identity(this.statusRequest(r))]; if(!['uploading','queued'].includes(r.state)) reject(409,'INVALID_TRANSITION'); this.finish(r,o,'cancelled'); return [200,identity(this.statusRequest(r))]; }
      if(['queued','processing','publishing','ready'].includes(r.state)) return [202,identity({...this.statusRequest(r),activePublication:this.active(o),pollAfterSeconds:60})];
      if(r.state!=='uploading') reject(409,'INVALID_TRANSITION');
      const b=this.row('blobs',r.archiveId); this.completeBlob(b); b.sealedAt=now(); this.put('blobs',b.blobId,b);
      r.state='queued'; r.acceptedAt=new Date(now()).toISOString(); r.nextScheduledAt=nextScheduled(now()); this.put('requests',r.requestId,r); return [202,identity({...this.statusRequest(r),activePublication:this.active(o),pollAfterSeconds:60})];
    }
    if(name==='claim') {
      if(o.pending) {
        const r=this.request(o.pending);
        if(r.state==='publishing' || r.state==='uploading' || (r.nextEligible||0)>now()) return [204,null];
        if(r.state==='processing' && r.leaseExpires>now()) { if(r.runId===actor.runId && r.runAttempt===actor.runAttempt) return [200,this.leaseResult(r,o)]; return [204,null]; }
        if(!['queued','processing'].includes(r.state)) reject(409,'INVALID_TRANSITION');
        return this.issueLease(r,o,actor);
      }
      if(!o.activeSnapshotId || o.lastRefreshDay===today) return [204,null];
      const id=uuid(),r={personId:PERSON,requestId:id,generation:++o.generation,kind:'public-refresh',archiveId:null,snapshotId:null,state:'queued',createdAt:now(),acceptedAt:new Date(now()).toISOString(),nextScheduledAt:nextScheduled(now()),attempts:0,leaseEpoch:0,error:null};
      o.lastRefreshDay=today;o.pending=id;o.lastRequest=id; return this.issueLease(r,o,actor);
    }
    if(name==='blobManifest' || name==='blobChunk') {
      const {b}=this.claimedBlob(p.blobId,actor,p.leaseEpoch,p.requestId);
      if(name==='blobManifest') return [200,this.blobManifest(b)];
      const c=this.sql.exec('SELECT bytes,sha256,data FROM chunks WHERE blob_id=? AND ordinal=?',p.blobId,p.ordinal).toArray()[0]; if(!c) reject(404,'CHUNK_UNKNOWN'); return [200,c.data,{'content-type':'application/octet-stream','X-Chunk-SHA256':c.sha256,'Content-Length':String(c.bytes)}];
    }
    if(name==='retained') return [200,identity({publications:[o.activeRevision,o.previousRevision].filter(Boolean).map(id=>publicationDescriptor(this.row('publications',id)))})];
    if(name==='replay') return [200,identity({publications:this.all('publications').filter(p=>p.state==='prepared').map(p=>({...publicationDescriptor(p),requestId:p.requestId,snapshotId:p.snapshotId,leaseEpoch:p.leaseEpoch}))})];
    if(name==='replayManifest'||name==='replayChunk') {
      const pub=this.row('publications',p.revision),r=pub&&this.row('requests',pub.requestId),b=this.row('blobs',p.blobId);
      if(actor.role!=='build'||!pub||pub.personId!==PERSON||pub.state!=='prepared'||o.pending!==pub.requestId||r?.state!=='publishing'||r.revision!==p.revision||r.snapshotId!==p.blobId||pub.snapshotId!==p.blobId||!b?.sealedAt||b.requestId!==r.requestId)reject(403,'REPLAY_FORBIDDEN');
      if(name==='replayManifest')return [200,this.blobManifest(b)];
      const c=this.sql.exec('SELECT bytes,sha256,data FROM chunks WHERE blob_id=? AND ordinal=?',p.blobId,p.ordinal).toArray()[0];if(!c)reject(404,'CHUNK_UNKNOWN');
      return [200,c.data,{'content-type':'application/octet-stream','X-Chunk-SHA256':c.sha256,'Content-Length':String(c.bytes)}];
    }
    if(name==='prepared') return [200,identity({publications:this.all('publications').filter(p=>p.state==='prepared').map(publicationDescriptor)})];
    if(name==='snapshots' || name==='heartbeat' || name==='seal' || name==='prepare' || name==='fail') {
      const r=this.request(body.requestId); if(p.requestId && p.requestId!==body.requestId) reject(400,'REQUEST_MISMATCH');
      if(name==='prepare' && r.state==='publishing') {
        const old=this.row('publications',r.revision);
        if(old && old.runId===actor.runId && old.runAttempt===actor.runAttempt && Object.keys(body).every(k=>canonical(body[k])===canonical(old[k]))) return [200,identity(publicationDescriptor(old))];
        reject(409,'IMMUTABLE_CONFLICT');
      }
      this.lease(r,actor,body.leaseEpoch);
      if(name==='heartbeat') { r.leaseExpires=now()+LIMITS.leaseSeconds*1000; this.put('requests',r.requestId,r); return [200,this.leaseResult(r,o)]; }
      if(name==='snapshots') {
        const manifest={bytes:body.bytes,chunks:body.chunks,contentSha256:body.contentSha256};
        if(r.snapshotId) { const old=this.row('blobs',r.snapshotId); if(old && (old.leaseEpoch===r.leaseEpoch || old.sealedAt)) { if(canonical(manifest)!==canonical({bytes:old.bytes,chunks:old.chunks,contentSha256:old.contentSha256})) reject(409,'IMMUTABLE_CONFLICT'); return [200,identity({snapshotId:old.blobId})]; } }
        r.snapshotId=this.newBlob('snapshot',r.requestId,manifest,r.leaseEpoch); this.put('requests',r.requestId,r); return [201,identity({snapshotId:r.snapshotId})];
      }
      if(name==='seal') {
        const b=this.row('blobs',p.blobId); if(!b || b.blobId!==r.snapshotId || (!b.sealedAt && b.leaseEpoch!==r.leaseEpoch)) reject(409,'STALE_LEASE'); this.completeBlob(b);
        if(b.sealedAt && canonical(b.coverage)!==canonical(body.coverage)) reject(409,'IMMUTABLE_CONFLICT');
        b.sealedAt=b.sealedAt||now(); b.parserVersion=body.parserVersion;b.coverage=body.coverage;this.put('blobs',b.blobId,b);
        if(r.archiveId) { this.del('blobs',r.archiveId);r.archiveId=null; }
        if(r.sourceBlobId && ![o.activeSnapshotId,o.previousSnapshotId,b.blobId].includes(r.sourceBlobId))this.del('blobs',r.sourceBlobId);
        r.sourceBlobId=b.blobId;r.abandonedSource=null;this.put('requests',r.requestId,r);
        return [200,identity({snapshotId:b.blobId,sealed:true})];
      }
      if(name==='prepare') {
        const b=this.row('blobs',body.snapshotId);
        if(r.snapshotId!==body.snapshotId || !b?.sealedAt || body.revision!==r.revision || body.codeSha!==actor.codeSha) reject(409,'PREPARE_MISMATCH');
        const pub={personId:PERSON,...body,generation:r.generation,runId:r.runId,runAttempt:r.runAttempt,state:'prepared',preparedAt:now()};
        this.put('publications',r.revision,pub);r.state='publishing';this.put('requests',r.requestId,r);return [200,identity(publicationDescriptor(pub))];
      }
      const retry=body.retryable && !['INVALID_ZIP','WRONG_OWNER','EXPORT_PROFILE_UNSUPPORTED','ARCHIVE_EXPIRED'].includes(body.code) && r.attempts<3;
      if(retry) {r.state='queued';r.nextEligible=now()+(r.attempts===1?15:60)*60000;r.error={code:body.code,retryable:true};this.put('requests',r.requestId,r);}
      else this.finish(r,o,'failed',{code:body.code,retryable:false});
      return [200,identity(this.statusRequest(r))];
    }
    reject(404,'NOT_FOUND');
  }
  allocation(r) {return identity({requestId:r.requestId,generation:r.generation,state:r.state,blobId:r.archiveId,chunkCount:JSON.parse(r.intake).chunks.length});}
  issueLease(r,o,actor) {
    if(r.attempts>=3) {this.finish(r,o,'failed',{code:'BUILD_FAILED',retryable:false});return [204,null];}
    // Preserve a sealed candidate as immutable retry source; new output gets another blob.
    const prior=r.snapshotId && this.row('blobs',r.snapshotId);
    if(prior && !prior.sealedAt) {this.del('blobs',r.snapshotId);r.snapshotId=null;}
    r.sourceBlobId=prior?.sealedAt ? prior.blobId : r.sourceBlobId || r.archiveId || o.activeSnapshotId;
    r.snapshotId=null;
    r.leaseEpoch++;r.attempts++;r.state='processing';r.runId=actor.runId;r.runAttempt=actor.runAttempt;r.codeSha=actor.codeSha;r.leaseExpires=now()+LIMITS.leaseSeconds*1000;r.revision='r-'+uuid().replaceAll('-','');
    this.put('requests',r.requestId,r);this.saveOwner(o);return [200,this.leaseResult(r,o)];
  }
  async receipt(p) {
    const base=this.env.WILL_PAGES_BASE;
    if(base!=='https://marcogusmao.github.io/mood-engine') reject(503,'CONFIG_MISSING',true);
    const read=async(path,max,hash)=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
      try {const res=await fetchImpl(`${base}/u/friend-a/r/${p.revision}/${path}`,{redirect:'error',cache:'no-store',headers:{'Cache-Control':'no-cache'},signal:controller.signal});if(!res.ok) reject(409,'RECEIPT_UNAVAILABLE',true); const bytes=await boundedBytes(res,max,{allowEncoding:true}); if(await digest(bytes)!==hash) reject(409,'RECEIPT_MISMATCH');return strictJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));} finally{clearTimeout(timer);}
    };
    const receipt=await read('publication.json',8192,p.receiptSha256), context=await read('data/person.json',16384,p.personContextSha256);
    if(canonical(Object.keys(receipt).sort())!==canonical(['schemaVersion','personId','revision','codeSha','builtAt','filesSha256','personContextSha256'].sort()) || receipt.schemaVersion!==1 || receipt.personId!==PERSON || receipt.revision!==p.revision || receipt.codeSha!==p.codeSha || receipt.filesSha256!==p.fileManifestSha256 || receipt.personContextSha256!==p.personContextSha256 || context.schemaVersion!==1 || context.personId!==PERSON || context.revision!==p.revision) reject(409,'RECEIPT_MISMATCH');
  }
  async acknowledge(name,revision,body,actor) {
    let p=this.row('publications',revision); if(!p || p.state==='abandoned' || p.receiptSha256!==body.receiptSha256) reject(409,'PUBLICATION_MISMATCH');
    if(p.state==='acknowledged') return [200,identity({activePublication:this.active(),revision})];
    if(name==='ack' && (p.runId!==actor.runId || p.runAttempt!==actor.runAttempt || p.codeSha!==actor.codeSha)) reject(409,'PUBLICATION_RUN');
    await this.receipt(p);
    return this.ctx.storage.transactionSync(()=>{
      const current=this.row('publications',revision),o=this.owner();
      // Another process/request can finish while the independent receipt fetch is awaited.
      if(current?.state==='acknowledged' && current.receiptSha256===body.receiptSha256) return [200,identity({activePublication:this.active(o),revision})];
      const r=this.request(p.requestId);
      if(!current || canonical(current)!==canonical(p) || current.state!=='prepared' || o.pending!==p.requestId || r.state!=='publishing' || r.generation!==p.generation || r.snapshotId!==p.snapshotId || r.leaseEpoch!==p.leaseEpoch || r.revision!==revision || !this.row('blobs',p.snapshotId)?.sealedAt) reject(409,'STALE_PUBLICATION');
      const obsolete=o.previousSnapshotId;
      o.previousSnapshotId=o.activeSnapshotId;o.previousRevision=o.activeRevision;o.activeSnapshotId=p.snapshotId;o.activeRevision=revision;
      if(obsolete && obsolete!==o.activeSnapshotId && obsolete!==o.previousSnapshotId) this.del('blobs',obsolete);
      p.state='acknowledged';p.publishedAt=new Date(now()).toISOString();p.acknowledgedAt=now();this.put('publications',revision,p);this.finish(r,o,'ready');return [200,identity({activePublication:this.active(o),revision})];
    });
  }
  async abandon(revision,body,githubToken) {
    const p=this.row('publications',revision),o=this.owner();
    if(!p || p.state!=='prepared' || p.generation!==body.expectedGeneration || p.runId!==body.terminalRunId || p.runAttempt!==body.terminalRunAttempt || revision===o.activeRevision) reject(409,'STALE_PUBLICATION');
    await verifyTerminalRun({runId:p.runId,runAttempt:p.runAttempt,codeSha:p.codeSha,token:githubToken,fetchImpl});
    const active=o.activeRevision?this.row('publications',o.activeRevision):null;if(active) await this.receipt(active);
    return this.ctx.storage.transactionSync(()=>{
      const current=this.row('publications',revision),owner=this.owner();
      if(canonical(current)!==canonical(p) || owner.activeRevision!==o.activeRevision || owner.pending!==p.requestId) reject(409,'STALE_PUBLICATION');
      const r=this.request(p.requestId);p.state='abandoned';this.put('publications',revision,p);r.state='queued';r.abandonedSource=p.snapshotId;r.nextEligible=now();r.attempts=0;this.put('requests',r.requestId,r);return [200,identity({state:'queued'})];
    });
  }
  async fetch(request) {
    try {
      const packet=strictJson(request.headers.get('X-Mood-Operation')||'null');
      if(!packet || !packet.actor || typeof packet.name!=='string') reject(403,'INTERNAL_ONLY');
      const {name,p={},actor,body}=packet;
      let chunk;
      if(name==='uploadChunk') this.ctx.storage.transactionSync(()=>{this.authorize(actor);this.budget(`chunks:${new Date(now()).toISOString().slice(0,10)}`,1,LIMITS.chunkAttemptsPerDay);});
      if(name==='uploadChunk'||name==='snapshotChunk') { const bytes=await boundedBytes(request,LIMITS.chunkBytes);const hash=await digest(bytes);if(hash!==request.headers.get('X-Chunk-SHA256')) reject(409,'CHUNK_MISMATCH');chunk={bytes,hash}; }
      let result;
      if(name==='ack'||name==='reconcile') result=await this.acknowledge(name,p.revision,body,actor);
      else if(name==='abandon') result=await this.abandon(p.revision,body,request.headers.get('X-GitHub-Read-Token'));
      else result=this.ctx.storage.transactionSync(()=>{if(['uploads','claim'].includes(name))this.cleanup();return this.execute(name,p,body,actor,chunk);});
      if(['uploads','claim','complete'].includes(name)) await this.ctx.storage.setAlarm(now()+DAY);
      const [status,payload,extra]=result;
      const headers=new Headers({'Content-Type':'application/json','Cache-Control':'no-store'});
      for(const [name,value] of Object.entries(extra||{}))headers.set(name,value);
      return new Response(status===204?null:payload instanceof ArrayBuffer || payload instanceof Uint8Array?payload:canonical(payload),{status,headers});
    } catch(e) { const known=e instanceof ApiError;return new Response(canonical(identity({error:{code:known?e.code:'STORAGE_UNAVAILABLE',message:known?'The request could not be completed.':'The private service is unavailable.',retryable:known?e.retryable:true}})),{status:known?e.status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...(e.status===429?{'Retry-After':'3600'}:{})}}); }
  }
};
}
export const WillState = createWillStateClass();
