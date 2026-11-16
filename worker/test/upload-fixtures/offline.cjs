// CLI-side network boundary for the local-only acceptance harness.
const net=require('node:net'),dns=require('node:dns');
const allowed=new Set(['127.0.0.1','::1','localhost']);
const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 let first=args[0];if(Array.isArray(first))first=first[0];
 const options=first&&typeof first==='object'?first:null;
 const path=options?.path || (typeof first==='string' && first.startsWith('/')?first:null);
 const host=options?.host || (typeof args[1]==='string'?args[1]:'localhost');
 if(!path&&!allowed.has(host)){const e=new Error('external network disabled in local acceptance');e.code='NETWORK_DISABLED';throw e;}
 return original.apply(this,args);
};
const lookup=dns.lookup;
dns.lookup=function(host,...args){if(!allowed.has(host)){const e=new Error('external DNS disabled in local acceptance');e.code='NETWORK_DISABLED';throw e;}return lookup.call(this,host,...args);};
