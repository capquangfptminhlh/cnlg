'use strict';
// Authorized Taobao API importer. Staging only: nothing here goes into public checkout.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const FILE = path.resolve(__dirname, '../../data/taobao-staging.json');
const MAX_ITEMS = 25000;
const clean = (x, n = 7000) => String(x ?? '').trim().slice(0, n);
const hasHan = x => /[\u3400-\u9fff]/u.test(String(x || ''));

function timestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Shanghai',year:'numeric',
    month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',
    hourCycle:'h23'}).formatToParts(date);
  const p = Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return p.year+'-'+p.month+'-'+p.day+' '+p.hour+':'+p.minute+':'+p.second;
}
function sign(params, secret) {
  const data = Object.keys(params).sort().map(k=>k+params[k]).join('');
  return crypto.createHash('md5').update(secret+data+secret,'utf8').digest('hex').toUpperCase();
}
function extract(json) {
  if(json?.error_response) throw Error('Taobao API: '+clean(json.error_response.sub_msg || json.error_response.msg,180));
  const result=json?.tbk_dg_material_optional_response;
  if(!result) throw Error('Unknown Taobao API response');
  const found=result.result_list?.map_data;
  return !found?[]:Array.isArray(found)?found:[found];
}
async function fetchPage(keyword,page,opt={}) {
  const key=opt.appKey||process.env.TAOBAO_APP_KEY;
  const secret=opt.appSecret||process.env.TAOBAO_APP_SECRET;
  const adzone=opt.adzoneId||process.env.TAOBAO_ADZONE_ID;
  if(!key||!secret||!/^[0-9]+$/.test(String(adzone||''))) throw Error('Missing Taobao API credentials');
  if(!Number.isInteger(page)||page<1||page>10000) throw Error('Bad page');
  const data={method:'taobao.tbk.dg.material.optional',app_key:String(key),
    timestamp:timestamp(opt.now),format:'json',v:'2.0',sign_method:'md5',
    adzone_id:String(adzone),q:clean(keyword,100),page_no:String(page),page_size:'100',platform:'1'};
  if(!data.q) throw Error('Keyword required');
  data.sign=sign(data,secret);
  const response=await (opt.fetchImpl||fetch)('https://eco.taobao.com/router/rest',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams(data),signal:AbortSignal.timeout(25000)});
  if(!response.ok) throw Error('Taobao API HTTP '+response.status);
  return extract(await response.json());
}
function normalize(raw,keyword) {
  const id=clean(raw?.item_id||raw?.num_iid,24),zh=clean(raw?.title,500);
  if(!/^[0-9]{6,20}$/.test(id)||!zh) return null;
  const cny=Number(raw.zk_final_price||raw.reserve_price);
  const images=raw.small_images?.string;
  const validUrl=x=>/^https:\/\/[a-z0-9.-]+\/[^<>"']+$/i.test(String(x||''))?clean(x,1500):'';
  return {id,keyword:clean(keyword,100),title_zh:zh,
    description_zh:clean(raw.item_description||raw.description),
    options_zh:Array.isArray(raw.sku_options)?raw.sku_options.map(x=>clean(x,180)).slice(0,50):[],
    price_cny_reference:Number.isFinite(cny)&&cny>0?cny:null,
    image_reference:validUrl(raw.pict_url),
    gallery_references:(Array.isArray(images)?images:(images?[images]:[])).map(validUrl).filter(Boolean).slice(0,12),
    link_reference:validUrl(raw.item_url),
    title_vi:'',description_vi:'',options_vi:[],translation_status:'pending',
    stock_verified:false,landed_cost_vnd:null,shipping_quote_vnd:null,
    published:false,purchasable:false,updated_at:new Date().toISOString()};
}
async function translate(rows,opt={}) {
  const model=opt.model||process.env.TAOBAO_LOCAL_MODEL;
  if(!model||!rows.length) return rows;
  const prompt='Dịch dữ liệu sản phẩm Trung Quốc sang tiếng Việt. Không tự thêm thông số, kích cỡ, '
    +'thương hiệu, giá, khuyến mãi, bảo hành hay tồn kho. Giữ nguyên mã model và đơn vị. '
    +'Chỉ trả JSON object {"items":[{"id":"...","title_vi":"...","description_vi":"...","options_vi":[]}]} '
    +'với đầy đủ ID, không chứa chữ Hán trong bản dịch. Data: '
    +JSON.stringify(rows.map(x=>({id:x.id,title:x.title_zh,description:x.description_zh,options:x.options_zh})));
  try {
    const r=await (opt.fetchImpl||fetch)('http://127.0.0.1:11434/api/generate',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model,prompt,stream:false,format:'json'}),
      signal:AbortSignal.timeout(120000)});
    if(!r.ok) throw Error('Ollama HTTP '+r.status);
    const parsed=JSON.parse((await r.json()).response);
    const matches=new Map((Array.isArray(parsed.items)?parsed.items:[]).map(x=>[String(x.id),x]));
    return rows.map(row=>{
      const t=matches.get(row.id);
      if(!t) return row;
      const title=clean(t.title_vi,500);
      const desc=row.description_zh?clean(t.description_vi):'';
      const opts=row.options_zh.length&&Array.isArray(t.options_vi)?t.options_vi.map(x=>clean(x,180)):[];
      const good=title&&!hasHan(title)&&(!row.description_zh||(desc&&!hasHan(desc)))
        &&(!row.options_zh.length||(opts.length===row.options_zh.length&&opts.every(x=>x&&!hasHan(x))));
      return good?{...row,title_vi:title,description_vi:desc,options_vi:opts,translation_status:'translated'}:row;
    });
  } catch(err) {
    if(opt.onTranslationError) opt.onTranslationError(err);
    return rows; // Do not silently publish untranslated products.
  }
}
function read(file=FILE) {
  return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{version:1,items:[]};
}
function save(file,items) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+process.pid+'.tmp';
  try{
    fs.writeFileSync(tmp,JSON.stringify({version:1,updated_at:new Date().toISOString(),items}),
      {flag:'wx',mode:0o600});
    fs.renameSync(tmp,file);fs.chmodSync(file,0o600);
  } finally {try{fs.unlinkSync(tmp);}catch{}}
}
async function sync(keywords,opt={}) {
  if(!opt.skipPermissionCheck&&process.env.TAOBAO_DATA_PERMISSION!=='1')
    throw Error('TAOBAO_DATA_PERMISSION=1 requires verified permission to use the API data');
  if(!Array.isArray(keywords)||!keywords.length||keywords.length>30) throw Error('Provide 1-30 keywords');
  const pages=Math.min(50,Math.max(1,Math.trunc(Number(opt.pages)||2)));
  const file=opt.file||FILE,initial=read(file);
  if(initial.version!==1||!Array.isArray(initial.items)) throw Error('Invalid staging file');
  const items=new Map(initial.items.map(x=>[x.id,x])),seen=new Set();
  let fetched=0,translated=0;
  for(const word of keywords) for(let page=1;page<=pages;page++) {
    const found=await (opt.fetchPageImpl||fetchPage)(word,page,opt),pending=[];
    for(const raw of found) {
      const row=normalize(raw,word);
      if(!row||seen.has(row.id)) continue;
      seen.add(row.id);fetched++;
      const old=items.get(row.id);
      if(old&&old.title_zh===row.title_zh&&old.description_zh===row.description_zh
        &&JSON.stringify(old.options_zh)===JSON.stringify(row.options_zh)
        &&old.translation_status==='translated') {
        row.title_vi=old.title_vi;row.description_vi=old.description_vi;
        row.options_vi=old.options_vi;row.translation_status='translated';
      } else pending.push(row);
      items.set(row.id,row);
    }
    for(let j=0;j<pending.length;j+=10) {
      const translatedRows=await (opt.translateImpl||translate)(pending.slice(j,j+10),opt);
      for(const row of translatedRows) if(row&&items.has(row.id)) {
        items.set(row.id,row);
        if(row.translation_status==='translated') translated++;
      }
    }
    if(items.size>MAX_ITEMS) throw Error('Staging 25,000-item limit; upgrade to database before larger import');
    if(found.length<100) break;
    if(!opt.noDelay) await new Promise(resolve=>setTimeout(resolve,700));
  }
  save(file,[...items.values()]);
  return {fetched,translated,staged:items.size,
    needs_translation:[...items.values()].filter(x=>x.translation_status!=='translated').length,
    published:0};
}
module.exports={timestamp,sign,extract,fetchPage,normalize,hasHan,translate,read,sync,MAX_ITEMS};
