'use strict';
// Synthetic HTTP transport fixture only. This is not the Worker/SQLite acceptance proof.
const http=require('node:http'),crypto=require('node:crypto');
const ID={schemaVersion:1,personId:'friend-a'};
async function start({http:useHTTP=false}={}){
 const state={credential:null,requests:new Map(),activePublication:null,puts:0,bytes:0,failOrdinal:null},calls=[];
 const handler=async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);calls.push({method:req.method,path:req.url,bytes:bytes.length});
  const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(value?JSON.stringify({...ID,...value}):undefined);};
  let body;try{body=req.headers['content-type']==='application/json'?JSON.parse(bytes):null;}catch{return send(400,{error:{code:'BAD_SCHEMA'}});}
  const path=req.url.replace('/api/v1/friend-a','');
  if(path==='/session'){state.credential=body.credential;return send(201,{expiresAt:'2026-11-14T12:00:00.000Z'});}
  if(path==='/publication')return send(200,{state:state.activePublication?'ready':'not_ready',activePublication:state.activePublication});
  if(req.headers.authorization!=='Bearer '+state.credential)return send(401,{error:{code:'CREDENTIAL_INVALID'}});
  const latest=[...state.requests.values()].at(-1);
  if(path==='/status')return send(200,{state:latest?.state||'not_ready',request:latest?{...latest.intake,chunks:undefined,archiveSha256:undefined,kind:undefined,bytes:undefined,generation:1,state:latest.state}:null,activePublication:state.activePublication,pollAfterSeconds:60});
  if(path==='/uploads'&&req.method==='POST'){
   const existing=state.requests.get(body.requestId);if(existing&&JSON.stringify(existing.intake)!==JSON.stringify(body))return send(409,{error:{code:'IMMUTABLE_CONFLICT'}});
   if(!existing)state.requests.set(body.requestId,{intake:body,state:'uploading',chunks:new Map()});return send(existing?200:201,{requestId:body.requestId,chunks:body.chunks.length});
  }
  const match=path.match(/^\/uploads\/([^/]+)(?:\/(chunks\/([0-9]+)|complete|cancel))?$/);const item=match&&state.requests.get(match[1]);if(!item)return send(404,{error:{code:'NOT_FOUND'}});
  if(!match[2])return send(200,{state:item.state,received:[...item.chunks.keys()]});
  if(match[2]==='complete'){if(item.chunks.size!==item.intake.chunks.length)return send(409,{error:{code:'CHUNK_GAP'}});item.state='queued';return send(202,{requestId:match[1],generation:1,state:'queued',acceptedAt:'2026-10-14T12:00:00.000Z',nextScheduledAt:'2026-10-15T09:10:00.000Z',pollAfterSeconds:60,activePublication:null});}
  if(match[2]==='cancel'){item.state='cancelled';return send(200,{state:'cancelled'});}
  const ordinal=Number(match[3]);if(ordinal===state.failOrdinal)return send(503,{error:{code:'STORAGE_UNAVAILABLE'}});
  const part=item.intake.chunks[ordinal],sha=crypto.createHash('sha256').update(bytes).digest('hex');if(!part||part.bytes!==bytes.length||part.sha256!==sha||req.headers['x-chunk-sha256']!==sha)return send(409,{error:{code:'CHUNK_MISMATCH'}});
  if(item.chunks.has(ordinal)&&!item.chunks.get(ordinal).equals(bytes))return send(409,{error:{code:'CHUNK_CONFLICT'}});
  state.puts++;state.bytes+=bytes.length;item.chunks.set(ordinal,bytes);return send(204);
 };
 if(!useHTTP)return {state,calls,url:null,close:async()=>{},fetch:async(input,options={})=>{
  const {Readable}=require('node:stream');const req=Readable.from(options.body===undefined?[]:[Buffer.from(options.body)]);req.method=options.method||'GET';req.url=new URL(input).pathname;req.headers=Object.fromEntries(Object.entries(options.headers||{}).map(([key,value])=>[key.toLowerCase(),value]));
  let code,headers,body;await handler(req,{writeHead:(c,h)=>{code=c;headers=h;},end:b=>{body=b;}});return new Response(code===204?null:body,{status:code,headers});
 }};
 const server=http.createServer(handler);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const url=`http://127.0.0.1:${server.address().port}`;
 return {state,calls,url,fetch:(input,options)=>fetch(String(input).replace('https://worker.fixture.invalid',url),options),close:()=>new Promise(resolve=>server.close(resolve))};
}
module.exports={start};
