#!/usr/bin/env node
'use strict';
if(require.main===module){try{require('../lib/people-publication').verifyAggregate(process.argv[2]);console.log('OK: aggregate public boundaries');}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports=require('../lib/people-publication');
