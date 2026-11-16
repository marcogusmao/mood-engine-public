import { ApiError, LIMITS, UUID, REVISION, boundedBytes, canonical, digest, identity, jsonBody, reject } from './protocol.js';
import { createOidcVerifier, OWNER_ID, REPOSITORY_ID } from './oidc.js';
import { headerText } from '../build-header.js';
import { createLimiter, addressKey, bindingAllows, createLayerCounter, rateLimited, BINDING_PERIOD_S, GLOBAL_BINDING_KEY } from './limiter.js';
const BROWSER='/api/v1/friend-a', INTERNAL='/api/internal/v1/friend-a';
export function configured(env) {
  return String(env.WILL_UPLOAD_ENABLED)==='true' && !!env.WILL_STATE && env.WILL_BROWSER_ORIGIN==='https://marcogusmao.github.io' && env.WILL_PAGES_BASE==='https://marcogusmao.github.io/mood-engine' && env.WILL_REPOSITORY_ID===REPOSITORY_ID && env.WILL_REPOSITORY_OWNER_ID===OWNER_ID;
}
export function stateStub(env) { if(!configured(env)) reject(503,'CONFIG_MISSING',true);return env.WILL_STATE.get(env.WILL_STATE.idFromName('friend-a-v1')); }
export async function activePublication(env) {
  const res=await stateStub(env).fetch(new Request('https://state/publication',{headers:{'X-Mood-Operation':canonical({name:'publication',actor:{role:'public'}})}}));
  if(!res.ok) reject(503,'PUBLICATION_UNAVAILABLE',true);
  const data=await res.json(); if(data.personId!=='friend-a') reject(503,'PUBLICATION_UNAVAILABLE',true); return data.activePublication;
}
// The active publication in the memory of the isolate (S1 of the review of 8e37c23, 20/10/2026). Before this every request to Will's addon asked the Durable Object (opening the Board is 54+ of them,
// unauthenticated callers included). Rules, decided and tested in test/will-publication-cache.test.js:
//  - an answer from the Durable Object, a publication or "none yet" (null), is kept for 60 s from the instant it was read; callers that arrive while the read is in flight share it (one read for a burst);
//  - the flag off (`enabled(env)` false, which is `configured(env)` for the real read) never reaches the cache: every request is the same 503 CONFIG_MISSING as before;
//  - a FAILED read is never kept as "no publication". With an earlier publication read less than 10 minutes ago the addon keeps serving that one (the files of a revision are static on Pages, so the
//    answer stays consistent; stale-if-error) and asks again after 5 s; with none it fails (503 in the handler) and asks again after 5 s, so a Durable Object that is down is not hammered by every request;
//  - a failed read is LOGGED (`will-publication-read-failed`, with the code of the error and whether an earlier pointer is being served; no request id, no token, nothing of the caller),
//    because serving the earlier pointer is otherwise silent: with the object down for less than 10 minutes the addon answers 200 from the copy it has;
//  - the price: a new publication reaches an isolate up to 60 s late. Per isolate, best effort; not shared between isolates.
export const PUBLICATION_TTL_MS=60e3, PUBLICATION_STALE_MS=10*60e3, PUBLICATION_RETRY_MS=5e3;
export function createActivePublication({ read=activePublication, now=Date.now, enabled=configured, ttlMs=PUBLICATION_TTL_MS, log=o=>console.warn(JSON.stringify(o)) }={}) {
  let have=null,inflight=null,failedAt=0,failure=null,epoch=0; // have: { value, at } of the last good read; epoch: bumped by invalidate()
  async function publication(env) {
    if(!enabled(env))return read(env); // flag off: throws CONFIG_MISSING, as before; nothing cached
    const t=now();
    if(have&&t-have.at<ttlMs)return have.value;
    if(inflight)return inflight;
    if(failedAt&&t-failedAt<PUBLICATION_RETRY_MS) {
      if(have&&t-have.at<PUBLICATION_STALE_MS)return have.value;
      throw failure;
    }
    const mine=epoch;
    const run=(async()=>{
      try { const value=await read(env); if(mine===epoch){have={value,at:now()}; failedAt=0; failure=null;} return value; }
      catch(e) {
        // An acknowledgement came in while this read was in flight (epoch changed): the failure is logged but says nothing about the new state, so it starts no 5 s wait and nothing is served from the old copy.
        const stale=mine!==epoch;
        if(!stale){failedAt=now(); failure=e;}
        const serving=!stale&&!!have&&failedAt-have.at<PUBLICATION_STALE_MS;
        try { log({event:'will-publication-read-failed',message:serving?'will publication read failed, serving previous pointer':'will publication read failed, no previous pointer to serve',code:e instanceof ApiError?e.code:'READ_ERROR'}); } catch {}
        if(serving)return have.value; throw e;
      }
      finally { if(inflight===run)inflight=null; }
    })();
    inflight=run;
    return run;
  }
  // Called by the intake API when the object accepted an acknowledgement (the active publication just changed, in THIS isolate): the next read asks the object. Other isolates keep their
  // 60 s; scripts/ack-will-publication.js reads /publication and the addon after the acknowledgement and wants the new revision: since 21/10/2026 it waits 60 s (this copy's length, PROPAGATION.settleMs there) and then needs
  // 3 agreeing readings in a row, because of those other isolates (see worker/README.md). Lengthening PUBLICATION_TTL_MS means lengthening that wait; test/will-ack-propagation.test.js compares the two.
  publication.invalidate=()=>{ epoch++; have=null; inflight=null; failedAt=0; failure=null; };
  return publication;
}
const bearer=req=> { const m=/^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.get('Authorization')||'');if(!m) reject(401,'AUTH_REQUIRED');return m[1]; };
function route(method,path,internal) {
  const list=internal ? [
    ['GET',/^\/retained$/,'retained','build'],['GET',/^\/replay$/,'replay','build'],
    ['GET',/^\/replay\/([^/]+)\/blobs\/([^/]+)\/manifest$/,'replayManifest','build',null,['revision','blobId']],['GET',/^\/replay\/([^/]+)\/blobs\/([^/]+)\/chunks\/([^/]+)$/,'replayChunk','build',null,['revision','blobId','ordinal']],
    ['POST',/^\/claim$/,'claim','build','identity'],['POST',/^\/requests\/([^/]+)\/heartbeat$/,'heartbeat','build','heartbeat',['requestId']],
    ['GET',/^\/blobs\/([^/]+)\/manifest$/,'blobManifest','build',null,['blobId']],['GET',/^\/blobs\/([^/]+)\/chunks\/([^/]+)$/,'blobChunk','build',null,['blobId','ordinal']],
    ['POST',/^\/requests\/([^/]+)\/snapshots$/,'snapshots','build','snapshot',['requestId']],['PUT',/^\/snapshots\/([^/]+)\/chunks\/([^/]+)$/,'snapshotChunk','build','chunk',['blobId','ordinal']],
    ['POST',/^\/snapshots\/([^/]+)\/seal$/,'seal','build','seal',['blobId']],['POST',/^\/requests\/([^/]+)\/prepare$/,'prepare','build','prepare',['requestId']],['POST',/^\/requests\/([^/]+)\/fail$/,'fail','build','fail',['requestId']],
    ['GET',/^\/prepared$/,'prepared','deploy'],['POST',/^\/publications\/([^/]+)\/ack$/,'ack','deploy','ack',['revision']],['POST',/^\/publications\/([^/]+)\/reconcile$/,'reconcile','deploy','ack',['revision']],
    ['POST',/^\/invitations$/,'invitations','admin','invitation'],['POST',/^\/revoke$/,'revoke','admin','revoke'],['POST',/^\/publications\/([^/]+)\/abandon$/,'abandon','admin','abandon',['revision']],
  ] : [
    ['POST',/^\/session$/,'session','invitation','session'],['GET',/^\/status$/,'status','credential'],['POST',/^\/uploads$/,'uploads','credential','intake'],
    ['PUT',/^\/uploads\/([^/]+)\/chunks\/([^/]+)$/,'uploadChunk','credential','chunk',['requestId','ordinal']],['GET',/^\/uploads\/([^/]+)$/,'uploadStatus','credential',null,['requestId']],
    ['POST',/^\/uploads\/([^/]+)\/complete$/,'complete','credential','identity',['requestId']],['POST',/^\/uploads\/([^/]+)\/cancel$/,'cancel','credential','identity',['requestId']],['GET',/^\/publication$/,'publication','public'],
  ];
  let pathExists=false;
  for(const [verb,re,name,role,schema,keys=[]] of list) {
    const m=re.exec(path);if(!m)continue;pathExists=true;if(verb!==method)continue;
    const p={}; keys.forEach((k,n)=>{p[k]=m[n+1];if(k==='ordinal'){if(!/^(0|[1-9][0-9]{0,2})$/.test(p[k])||+p[k]>255)reject(400,'INVALID_PATH');p[k]=+p[k];}else if(!(k==='revision'?REVISION:UUID).test(p[k]))reject(400,'INVALID_PATH');});
    return {name,role,schema,p};
  }
  reject(pathExists?405:404,pathExists?'METHOD_NOT_ALLOWED':'NOT_FOUND');
}
export function createUploadApi({ verifyOidc=createOidcVerifier(), now=Date.now, log, publicationTtlMs, publicationCache }={}) {
  const limiter=createLimiter({now}); // S2 (20/10/2026): per isolate, see limiter.js
  const layers=createLayerCounter({now,log:log||(o=>console.warn(JSON.stringify(o)))}); // which layer refused (21/10/2026): the table above ('memory') or the Rate Limiting binding env.WILL_RATE_LIMIT ('binding'); see limiter.js
  const publicationOf=publicationCache||createActivePublication({now,...(log?{log}:{}),...(publicationTtlMs===undefined?{}:{ttlMs:publicationTtlMs})}); // S1b: GET /publication (no token) answers from the same 60 s cache as the addon, not from the object on every call
  const api=async function api(request,env) {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/'))return null;
    let browser=false,allowedOrigin=false,ticket=null,asked=false;
    const build=headerText(env.GIT_SHA); // X-Build (W8, 19/10/2026) also on this API's answers, from the same GIT_SHA; no variable, no header
    const headers=()=>({...(build?{'X-Build':build}:{}),'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Origin',...(allowedOrigin?{'Access-Control-Allow-Origin':env.WILL_BROWSER_ORIGIN,'Access-Control-Expose-Headers':'Retry-After'}:{})});
    try {
      const internal=url.pathname.startsWith(INTERNAL+'/') || url.pathname===INTERNAL;
      browser=url.pathname.startsWith(BROWSER+'/') || url.pathname===BROWSER;
      if(!internal&&!browser)reject(404,'NOT_FOUND');
      if(url.search)reject(400,'INVALID_PATH');
      if(!configured(env))reject(503,'CONFIG_MISSING',true);
      const origin=request.headers.get('Origin');allowedOrigin=browser&&origin===env.WILL_BROWSER_ORIGIN;
      if(browser&&((origin&&!allowedOrigin)||(['POST','PUT','OPTIONS'].includes(request.method)&&!allowedOrigin)))reject(403,'ORIGIN_REJECTED');
      if(request.method==='OPTIONS') {
        if(!browser)reject(405,'METHOD_NOT_ALLOWED');
        const method=request.headers.get('Access-Control-Request-Method');route(method,url.pathname.slice(BROWSER.length),false);
        const h=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
        if(h.some(x=>!['authorization','content-type','x-chunk-sha256'].includes(x)))reject(403,'HEADERS_REJECTED');
        return new Response(null,{status:204,headers:{...headers(),'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, X-Chunk-SHA256','Access-Control-Max-Age':'600'}});
      }
      const r=route(request.method,url.pathname.slice((internal?INTERNAL:BROWSER).length),internal);
      let actor={role:r.role};
      if(internal)actor=await verifyOidc(bearer(request),r.role);
      else if(r.role!=='public') {const presented=bearer(request);if(!/^[A-Za-z0-9_-]{43}$/.test(presented))reject(401,'AUTH_REQUIRED');actor.hash=await digest(presented);const prefix64=addressKey(request.headers.get('cf-connecting-ip'));
        try{ticket=limiter.admit(prefix64,actor.hash);}catch(e){if(e instanceof ApiError&&e.code==='RATE_LIMITED')layers.note('memory');throw e;}
        // Layer shared by the isolates of one location (21/10/2026, Marco: a global limit before the intake is turned on). THE KEY IS THE TOKEN'S sha256 (`actor.hash`), NOT THE ADDRESS (Marco, 28/10/2026; the table above keeps the /64): two addresses with one token share one count, two tokens behind one address have two. Accepted risk, his: a caller that changes token on every request is never limited by the binding; only the table, per /64 and per isolate, holds it. Never the token in clear, never in a log. Asked only where the table charged (a token this isolate has not seen accepted) and only when the Worker has the binding
        // (the node tests and the config that the Worker's local-runtime test rig generates do not have it: the table is then the only layer; `wrangler dev --local` with wrangler.toml gets a simulated one). A refusal is the same 429; the charge the table took is given back by the catch below (the object is never asked). A binding that fails does not stop the request.
        if(ticket.charged&&typeof env.WILL_RATE_LIMIT?.limit==='function') {
          let allowed=true;try{allowed=await bindingAllows(env.WILL_RATE_LIMIT,actor.hash);}catch{layers.note('binding-error');}
          if(!allowed){layers.note('binding');throw rateLimited(BINDING_PERIOD_S);}
        }
        // The ceiling of the WHOLE intake (Marco, 29/10/2026, questionnaire): a second binding, env.WILL_RATE_LIMIT_GLOBAL (60 per 60 s), asked with ONE CONSTANT key (GLOBAL_BINDING_KEY), so every caller shares one count, a caller that changes token on every request included (the case the binding above never sees).
        // Asked for the same requests (`ticket.charged`) and AFTER the per-token one, so that a token the first binding refuses never spends the shared ceiling: only requests that would reach the object count against it. A refusal is the same 429 with Retry-After = its period (BINDING_PERIOD_S, equal in both blocks of wrangler.toml);
        // a binding that is missing or errs fails open (counted as binding-global-error). Accepted risk, his: a persistent attacker keeps the ceiling used up and Will waits a minute at a time. Never a token, an address or a hash in the key.
        if(ticket.charged&&typeof env.WILL_RATE_LIMIT_GLOBAL?.limit==='function') {
          let allowedGlobal=true;try{allowedGlobal=await bindingAllows(env.WILL_RATE_LIMIT_GLOBAL,GLOBAL_BINDING_KEY);}catch{layers.note('binding-global-error');}
          if(!allowedGlobal){layers.note('binding-global');throw rateLimited(BINDING_PERIOD_S);}
        }
      }
      if(r.name==='publication') { // the object's own answer for this operation is {state, activePublication}; same bytes from the cached pointer
        const value=await publicationOf(env);
        return new Response(canonical(identity({state:value?'ready':'not_ready',activePublication:value})),{status:200,headers:headers()});
      }
      // Signature/claims and role are checked before even constructing the DO stub.
      const body=r.schema&&r.schema!=='chunk'?await jsonBody(request,r.schema):null;
      if(r.name==='session')actor.credentialHash=await digest(body.credential);
      if(['blobManifest','blobChunk','snapshotChunk'].includes(r.name)) {
        r.p.requestId=request.headers.get('X-Request-Id');const epoch=request.headers.get('X-Lease-Epoch');
        if(!UUID.test(r.p.requestId||'')||! /^[1-9][0-9]{0,9}$/.test(epoch||''))reject(400,'LEASE_REQUIRED');r.p.leaseEpoch=Number(epoch);
      }
      let bytes;
      if(r.schema==='chunk') {if(request.headers.get('Content-Type')!=='application/octet-stream')reject(415,'CONTENT_TYPE');if(!/^[0-9a-f]{64}$/.test(request.headers.get('X-Chunk-SHA256')||''))reject(400,'INVALID_HASH');bytes=await boundedBytes(request,LIMITS.chunkBytes);}
      // Do not forward caller-controlled operation/auth headers. No raw credential in DO storage or logs.
      const forwarded=new Headers({'X-Mood-Operation':canonical({name:r.name,p:r.p,actor,body})});
      if(r.name==='abandon'){const token=request.headers.get('X-GitHub-Read-Token');if(!token||token.length>4096)reject(403,'TERMINAL_RUN_REQUIRED');forwarded.set('X-GitHub-Read-Token',token);}
      if(bytes)forwarded.set('X-Chunk-SHA256',request.headers.get('X-Chunk-SHA256'));
      const stub=stateStub(env);asked=true;
      const res=await stub.fetch(new Request('https://state/operation',{method:bytes?'PUT':'POST',headers:forwarded,body:bytes}));
      if(ticket) { // tell the limiter whether the object knew the token (a refusal keeps the charge and is remembered for a minute)
        let code=null;if(res.status===401||res.status===403){try{code=(await res.clone().json())?.error?.code??null;}catch{}}
        ticket.done(res.status,code);
        if(r.name==='session'&&res.ok)limiter.forget(actor.credentialHash);
      }
      if(internal&&['ack','reconcile'].includes(r.name)&&res.ok)publicationOf.invalidate(); // the active publication may have just changed: do not answer the next read from the minute-old copy
      const out=new Headers(res.headers);for(const [k,v] of Object.entries(headers()))out.set(k,v);
      if(res.headers.get('content-type')==='application/octet-stream')out.set('Content-Type','application/octet-stream');
      return new Response(res.body,{status:res.status,headers:out});
    } catch(e) {if(ticket&&!asked)ticket.skip(); // refused before the object was asked (bad body, bad lease headers): no cost to it, no charge
      const known=e instanceof ApiError;return new Response(canonical(identity({error:{code:known?e.code:'SERVICE_UNAVAILABLE',message:known&&e.code==='ZIP_TOO_LARGE'?'Choose a Letterboxd ZIP of 8 MiB or less.':'The request could not be completed.',retryable:known?e.retryable:true}})),{status:known?e.status:503,headers:{...headers(),...(e.status===429?{'Retry-After':String(e.retryAfter??3600)}:{})}});}
  };
  api.refusals=layers.counts; // { memory, binding, 'binding-error', 'binding-global', 'binding-global-error' }: how many requests each layer stopped in this isolate (test/will-rate-limit-binding.test.js)
  return api;
}
