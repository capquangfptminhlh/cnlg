#!/usr/bin/env node
'use strict';
require('dotenv').config();
const importer=require('../services/sources/taobaoImporter');
const keywords=process.argv.slice(2).map(x=>x.trim()).filter(Boolean);
if(!keywords.length) {
  console.error('Usage: npm run sync:taobao:stage -- "手机充电线" "手机壳"');
  process.exitCode=2;
} else {
  importer.sync(keywords,{
    pages: Number(process.env.TAOBAO_PAGES_PER_KEYWORD)||2,
    onTranslationError:err=>console.error('Translation pending:',err.message)
  }).then(summary=>{
    console.log('Taobao private staging:',JSON.stringify(summary));
    if(summary.needs_translation) console.log('Pending Vietnamese translation; no products are published.');
  }).catch(error=>{
    console.error('Taobao import failed:',error.message);
    process.exitCode=1;
  });
}
