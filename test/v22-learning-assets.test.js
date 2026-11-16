'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const B=require('../lib/learning/binary'),SN=require('../lib/learning/snapshot'),inline=require('../test-support/legacy-binary-map');
const root=path.resolve(__dirname,'..');
test('v2.2 freezes flag bytes and country table; refuses altered PNG, aliases and excessive dimensions',()=>{
 const map=inline(root,B.capture(root)),flag='cache/flags/br.png',bytes=fs.readFileSync(path.join(root,flag));
 a.deepEqual(B.validate(map)[flag],bytes);
 a(SN.sourceFiles(root).includes('tools/selo/countries.json'));
 const bad=Buffer.from(bytes);bad[20]^=1;
 a.throws(()=>B.validate({[flag]:{...map[flag],data:bad.toString('base64')}}),/hash mismatch/);
 for(const name of ['cache/flags/BR.png','cache/flags/../br.png','cache/flags/br.png/extra','cache/flags/arbitrary.json'])a.throws(()=>B.validate({[name]:map[flag]}),/path|source/);
 const oversized=Buffer.from(bytes);oversized.writeUInt32BE(257,16);
 a.throws(()=>B.validate({[flag]:{encoding:'base64',length:oversized.length,data:oversized.toString('base64'),sha256:B.digest(oversized)}}),/dimensions/);
 const malformed=Buffer.from(bytes);malformed[0]=0;
 a.throws(()=>B.validate({[flag]:{encoding:'base64',length:malformed.length,data:malformed.toString('base64'),sha256:B.digest(malformed)}}),/PNG/);
});
test('local country table identity is checked and flag symlinks are refused before capture',()=>{
 const temp=fs.mkdtempSync(path.join(root,'.context/flags-'));
 try {
  fs.cpSync(path.join(root,'tools'),path.join(temp,'tools'),{recursive:true});
  const input={sourceBytes:Object.fromEntries(B.rendererText.map(n=>[n,fs.readFileSync(path.join(root,n),'utf8')])),binarySources:B.capture(root)};
  B.rendererIdentity(temp,input);
  fs.appendFileSync(path.join(temp,'tools/selo/countries.json'),' ');
  a.throws(()=>B.rendererIdentity(temp,input),/identity mismatch.*countries/);
  fs.mkdirSync(path.join(temp,'cache/flags'),{recursive:true});
  fs.symlinkSync(path.join(root,'cache/flags/br.png'),path.join(temp,'cache/flags/br.png'));
  a.throws(()=>B.capture(temp),/Symlink/);
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
