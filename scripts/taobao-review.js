#!/usr/bin/env node
'use strict';
/** Local terminal-only operator action. Do not expose via anonymous HTTP. */
require('dotenv').config();
const review=require('../services/taobaoPreviewReview');
const argv=process.argv.slice(2);
const command=argv.shift();
function arg(name){const i=argv.indexOf(name);return i>=0?argv[i+1]:'';}
try {
  if(command==='list'){
    const result=review.list({limit:Number(arg('--limit'))||30});
    console.log(JSON.stringify(result,null,2));
  }else if(command==='approve'){
    const id=argv[0];
    const result=review.approve(id,{
      rightsConfirmed:argv.includes('--rights-confirmed'),
      translationReviewed:argv.includes('--translation-reviewed'),
      category:arg('--category'),image:arg('--image')
    });
    console.log(JSON.stringify(result,null,2));
  }else if(command==='revoke'){
    console.log(JSON.stringify(review.revoke(argv[0]),null,2));
  }else {
    console.error('Commands:');
    console.error(' npm run taobao:review -- list');
    console.error(' npm run taobao:review -- approve <item-id> --rights-confirmed --translation-reviewed --category "Phụ kiện điện thoại"');
    console.error(' npm run taobao:review -- revoke <item-id>');
    process.exitCode=2;
  }
}catch(error){
  console.error('Taobao review:',error.message);
  process.exitCode=1;
}
