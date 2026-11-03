(()=>{
'use strict';
const el=id=>document.getElementById(id);
const state={q:'',category:'',page:1,limit:20,total:0,request:0,region:'hcm'};
const list=el('taobaoProducts'),count=el('resultCount'),status=el('taobaoStatus');
const more=el('taobaoMore'),cats=el('taobaoCategories');
function elem(tag,cls,contents){const n=document.createElement(tag);if(cls)n.className=cls;if(contents!==undefined)n.textContent=String(contents);return n;}
function empty(text){
  list.replaceChildren();
  const box=elem('div','empty');
  box.append(elem('div','empty-icon','◎'),elem('h3','empty-title','Đang chuẩn bị hàng Taobao'),elem('p','',text));
  const back=elem('a','', 'Khám phá sản phẩm BESI');back.href='/';
  box.append(back);list.append(box);
}
function categories(values){
  cats.replaceChildren();
  const all=['',...(Array.isArray(values)?values:[])];
  for(const val of all){
    const b=elem('button','chip'+(state.category===val?' active':''),val||'Tất cả');
    b.type='button';b.setAttribute('aria-pressed',String(state.category===val));
    b.addEventListener('click',()=>{
      if(state.category===val)return;
      state.category=val;state.page=1;load(false);
    });
    cats.append(b);
  }
}
function vnd(amount){
  return Number.isFinite(Number(amount))?Math.round(Number(amount)).toLocaleString('vi-VN')+' đ':'Đang xác minh';
}
function priceLine(label,amount,cls){
  const row=elem('div','price-line'+(cls?' '+cls:''));
  row.append(elem('span','',label),elem('strong','',vnd(amount)));
  return row;
}
function quoteBlock(quote){
  const outer=elem('div','price-breakdown');
  if(!quote||quote.status==='unavailable'){
    outer.append(elem('p','price-not-ready','Chưa có tỷ giá hoặc giá hàng đủ điều kiện để báo tạm tính.'));
    return outer;
  }
  outer.append(priceLine('Giá hàng quy đổi',quote.item_vnd));
  if(quote.status==='estimate'){
    outer.append(priceLine('Ship nội địa Trung Quốc',quote.china_domestic_shipping_vnd));
    outer.append(priceLine('Vận chuyển Trung Quốc → Việt Nam',quote.international_shipping_vnd));
    outer.append(priceLine('Giao nội địa Việt Nam',quote.domestic_vn_shipping_vnd));
    if(quote.handling_vnd>0)outer.append(priceLine('Phí xử lý',quote.handling_vnd));
    outer.append(priceLine('Tổng tạm tính',quote.total_vnd,'total'));
    if(quote.reason==='dimensions_unverified')
      outer.append(elem('p','price-warning','Chưa xác minh kích thước kiện: cước có thể thay đổi.'));
    outer.append(elem('p','price-ship-source','Cước dự kiến theo biểu phí '+(quote.shipping_provider||'đối tác')
      +' · Khối lượng tính cước '+quote.billable_weight_kg+' kg.'));
  }else{
    outer.append(elem('p','price-warning','Chưa đủ thông tin vận chuyển để tính tổng tiền. Đây mới là giá hàng quy đổi.'));
  }
  if(quote.rate_vnd_per_cny){
    const line=elem('p','price-fx','Tỷ giá tham khảo: 1 CNY ≈ '+vnd(quote.rate_vnd_per_cny));
    outer.append(line);
  }
  outer.append(elem('p','price-disclaimer','Giá ước tính, chưa gồm thuế/phí phát sinh; chưa hỗ trợ đặt mua.'));
  return outer;
}
function productCard(p){
  const card=elem('article','item'),art=elem('div','item-art');
  if(/^\/images\/taobao\/[a-z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/i.test(p.image||'')){
    const img=elem('img');img.src=p.image;img.loading='lazy';img.alt=p.name||'Sản phẩm';
    img.addEventListener('error',()=>{art.replaceChildren(elem('span','','◇'));});
    art.append(img);
  }else art.append(elem('span','','◇'));
  const body=elem('div','item-body');
  body.append(elem('span','item-cat',p.category||'Taobao'),elem('h3','',p.name||'Sản phẩm'));
  if(p.description)body.append(elem('p','',p.description.slice(0,150)));
  const pricingHost=elem('div','item-price-host');
  const variants=Array.isArray(p.variants)?p.variants:[];
  if(variants.length){
    const label=elem('label','variant-label','Chọn phân loại');
    const select=elem('select','variant-select');
    const labelId='variant-'+String(p.id||'').replace(/[^a-zA-Z0-9_-]/g,'');
    select.id=labelId;
    label.htmlFor=labelId;
    for(const v of variants){
      const option=elem('option','',v.label||'Phân loại');
      option.value=v.id;
      select.append(option);
    }
    select.addEventListener('change',()=>{
      const selected=variants.find(v=>v.id===select.value);
      pricingHost.replaceChildren(quoteBlock(selected?.pricing));
    });
    const selector=elem('div','variant-selector');
    selector.append(label,select);
    body.append(selector);
  }
  pricingHost.append(quoteBlock(variants.length?variants[0].pricing:p.pricing));
  body.append(pricingHost);
  body.append(elem('span','item-state','Đang xác minh đặt hàng'));
  card.append(art,body);return card;
}
async function load(append){
  const request=++state.request;
  status.textContent='Đang tải sản phẩm…';more.hidden=true;
  const q=new URLSearchParams({q:state.q,category:state.category,page:String(state.page),limit:String(state.limit),region:state.region});
  try{
    const response=await fetch('/api/taobao/products?'+q,{headers:{accept:'application/json'}});
    if(!response.ok)throw Error('Catalog unavailable');
    const payload=await response.json();
    if(!payload.success)throw Error('Catalog unavailable');
    if(request!==state.request)return;
    state.total=Number(payload.total)||0;
    categories(payload.categories);
    count.textContent=state.total.toLocaleString('vi-VN')+' sản phẩm đã được duyệt để giới thiệu';
    if(!append)list.replaceChildren();
    if(!state.total)empty('Chưa có sản phẩm Taobao nào hoàn tất dịch và kiểm duyệt. Danh mục này sẽ hiển thị riêng ngay khi có dữ liệu được duyệt.');
    else list.append(...(Array.isArray(payload.data)?payload.data:[]).map(productCard));
    status.textContent=state.total?'Nội dung tiếng Việt — sản phẩm chờ xác minh đặt hàng.':'Danh mục Taobao chưa có sản phẩm được duyệt.';
    more.hidden=state.page*state.limit>=state.total;
  }catch(error){
    if(request!==state.request)return;
    status.textContent='Không tải được danh mục Taobao lúc này.';
    if(!append)empty('Hệ thống đang cập nhật dữ liệu. Anh/chị có thể quay lại xem sản phẩm BESI hiện đang bán.');
  }
}
el('taobaoSearch').addEventListener('submit',e=>{
  e.preventDefault();state.q=el('taobaoQuery').value.trim().slice(0,80);state.page=1;load(false);
});
el('taobaoRegion').addEventListener('change',e=>{
  const region=e.target.value;
  if(!['hcm','hn','other'].includes(region))return;
  state.region=region;state.page=1;load(false);
});
more.addEventListener('click',()=>{state.page++;load(true);});
load(false);
})();
