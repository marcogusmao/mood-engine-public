'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function inputs(root=ROOT){return Object.fromEntries(require('../lib/learning/snapshot').sourceFiles(root).filter(n=>!n.endsWith('.js')&&!n.startsWith('web/')).map(n=>[n,digest(fs.readFileSync(path.join(root,n)))]));}
function normalized(x,parent=null){if(Array.isArray(x))return x.map(v=>normalized(v,parent));if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).filter(([k])=>!(k==='poster'&&('tt' in x||'id' in x||'i' in x))&&!(k==='builtAt'&&parent==='meta')).map(([k,v])=>[k,normalized(v,k)]));return x;}
module.exports={ROOT,digest,inputs,normalized};
