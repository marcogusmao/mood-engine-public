// Local synthetic proof only: fixed Pages requests are served by a loopback fixture.
// This module is never imported by the production Worker.
import local, { WillState } from './local-entry.js';
import { createHandler } from '../../src/handler.js';
import { createStore } from '../../src/store.js';
export { WillState };
let handle;
export default {async fetch(request, env, ctx) {
 const result=await local.fetch(request,env,ctx);
 if(result.status!==404 || new URL(request.url).pathname.startsWith('/api/'))return result;
 if(!handle){
  const origin=new URL(env.WILL_TEST_PUBLIC_ORIGIN);
  if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1')throw Error('Loopback fixture required');
  const fetchImpl=(input,options)=>{
   const url=new URL(typeof input==='string'?input:input.url);
   if(url.origin!=='https://marcogusmao.github.io'||!url.pathname.startsWith('/mood-engine/'))throw Error('External network disabled');
   return fetch(origin.origin+url.pathname,options);
  };
  handle=createHandler({store:createStore({fetchImpl}),log:()=>{}});
 }
 return handle(request,env,ctx);
}};
