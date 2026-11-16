'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const U=require('../web/upload'),P=require('../web/person');
const {start}=require('../test-support/will-web/http-fixture');
const ID={schemaVersion:1,personId:'friend-a'},at='2026-10-14T12:00:00.000Z',revision='r-'+'1'.repeat(32),nextRevision='r-'+'2'.repeat(32),requestId=crypto.randomUUID();
const active={revision,publishedAt:at,pagePath:'/mood-engine/u/friend-a/',releasePath:`/mood-engine/u/friend-a/r/${revision}/`,addonPath:'/u/friend-a/manifest.json'};
const context={...ID,letterboxdUser:'friend-a',revision,dataBase:'./data/',addonPath:active.addonPath,inputUpdatedAt:at,coverage:{history:'export',likes:'unknown',following:'unavailable'}};
const link={id:crypto.randomUUID(),token:'a'.repeat(43)},origin='https://worker.fixture.invalid';
const response=(value,code=200,headers={})=>new Response(JSON.stringify({...ID,...value}),{status:code,headers:{'Content-Type':'application/json',...headers}});
const memory=()=>{let value=null;return {load:async()=>structuredClone(value),save:async next=>{value=structuredClone(next);}};};
const file=(size=300000)=>{const bytes=Buffer.alloc(size,70);bytes.set([80,75,3,4]);return {name:'synthetic.zip',size,bytes,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};};
function client(extra={}){return U.create({apiOrigin:origin,fetch:async url=>response(url.endsWith('/session')?{expiresAt:'2026-11-14T12:00:00.000Z'}:{state:'not_ready',activePublication:null}),crypto,store:memory(),setTimer:()=>0,clearTimer(){},...extra});}

test('fragment is erased before validation and duplicate/raw capabilities never remain in URL',()=>{
 let cleared;const history={replaceState:(_,__,url)=>cleared=url},location={hash:`#invite=${link.token}&id=${link.id}`,pathname:'/mood-engine/u/friend-a/',search:'?view=1'};
 a.deepEqual(U.takeInvitation(location,history),link);a.equal(cleared,'/mood-engine/u/friend-a/?view=1');
 a.throws(()=>U.takeInvitation({...location,hash:'#invite=private-wrong&id=no'},history),/new invitation/);a(!cleared.includes('private-wrong'));
 a.throws(()=>U.takeInvitation({...location,hash:location.hash+'&invite='+link.token},history));
});
test('configured service requires fixed HTTPS origin and cannot be nominated by query or path',()=>{
 for(const value of ['',undefined,'http://localhost:8787','https://example.org/api','https://user:pass@example.org','https://example.org/?api=evil','https://example.org/#evil'])a.throws(()=>P.origin(value));
 a.equal(P.origin(origin),origin);
});
test('publication and context reject wrong owner, revision, metadata and cross-host paths',async()=>{
 for(const bad of [{...active,revision:'r-wrong'},{...active,addonPath:'/manifest.json'},{...active,releasePath:'https://evil.invalid/'},{...active,pagePath:'/u/marco/'}])a.throws(()=>P.publication({...ID,...bad}));
 for(const bad of [{...context,personId:'marco'},{...context,revision:nextRevision},{...context,dataBase:'../data/'},{...context,letterboxdUser:'mgusmao'}])a.throws(()=>P.context(bad,revision));
 for(const value of [{meta:{personId:'marco',revision}},{meta:{owner:'friend-a',revision}},{meta:{personId:'friend-a',revision:nextRevision}},{}])a.throws(()=>P.engine(value,revision));
 const calls=[];let result;await a.doesNotReject(async()=>{result=await P.load({apiOrigin:origin,location:{href:'https://pages.fixture.invalid/mood-engine/u/friend-a/?api=https://evil.invalid'},fetch:async url=>{calls.push(url);return response(url.endsWith('/publication')?{state:'ready',activePublication:active}:url.endsWith('person.json')?context:{meta:{personId:'friend-a',revision}});}});});
 a.equal(result.manifest,origin+'/u/friend-a/manifest.json');a.equal(calls.length,3);a.equal(calls[1],`https://pages.fixture.invalid/mood-engine/u/friend-a/r/${revision}/data/person.json`);a.equal(calls[2],`https://pages.fixture.invalid/mood-engine/u/friend-a/r/${revision}/data/engine.json`);a(calls.every(url=>!url.includes('evil.invalid')));
});
test('no publication means no engine fetch; wrong person/revision never falls back to Marco',async()=>{
 let calls=0;const fetch=async()=>{calls++;return response({state:'not_ready'});};a.equal(await P.load({apiOrigin:origin,fetch,location:{href:'https://pages.fixture.invalid/'}}),null);a.equal(calls,1);
 await a.rejects(P.load({apiOrigin:origin,publication:active,location:{href:'https://pages.fixture.invalid/'},fetch:async()=>response({...context,personId:'marco'})}));a.equal(calls,1);
});
test('public visitor reads the activePublication envelope without an upload credential',async t=>{
 const server=await start();t.after(server.close);server.state.activePublication=active;
 const c=client({fetch:server.fetch});t.after(()=>c.stop());await a.doesNotReject(()=>c.start());
 a.equal(c.snapshot.session,false);a.equal(c.snapshot.status.state,'ready');
 a.deepEqual(c.snapshot.status.activePublication,P.active(active));
 for(const value of [{...ID,state:'ready'}, {...ID,state:'ready',activePublication:{...active,personId:'marco'}}, {...ID,state:'not_ready',activePublication:active}, {...ID,state:'ready',...active}])a.throws(()=>P.publicResponse(value));
});
test('credential is saved before redemption, raw invite only in Authorization and lost response retries same credential',async()=>{
 const store=memory(),sent=[];let failed=true;
 const c=client({store,fetch:async(url,options)=>{if(url.endsWith('/session')){const body=JSON.parse(options.body);a.equal((await store.load()).credential,body.credential);a.equal(options.headers.Authorization,'Bearer '+link.token);a(!options.body.includes(link.token));a.equal(body.personId,'friend-a');sent.push(body);if(failed){failed=false;throw Error('secret echo '+link.token);}return response({expiresAt:'2026-11-14T12:00:00.000Z'},201);}return response({state:'not_ready'});}});
 await a.rejects(c.start(link),/connection/);a(!c.snapshot.error.includes(link.token));await c.retrySession();a.deepEqual(sent[0],sent[1]);
 const other=client({store});await other.start();a.equal(other.snapshot.session,true);
});
test('storage denial retains memory credential and never claims persisted resume',async()=>{
 const states=[],c=client({store:{load:async()=>{throw Error('denied');},save:async()=>{throw Error('denied');}},onChange:v=>states.push(v)});await c.start(link);a.equal(c.snapshot.persistent,false);a.equal(c.snapshot.session,true);a(states.every(v=>v.persistent===false));
});
test('invalid files never allocate; real bytes, hashes and serial durable chunk acknowledgements queue an export through injected transport',async t=>{
 const server=await start();t.after(server.close);const store=memory(),events=[],c=client({fetch:server.fetch,store,onChange:v=>events.push(structuredClone(v))});await c.start(link);
 for(const f of [null,{...file(),name:'bad.txt'},{...file(),size:U.MAX+1},{...file(),arrayBuffer:async()=>new ArrayBuffer(30)}])await a.rejects(c.upload(f),/ZIP/);
 a.equal(server.state.requests.size,0);
 const archive=file();await c.upload(archive);a.equal(c.snapshot.status.state,'queued');a.equal(c.snapshot.status.activePublication,null);a.equal(server.state.puts,2);a.equal(server.state.bytes,archive.size);
 const record=[...server.state.requests.values()][0];a.deepEqual(Buffer.concat([...record.chunks.values()]),archive.bytes);a.equal(record.intake.archiveSha256,await U.hash(archive.bytes,crypto));
 a(events.some(v=>v.progress?.acknowledged===262144));a(events.every(v=>v.status?.state!=='ready'));
 a.deepEqual(server.calls.filter(c=>c.method==='PUT').map(c=>c.path.split('/').at(-1)),['0','1']);
});
test('reload resumes same request with identical chunks after failure; server state is authoritative',async t=>{
 const server=await start();t.after(server.close);const store=memory(),archive=file();server.state.failOrdinal=1;const c=client({store,fetch:server.fetch});await c.start(link);await a.rejects(c.upload(archive));a.equal(c.snapshot.progress.acknowledged,262144);const id=[...server.state.requests.keys()][0];a.equal(server.state.requests.get(id).chunks.size,1);
 server.state.failOrdinal=null;const reloaded=client({store,fetch:server.fetch});await reloaded.start();await reloaded.upload(archive);a.equal(server.state.requests.size,1);a.equal(server.state.requests.get(id).chunks.size,2);a.equal(reloaded.snapshot.status.state,'queued');
 const again=client({store,fetch:server.fetch});await again.start();const puts=server.state.puts;await again.upload(archive);a.equal(server.state.puts,puts);a.equal(again.snapshot.status.state,'queued');
});
test('cancellation calls server, retains active page, and the next upload uses a new immutable ID',async t=>{
 const server=await start();t.after(server.close);server.state.activePublication=active;server.state.failOrdinal=1;const c=client({fetch:server.fetch});await c.start(link);await a.rejects(c.upload(file()));const id=[...server.state.requests.keys()][0];await c.cancel();a.equal(c.snapshot.status.state,'cancelled');a.equal(c.snapshot.status.activePublication.revision,revision);
 server.state.failOrdinal=null;await c.upload(file());a.equal(server.state.requests.size,2);a.notEqual([...server.state.requests.keys()][1],id);
});
test('old progress and wrong person are rejected while last-good publication survives errors',async()=>{
 let next={state:'publishing',request:{requestId,generation:2,state:'publishing'},activePublication:active};const c=client({fetch:async url=>url.endsWith('/session')?response({expiresAt:'2026-11-14T12:00:00.000Z'}):response(next)});await c.start(link);
 for(const value of [{state:'queued',request:{requestId,generation:2,state:'queued'},activePublication:active},{state:'processing',request:{requestId:crypto.randomUUID(),generation:1,state:'processing'},activePublication:active},{...ID,personId:'marco',state:'ready'}]){next=value;await a.rejects(c.check());a.equal(c.snapshot.status.state,'publishing');a.equal(c.snapshot.status.activePublication.revision,revision);}
 next={state:'failed',request:{requestId,generation:2,state:'failed'},activePublication:active};await c.check();a.match(U.message(c.snapshot.status),/current page is unchanged/);
});
test('polling stops hidden/paused/terminal, respects Retry-After and never invents a progress percentage',async()=>{
 let now=0,visible=true,poll,delay,cleared=0,limited=false;const timers=[];
 const c=client({clock:()=>now,visible:()=>visible,setTimer:(fn,ms)=>{poll=fn;delay=ms;timers.push(ms);return 1;},clearTimer:()=>cleared++,fetch:async url=>url.endsWith('/session')?response({expiresAt:at}):limited?response({error:{code:'LIMIT'}},429,{'Retry-After':'180'}):response({state:'queued',request:{requestId,generation:1,state:'queued'},activePublication:null,pollAfterSeconds:1})});
 await c.start(link);a.equal(delay,60000);visible=false;c.visibility();a(cleared>0);visible=true;c.pause();const count=timers.length;c.visibility();a.equal(timers.length,count);c.pause();limited=true;await a.rejects(c.check());a.equal(delay,180000);now=180001;limited=false;await poll();a.equal(c.snapshot.status.state,'queued');a(!U.message(c.snapshot.status).includes('%'));
});
test('safe invitation and service errors never reflect provider details or claim success',async()=>{
 for(const code of [401,403,409,503]){const c=client({fetch:async()=>response({error:{code:'INVITE_USED',message:'private provider detail'}},code)});await a.rejects(c.start(link));a.doesNotMatch(c.snapshot.error,/private provider detail/);a.equal(c.snapshot.status,null);}
});
test('all protocol states have distinct recovery copy and ready without active publication is unverified',()=>{
 for(const state of U.STATES)a(U.message({state,activePublication:null}).length>10);a.match(U.message({state:'ready'}),/could not be verified/);a.match(U.message({state:'queued'}),/Scheduling can be delayed/);a.match(U.message({state:'publishing'}),/confirmed/);
});

test('real loopback HTTP transport receives exact synthetic ZIP bytes', {skip:process.env.WILL_WEB_HTTP!=='1'?'Run WILL_WEB_HTTP=1 in a session with loopback permission.':false}, async t=>{
 const server=await start({http:true});t.after(server.close);const c=client({fetch:server.fetch});await c.start(link);await c.upload(file());a.equal(server.state.bytes,300000);a.equal(c.snapshot.status.state,'queued');
});

test('shipped DOM adapter shows credential loss, validates on submit, and never accepts a fake ready page',async()=>{
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,textContent:'',value:'',files:[],open:true,removeAttribute(key){delete this[key];},setAttribute(key,value){this[key]=value;},focus(){this.focused=true;}});return nodes.get(id);};
 const document={querySelector:key=>node(key.slice(1)),visibilityState:'visible',addEventListener(){}};
 let clears=0,publications=0;const c=U.mount({document,location:{hash:`#invite=${link.token}&id=${link.id}`,pathname:'/u/friend-a/',search:''},history:{replaceState(){clears++;}},crypto,indexedDB:null,apiOrigin:origin,fetch:async url=>response(url.endsWith('/session')?{expiresAt:at}:{state:'not_ready'}),onPublication:()=>publications++});
 await new Promise(resolve=>setImmediate(resolve));a.equal(clears,1);a.equal(node('uploadForm').hidden,false);a.match(node('credentialStatus').textContent,/only while this page is open/);a.match(node('uploadStatus').textContent,/first import/);a.match(node('uploadStatus').textContent,/Choose your Letterboxd ZIP/);a.doesNotMatch(node('uploadStatus').textContent,/invitation/);a.equal(node('uploadCheck').textContent,'Check progress');a.equal(publications,0);a.equal(node('uploadSubmit').disabled,false);
 node('uploadForm').onsubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));a.equal(node('uploadFile')['aria-invalid'],'true');a.equal(node('uploadFile').focused,true);a.match(node('uploadStatus').textContent,/ZIP/);c.stop();
});
test('HTML keeps Install above picker, native labels/landmarks and reduced motion across controls',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8');
 a(html.indexOf('id="install"')<html.indexOf('id="pickerContent"'));a.match(html,/<main id="main" tabindex="-1">/);a.match(html,/class="skip-link" href="#main"/);a.match(html,/<label for="uploadFile">Letterboxd export/);a.match(html,/id="uploadStatus" role="status"/);a.match(html,/name="referrer" content="no-referrer"/);a.match(html,/@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after/);a.match(html,/\.dial input \{ min-height:44px/);a.match(html,/data-will-api-origin=""/);a.doesNotMatch(html,/searchParams.*(?:api|origin)/i);
 const inline=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];new vm.Script(inline);
});
test('installation accepts only fixed live Will manifest routes, including existing profile cuts',async()=>{
 const UI=require('../web/feedback'),node=()=>({focus(){},select(){}}),install=node(),copy=node(),field=node(),fallback=node(),status=node(),location={href:'https://pages.fixture.invalid/mood-engine/u/friend-a/'};let copied;
 const control=UI.installation({install,copy,field,fallback,status,location,navigator:{clipboard:{writeText:async value=>copied=value}}});
 for(const bad of ['https://worker.fixture.invalid/manifest.json','https://worker.fixture.invalid/k/private/manifest.json','https://worker.fixture.invalid/u/marco/manifest.json','http://worker.fixture.invalid/u/friend-a/manifest.json'])a.throws(()=>control.setManifest(bad));
 control.setManifest(origin+'/u/friend-a/manifest.json');await copy.onclick();a.equal(copied,undefined);control.setReady(true);await copy.onclick();a.equal(copied,origin+'/u/friend-a/manifest.json');control.setManifest(origin+'/u/friend-a/p/night/manifest.json');install.onclick();a.equal(location.href,'stremio://worker.fixture.invalid/u/friend-a/p/night/manifest.json');
});
test('rehearsal accepts only explicit loopback backend and never generates success or accepts arbitrary file paths',()=>{
 const R=require('../scripts/will-web-rehearsal');a.equal(R.parse(['--offline','--person','friend-a','--port','4187']).api,undefined);
 for(const args of [['--offline','--api-origin','https://evil.invalid'],['--offline','--api-origin','http://127.0.0.1:8787/path'],['--offline','--person','marco'],['--offline','--port','abc']])a.throws(()=>R.parse(args));
 a.equal(R.parse(['--offline','--api-origin','http://127.0.0.1:8787']).api,'http://127.0.0.1:8787');
});
test('expired invitation still opens the independently verified last public page',async()=>{
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',removeAttribute(){},setAttribute(){},focus(){}});return nodes.get(id);};let published;
 const c=U.mount({document:{querySelector:get,visibilityState:'visible',addEventListener(){}},location:{hash:`#invite=${link.token}&id=${link.id}`,pathname:'/u/friend-a/',search:''},history:{replaceState(){}},crypto,indexedDB:null,apiOrigin:origin,fetch:async url=>url.endsWith('/session')?response({error:{code:'INVITE_EXPIRED'}},403):response({state:'ready',activePublication:active}),onPublication:value=>published=value});
 await new Promise(resolve=>setImmediate(resolve));a.ok(published,'expired invitation must still load the active public page');a.equal(published.revision,revision);a.match(get('#uploadStatus').textContent,/new invitation/);c.stop();
});
test('failed credential removal reports that a saved copy may return after reload',async()=>{
 let fail=false;const store=memory(),c=client({store:{load:store.load,save:async value=>{if(fail)throw Error('denied');await store.save(value);}}});await c.start(link);fail=true;await c.signOut();a.equal(c.snapshot.session,false);a.match(c.snapshot.error,/may return after reload/);a((await store.load()).credential);
});
test('exact 8 MiB archive uses 32 bounded chunks and a ready receipt stops polling',async t=>{
 const server=await start();t.after(server.close);const timers=[],c=client({fetch:server.fetch,setTimer:(_,ms)=>{timers.push(ms);return 1;}});await c.start(link);await c.upload(file(U.MAX));a.equal(server.state.requests.size,1);const item=[...server.state.requests.values()][0];a.equal(item.intake.chunks.length,32);a([...item.chunks.values()].every(part=>part.length===U.CHUNK));
 item.state='ready';server.state.activePublication=active;const count=timers.length;await c.check();a.equal(timers.length,count);a.equal(c.snapshot.status.state,'ready');c.stop();
});
test('queued status distinguishes a scheduled time from a delayed pickup without becoming ready',()=>{
 const value={state:'queued',request:{nextScheduledAt:'2026-10-15T09:10:00.000Z'}};a.match(U.message(value,Date.parse('2026-10-15T09:00:00.000Z')),/scheduled for 06:10/);a.match(U.message(value,Date.parse('2026-10-15T11:10:00.000Z')),/has not picked up/);a.equal(value.state,'queued');
});
