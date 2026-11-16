const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('../test-support/film-page-fixture');
const { buildIndex } = require('../lib/index-export');
const { publish } = require('../lib/publish');
const { pageSynopsis } = require('../lib/page-export');
test('FP review: boundary synopsis publishes without changing index description', () => {
  const f = fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-boundary-'));
  try {
    f.plan.board[0].items[0].overview = 'a'.repeat(280); f.plan.board[0].place = 'board';
    const args = { cfg:f.cfg, plan:f.plan, today:'2026-10-24', builtAt:'2026-10-24T12:00:00.000Z', v2:{menu:[],countries:[]} };
    const before = buildIndex(args), pageFacts = new Map();
    const index2 = buildIndex({...args,pageFacts}); assert.deepEqual(index2,before);
    assert.ok(index2.films[0].desc.includes('a'.repeat(280)+'.'), 'retain legacy card bytes');
    assert.doesNotThrow(()=>publish({...f,index2,pageFacts,outDir:root}));
    const r = JSON.parse(fs.readFileSync(path.join(root,'data/page-65.json'))).films[0];
    assert.equal(r.syn.length,280); assert.ok(r.syn.endsWith('.')); assert.deepEqual(index2,before);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('FP review: MUBI credit stays within 280 characters at the punctuation boundary', () => {
  const s=pageSynopsis('MUBI: '+'a'.repeat(273),'mubi');
  assert.equal(s.length,280); assert.ok(s.endsWith('. — MUBI'));
  assert.equal(pageSynopsis('Exact unchanged text','other'),'Exact unchanged text');
});
test('FP review: verifyIndex scans large page text within an independent deadline', () => {
  const code = `const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const {publish}=require('./lib/publish'),{fixture}=require('./test-support/film-page-fixture'),{verifyIndex}=require('./verify');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'page-verify-limit-'));
    try {
      publish({...fixture(),outDir:root}); const file=path.join(root,'data/page-65.json'),j=JSON.parse(fs.readFileSync(file));
      for(const suffix of ['', '@', '@domain.test']) {
        j.films[0].n='x'.repeat(200*1024)+suffix; fs.writeFileSync(file,JSON.stringify(j));
        const result=verifyIndex(root); assert.equal(result.ok,false);
        if(suffix==='@domain.test') assert.match(result.problems.join(';'),/e-mail|private content/);
      }
      process.stdout.write('complete verify scan passed');
    } finally {fs.rmSync(root,{recursive:true,force:true});}`;
  const got=spawnSync(process.execPath,['-e',code],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:5000});
  assert.equal(got.error?.code,undefined,'verifyIndex exceeded independent five-second deadline');
  assert.equal(got.status,0,got.stderr); assert.equal(got.stdout,'complete verify scan passed');
});
