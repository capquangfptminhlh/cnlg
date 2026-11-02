(()=>{
'use strict';
const el=id=>document.getElementById(id);
const state={q:'',category:'',page:1,limit:20,total:0,request:0};
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
  body.append(elem('span','item-state','Đang xác minh đặt hàng'));
  card.append(art,body);return card;
}
async function load(append){
  const request=++state.request;
  status.textContent='Đang tải sản phẩm…';more.hidden=true;
  const q=new URLSearchParams({q:state.q,category:state.category,page:String(state.page),limit:String(state.limit)});
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
more.addEventListener('click',()=>{state.page++;load(true);});
load(false);
})();
