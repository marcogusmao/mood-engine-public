// Local acceptance entry only. Production index.js never imports this module.
import { createUploadApi } from '../../src/upload/api.js';
import { createOidcVerifier, JWKS_URL } from '../../src/upload/oidc.js';
import { createWillStateClass } from '../../src/upload/state.js';
let jwks; // S7c: the public half of the key pair runtime.mjs generated for this run, handed over as the WILL_LOCAL_JWKS var; nothing is versioned
const receipts=new Map();let offset=0;
const now=()=>Date.now()+offset;
const offlineFetch=async url=>{
 if(url===JWKS_URL){if(!jwks)throw new Error('the local JWKS was not provided');return Response.json(jwks);}
 if(receipts.has(url))return new Response(receipts.get(url));
 throw new Error('external network disabled in local acceptance');
};
const Base=createWillStateClass({now,fetchImpl:offlineFetch});
export class WillState extends Base {
 async fetch(req) {
  const path=new URL(req.url).pathname;
  if(path==='/fixture/receipts'){for(const [url,body] of Object.entries(await req.json()))receipts.set(url,body);return Response.json({ok:true});}
  if(path==='/fixture/clock'){offset=(await req.json()).offset;return Response.json({ok:true});}
  return super.fetch(req);
 }
}
const api=createUploadApi({verifyOidc:createOidcVerifier({now,fetchImpl:offlineFetch})}); // production's 60 s pointer copy: an accepted ack/reconcile drops it, and upload-local.mjs is the test that turns red without that (final review, 20/10/2026)
export default {async fetch(req,env,ctx){
 if(!jwks&&env.WILL_LOCAL_JWKS)jwks=JSON.parse(env.WILL_LOCAL_JWKS);
 const path=new URL(req.url).pathname;
 if(path==='/fixture/receipts'&&req.method==='POST')return env.WILL_STATE.get(env.WILL_STATE.idFromName('friend-a-v1')).fetch(new Request('https://state/fixture/receipts',{method:'POST',body:await req.text()}));
 if(path==='/fixture/clock'&&req.method==='POST'){const text=await req.text();offset=JSON.parse(text).offset;return env.WILL_STATE.get(env.WILL_STATE.idFromName('friend-a-v1')).fetch(new Request('https://state/fixture/clock',{method:'POST',body:text}));}
 if(path==='/fixture/health')return Response.json({ok:true,offline:true});
 return (await api(req,env,ctx))||new Response('missing',{status:404});
}};
