#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fx=require('../services/taobaoPriceShipping');
fx.refreshRate().then(rate=>{
  console.log('CNY/VND reference rate updated:',JSON.stringify({
    rate:rate.rate,source:rate.source,as_of:rate.as_of
  }));
}).catch(error=>{
  console.error('CNY/VND reference rate unavailable:',error.message);
  process.exitCode=1;
});
