#!/usr/bin/env node
'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{createClient}=require('./will-private-client');
// S4 (review of 20/10/2026): the raw invitation (`#invite=<token>`) is a credential. It goes to a 0600 file under the gitignored .context/ and never to stdout, so a session log or a CI log cannot hold it.
const CONTEXT_DIR=path.resolve(__dirname,'..','.context');
function generate({hours=168,now=new Date(),expectedAuthEpoch=0,random=crypto}={}){if(!Number.isInteger(hours)||hours<1||hours>168||!Number.isInteger(expectedAuthEpoch)||expectedAuthEpoch<0)throw Error('Invalid invitation limits');const token=random.randomBytes(32).toString('base64url'),inviteId=random.randomUUID();return {privateUrl:`https://marcogusmao.github.io/mood-engine/u/friend-a/#invite=${token}&id=${inviteId}`,registration:{schemaVersion:1,personId:'friend-a',inviteId,tokenHash:crypto.createHash('sha256').update(token).digest('hex'),expiresAt:new Date(+now+hours*3600000).toISOString(),expectedAuthEpoch}};}
function writePrivateLink(privateUrl,inviteId,{contextDir=CONTEXT_DIR}={}){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(inviteId))throw Error('Invalid invitation id');
 fs.mkdirSync(contextDir,{recursive:true,mode:0o700});
 const file=path.join(contextDir,`will-invitation-${inviteId}.txt`);
 fs.writeFileSync(file,privateUrl+'\n',{flag:'wx',mode:0o600});fs.chmodSync(file,0o600);return file;}
async function main(args,{log=console.log,contextDir,random}={}){const opt=k=>args[args.indexOf(k)+1],command=args[0];if(opt('--person')!=='friend-a')throw Error('Exact --person friend-a required');if(command==='generate'){const made=generate({hours:Number(opt('--expires-in-hours')||168),expectedAuthEpoch:Number(opt('--expected-auth-epoch')||0),random});
  log(JSON.stringify({privateLinkFile:writePrivateLink(made.privateUrl,made.registration.inviteId,{contextDir}),registration:made.registration}));return;}
 const client=createClient({origin:process.env.WILL_API_ORIGIN,role:'admin'});
 if(command==='register'){const body=JSON.parse(fs.readFileSync(opt('--input'),'utf8'));await client.request('POST','/invitations',{body});}
 else if(command==='revoke')await client.request('POST','/revoke',{body:{expectedAuthEpoch:Number(opt('--expected-auth-epoch'))}});
 else if(command==='abandon'){
  const revision=opt('--revision'),runId=opt('--run-id'),runAttempt=opt('--run-attempt'),codeSha=opt('--code-sha'),expectedGeneration=Number(opt('--generation'));
  if(!/^r-[a-f0-9]{32}$/.test(revision)||!Number.isSafeInteger(expectedGeneration)||expectedGeneration<1)throw Error('Invalid abandon identity');
  const token=process.env.GH_TOKEN;
  await (await import('../worker/src/upload/state.js')).verifyTerminalRun({runId,runAttempt,codeSha,token});
  await client.request('POST',`/publications/${revision}/abandon`,{githubToken:token,body:{expectedGeneration,terminalRunId:runId,terminalRunAttempt:runAttempt,reasonCode:'REPLAY_MISMATCH'}});
 }
 else throw Error('Unknown invitation operation');log('Invitation administration completed');}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={generate,writePrivateLink,main};
