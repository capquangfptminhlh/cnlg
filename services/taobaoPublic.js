'use strict';
/**
 * Only publish individually reviewed Taobao previews.
 * Imports are private by default. No Taobao supplier IDs, source links, CNY
 * price, cost, stock, cookies or purchase actions reach this API.
 */
const {read,hasHan}=require('./sources/taobaoImporter');
const crypto=require('node:crypto');
const shipping=require('./taobaoPriceShipping');
const clean=(x,max=500)=>String(x??'').trim().slice(0,max);
const imagePath=x=>/^\/images\/taobao\/[a-z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/i.test(String(x||''))?x:null;
function approved(row) {
  return row?.preview_approved===true && row?.rights_verified===true
    && row?.translation_status==='translated'
    && row?.published===true && row?.purchasable===false
    && !!row?.title_vi && !hasHan(row.title_vi)
    && (!row.description_vi||!hasHan(row.description_vi));
}
function getPublicCatalog(rows,query={},options={}) {
  const rate=Object.hasOwn(options,'rate')?options.rate:shipping.getRate();
  const tariff=Object.hasOwn(options,'tariff')?options.tariff:shipping.getTariff();
  const region=String(query.region||'hcm').toLowerCase();
  const q=clean(query.q,80).toLocaleLowerCase('vi');
  const category=clean(query.category,80).toLocaleLowerCase('vi');
  const page=Math.max(1,Math.min(1000,parseInt(query.page,10)||1));
  const limit=Math.max(1,Math.min(24,parseInt(query.limit,10)||24));
  const list=(Array.isArray(rows)?rows:[]).filter(approved)
    .map(row=>({
      id:'T'+crypto.createHash('sha256').update('besi-taobao-public:'+row.id).digest('hex').slice(0,18),
      name:clean(row.title_vi,250),description:clean(row.description_vi,1200),
      category:clean(row.category_vi||'Sản phẩm Taobao',100),
      image:imagePath(row.besi_image),
      status:'Đang xác minh đặt hàng',can_order:false,
      pricing:shipping.quote(row,{region,rate,tariff})
    }))
    .filter(row=>(!q||(row.name+' '+row.category+' '+row.description).toLocaleLowerCase('vi').includes(q))
      &&(!category||row.category.toLocaleLowerCase('vi')===category));
  const categories=[...new Set((Array.isArray(rows)?rows:[]).filter(approved)
    .map(row=>clean(row.category_vi||'Sản phẩm Taobao',100)))].sort((a,b)=>a.localeCompare(b,'vi'));
  return {success:true,total:list.length,page,limit,categories,
    data:list.slice((page-1)*limit,page*limit)};
}
function catalogFromStage(query={},readFn=read,options={}) {
  const state=readFn();
  return getPublicCatalog(state.items,query,options);
}
module.exports={approved,getPublicCatalog,catalogFromStage};
