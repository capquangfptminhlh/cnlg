#!/usr/bin/env node
'use strict';
// Import supplier-licensed JSONL export into PRIVATE Taobao staging only.
require('dotenv').config();
const importer=require('../services/sources/taobaoImporter');
const args=process.argv.slice(2);
const rightsConfirmed=args.includes('--confirm-rights');
const feed=args.find(x=>x!=='--confirm-rights');
if(!rightsConfirmed||!feed||args.length!==2){
  console.error('Usage: npm run taobao:feed -- ./private/feed.jsonl --confirm-rights');
  console.error('This action DOES NOT publish products or enable orders.');
  process.exitCode=2;
}else{
  importer.importFeed(feed,{rightsConfirmed,
    onTranslationError:e=>console.error('Translation pending:',e.message)
  }).then(result=>{
    console.log('Taobao private feed import:',JSON.stringify(result));
    console.log('Every item remains non-purchasable; manually review before preview approval.');
  }).catch(error=>{
    console.error('Taobao feed import failed:',error.message);
    process.exitCode=1;
  });
}
