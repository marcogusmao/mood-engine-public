#!/usr/bin/env node
'use strict';
// Loopback-only browser rehearsal. Production files contain no transport override.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');
function parse(argv){const args={port:4187,person:'friend-a',offline:false};for(let i=0;i<argv.length;i++){const key=argv[i];if(key==='--offline')args.offline=true;else if(['--port','--person','--api-origin','--public-dir'].includes(key)){if(!argv[i+1])throw Error('Missing '+key);args[key.slice(2)]=argv[++i];}else throw Error('Unknown argument '+key);}args.port=Number(args.port);if(!Number.isInteger(args.port)||args.port<1024||args.port>65535||args.person!=='friend-a'||!args.offline)throw Error('Use --offline --person friend-a --port 4187');if(args['api-origin']){const api=new URL(args['api-origin']);if(api.protocol!=='http:'||!['127.0.0.1','localhost'].includes(api.hostname)||api.pathname!=='/'||api.search||api.hash||api.username||api.password)throw Error('--api-origin must be an explicit HTTP loopback origin');args.api=api.origin;}args.publicDir=args['public-dir']?fs.realpathSync(args['public-dir']):null;return args;}
function create(args){
 const assets={'person.js':'web/person.js','upload.js':'web/upload.js','selector.js':'web/selector.js','feedback.js':'web/feedback.js','feedback-core.js':'lib/learning/feedback.js'};
 const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(url.pathname.startsWith('/api/v1/friend-a/')){
   if(!args.api){res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({schemaVersion:1,personId:'friend-a',error:{code:'SERVICE_UNAVAILABLE',message:'Connect a real local Worker with --api-origin. No demo success is generated.'}}));}
   const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>262144){res.writeHead(413);return res.end();}parts.push(part);}
   const headers={};for(const key of ['authorization','content-type','x-chunk-sha256'])if(req.headers[key])headers[key]=req.headers[key];headers.origin='https://marcogusmao.github.io';
   const answer=await fetch(args.api+url.pathname,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(parts),redirect:'error',signal:AbortSignal.timeout(30000)});
   res.writeHead(answer.status,Object.fromEntries(['content-type','retry-after'].map(key=>[key,answer.headers.get(key)]).filter(([,value])=>value)));return res.end(Buffer.from(await answer.arrayBuffer()));
  }
  const asset=url.pathname.match(/\/assets\/([^/]+)$/);if(asset&&assets[asset[1]]){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(fs.readFileSync(args.publicDir?path.join(args.publicDir,url.pathname.replace(/^\/mood-engine\//,'')):path.join(root,assets[asset[1]])));}
  if(url.pathname==='/'||url.pathname==='/mood-engine/u/friend-a/'||url.pathname==='/u/friend-a/'){
   let html=fs.readFileSync(args.publicDir?path.join(args.publicDir,'u/friend-a/index.html'):path.join(root,'web/index.html'),'utf8').replace('data-owner="mgusmao"','data-owner="friend-a"');
   if(!args.publicDir)html=html.replace(/data-will-api-origin="[^"]*"/g,'data-will-api-origin="https://mood-engine.mood-engine-worker.workers.dev"');
   // Test-only HTTPS-to-loopback bridge, fixed at startup. It cannot be selected by a browser query.
   const bridge=`<script>const rehearsalFetch=window.fetch.bind(window);window.fetch=(input,options)=>{const u=new URL(input,location.href);return rehearsalFetch(u.origin==='https://mood-engine.mood-engine-worker.workers.dev'?u.pathname:input,options);};</script>`;
   html=html.replace('<script src="assets/person.js">',bridge+'<script src="assets/person.js">').replace('<header>','<p role="note">Local synthetic rehearsal — no invitation is issued and no import is simulated. Connect your local Worker and use a synthetic export.</p><header>');
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html);
  }
  if(args.publicDir){const decoded=decodeURIComponent(url.pathname);if(!/^\/mood-engine\/u\/friend-a\/r\/r-[a-f0-9]{32}\/(?:data\/(?:person|engine)\.json|publication\.json|files\.json|posters\/tt[0-9]+\.jpg)$/.test(decoded)){res.writeHead(404);return res.end('Outside rehearsal public projection.');}const target=path.resolve(args.publicDir,'.'+decoded.replace(/^\/mood-engine/,''));if(target.startsWith(args.publicDir+path.sep)&&fs.existsSync(target)&&fs.lstatSync(target).isFile()&&fs.realpathSync(target).startsWith(args.publicDir+path.sep)){res.writeHead(200,{'Content-Type':target.endsWith('.json')?'application/json':'application/octet-stream'});return fs.createReadStream(target).pipe(res);}}
  res.writeHead(404);res.end('No synthetic publication is generated. Supply --public-dir with the reviewed local release.');
 }catch{res.writeHead(502);res.end('Local rehearsal request failed.');}});
 return server;
}
if(require.main===module){try{const args=parse(process.argv.slice(2)),server=create(args);server.once('error',error=>{console.error('Rehearsal failed: '+error.code+' '+error.message);process.exitCode=1;});server.listen(args.port,'127.0.0.1',()=>{console.log(`Local Will shell: http://127.0.0.1:${args.port}/mood-engine/u/friend-a/`);console.log(args.api?'Proxy target: '+args.api:'Backend absent: API returns 503. Add --api-origin http://127.0.0.1:8787 for the real local Worker.');console.log('Optional --public-dir serves the aggregate public tree. Use a synthetic ZIP/invitation from the local Worker only. Ctrl-C stops only this server.');});}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={parse,create};
