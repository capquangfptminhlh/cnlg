'use strict';
/**
 * Public Taobao is a preview-only browser. No original item/SKU IDs,
 * source links, CNY prices, cookies, provider names or checkout data.
 */
const {read,hasHan}=require('./sources/taobaoImporter');
const crypto=require('node:crypto');
const shipping=require('./taobaoPriceShipping');
const clean=(x,max=500)=>String(x??'').trim().slice(0,max);
const imagePath=x=>/^\/images\/taobao\/[a-z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/i.test(String(x||''))?x:null;
const safeHash=(prefix,id)=>prefix+crypto.createHash('sha256').update('besi-taobao-public:'+id).digest('hex').slice(0,18);
function approved(row){
  const original=Array.isArray(row?.options_zh)?row.options_zh:[];
  const translated=Array.isArray(row?.options_vi)?row.options_vi:[];
  return row?.preview_approved===true&&row?.rights_verified===true
    &&row?.translation_status==='translated'
    &&row?.published===true&&row?.purchasable===false
    &&!!row?.title_vi&&!hasHan(row.title_vi)
    &&(!row.description_zh||(!!row.description_vi&&!hasHan(row.description_vi)))
    &&(!row.category_zh||(!!row.category_vi&&!hasHan(row.category_vi)))
    &&original.length===translated.length
    &&translated.every(v=>!!String(v||'').trim()&&!hasHan(v))
    &&(!Array.isArray(row.sku_variants)||!row.sku_variants.length
      ||row.sku_variants.length===translated.length);
}
function publicVariants(row,region,rate,tariff){
  const vars=Array.isArray(row.sku_variants)?row.sku_variants:[];
  return vars.slice(0,50).map((v,i)=>({
    id:safeHash('V',row.id+':'+v.sku),
    label:clean(row.options_vi?.[i]||'',180),
    // Do not silently use one SKU's price/weight for another.
    pricing:shipping.quote(v,{region,rate,tariff})
  }));
}
function getPublicCatalog(rows,query={},options={}){
  const rate=Object.hasOwn(options,'rate')?options.rate:shipping.getRate();
  const tariff=Object.hasOwn(options,'tariff')?options.tariff:shipping.getTariff();
  const region=String(query.region||'hcm').toLowerCase();
  const q=clean(query.q,80).toLocaleLowerCase('vi');
  const category=clean(query.category,80).toLocaleLowerCase('vi');
  const page=Math.max(1,Math.min(1000,parseInt(query.page,10)||1));
  const limit=Math.max(1,Math.min(24,parseInt(query.limit,10)||24));
  const eligible=(Array.isArray(rows)?rows:[]).filter(approved);
  const categories=[...new Set(eligible.map(row=>clean(row.category_vi||'Sản phẩm Taobao',100)))]
    .sort((a,b)=>a.localeCompare(b,'vi'));
  const matches=eligible.filter(row=>(!q||((row.title_vi||'')+' '+(row.category_vi||'')+' '+(row.description_vi||'')
      +' '+(row.options_vi||[]).join(' ')).toLocaleLowerCase('vi').includes(q))
    &&(!category||clean(row.category_vi||'Sản phẩm Taobao',100).toLocaleLowerCase('vi')===category));
  const data=matches.slice((page-1)*limit,page*limit).map(row=>{
    const variants=publicVariants(row,region,rate,tariff);
    return {
      id:safeHash('T',row.id),name:clean(row.title_vi,250),
      description:clean(row.description_vi,1200),
      category:clean(row.category_vi||'Sản phẩm Taobao',100),
      image:imagePath(row.besi_image),
      status:'Đang xác minh đặt hàng',can_order:false,
      variants,
      pricing:variants.length?variants[0].pricing:shipping.quote(row,{region,rate,tariff})
    };
  });
  return {success:true,total:matches.length,page,limit,categories,data};
}
function catalogFromStage(query={},readFn=read,options={}){
  const state=readFn();
  return getPublicCatalog(state.items,query,options);
}
module.exports={approved,publicVariants,getPublicCatalog,catalogFromStage};
