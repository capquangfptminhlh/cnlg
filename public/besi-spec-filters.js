/*
 * BESI specification finder — presentation/client filtering only.
 * Queries BESI's existing public /api/products endpoint, never supplier APIs.
 * Traverses matching pages on demand: DOES NOT claim a complete catalog total
 * until all returned pages have been checked.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const root=$('besiSpecFinder'),results=$('besiSpecResults'),grid=$('besiSpecGrid');
  if(!root||!results||!grid)return;
  const apply=$('besiApplySpecs'),loadMore=$('besiSpecLoadMore');
  // Mobile shoppers should see real products immediately; the summary remains
  // visible and expands the full attribute filters on demand.
  if(window.matchMedia&&window.matchMedia('(max-width: 700px)').matches){
    const details=$('besiSpecDetails');
    if(details)details.open=false;
  }
  const storage={active:false,requestId:0,sources:[],seen:new Set(),items:[],displayed:0,scanned:0,loading:false,filter:null};
  const TAKE=24, PAGE_SIZE=100, MAX_FIRST_REQUESTS=9, MAX_NEXT_REQUESTS=6;
  const accentless=s=>String(s||'').normalize('NFKC').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d')
    .replace(/[→–—_\/]/g,' ').replace(/-/g,' ').replace(/\s+/g,' ').trim();
  const hasLightning=s=>/\b(lightning|lighting|lightnig|iphone|8 ?pin)\b/.test(s);
  const hasC=s=>/\b(type ?c|usb ?c|usbc|typec)\b/.test(s)
    || /\bc (to|sang) (lightning|lighting|iphone)\b/.test(s);
  const hasA=s=>/\b(usb ?a|type ?a|usba)\b/.test(s)
    || /\busb (to|sang) (lightning|lighting|iphone)\b/.test(s);
  function connectorMatch(text,type){
    const l=hasLightning(text),c=hasC(text),a=hasA(text);
    switch(type){
      case 'c-lightning':return c&&l&&!/\b(usb a|type a)\b/.test(text);
      case 'a-lightning':return a&&l&&!c;
      case 'lightning':return l;
      case 'c-c':return /\b(?:type c|usb c|usbc|typec|c)\s*(?:to|sang|2 dau|2 dau|2)\s*(?:type c|usb c|usbc|typec|c)\b/.test(text)
        || ((text.match(/\b(type c|usb c|usbc|typec)\b/g)||[]).length>=2&&!l);
      case 'a-c':return a&&c&&!l;
      default:return false;
    }
  }
  function declaredLength(text){
    const found=[];
    const re=/(^|[^0-9])(\d+(?:[.,]\d+)?)\s*(cm|mm|m|met|meter)(?![a-z])/g;
    let m;
    while((m=re.exec(text))){
      const n=Number(m[2].replace(',','.'));
      const metres=m[3]==='cm'?n/100:m[3]==='mm'?n/1000:n;
      if(Number.isFinite(metres)&&metres>0&&metres<=20)found.push(metres);
    }
    return found;
  }
  function matchingVariants(p,f){
    const available=(Array.isArray(p.variants)?p.variants:[])
      .filter(v=>v&&v.in_stock!==false&&Number(v.price)>0);
    if(!f.length)return available;
    return available.filter(v=>declaredLength(accentless(v.name)).some(n=>Math.abs(n-f.length)<.001));
  }
  function isMatch(p,f){
    if(!p||p.in_stock===false||!Number.isSafeInteger(Number(p.id))||Number(p.price)<=0)return null;
    const variants=Array.isArray(p.variants)?p.variants:[];
    const allNames=[p.name,...variants.map(v=>v?.name||'')];
    const text=accentless(allNames.join(' '));
    if(!connectorMatch(text,f.type))return null;
    const inStock=matchingVariants(p,f);
    const titleText=accentless(p.name);
    const wantedLength=f.length>0;
    if(wantedLength&&!variants.length&&!declaredLength(titleText)
      .some(n=>Math.abs(n-f.length)<.001))return null;
    const passesExtra=text=>
      (!f.power||new RegExp('(^|[^\\d])'+f.power+'\\s*w(?![a-z])').test(text))
      &&(!f.color||new RegExp('(^|[^a-z])'+f.color+'([^a-z]|$)').test(text));
    let chosen=null;
    if(variants.length){
      if(!inStock.length)return null;
      // Length, power and color can be declared in a specific variation, not only the parent.
      chosen=inStock.find(v=>passesExtra(titleText+' '+accentless(v.name)))||null;
      if(!chosen)return null;
    }else if(!passesExtra(titleText))return null;
    return {p,variant:chosen};
  }
  const queryTerms=type=>{
    switch(type){
      case 'c-lightning':case 'a-lightning':case 'lightning':return ['lightning','lighting'];
      case 'c-c':return ['type c','usb c'];
      case 'a-c':return ['type c','usb c'];
      default:return ['cap'];
    }
  };
  const form=()=>({
    type:root.querySelector('input[name="besiConnector"]:checked')?.value||'c-lightning',
    length:Number(root.querySelector('input[name="besiLength"]:checked')?.value||0),
    power:Number(root.querySelector('input[name="besiWatt"]:checked')?.value||0),
    color:$('besiSpecColor').value
  });
  function typeName(type){
    return {
      'c-lightning':'USB-C → Lightning',
      'a-lightning':'USB-A → Lightning',
      'c-c':'USB-C → USB-C',
      'a-c':'USB-A → USB-C',
      lightning:'Cáp Lightning'
    }[type]||'Cáp sạc';
  }
  const money=value=>Number(value).toLocaleString('vi-VN')+'đ';
  function readImage(src){
    const val=String(src||'');
    return /^\/(?:cdn\/|api\/catalog-image\/|images\/)[a-z0-9/_.,?=&%-]+$/i.test(val)
      &&!val.includes('..')?val:null;
  }
  const el=(tag,className,text)=>{
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(text!=null)node.textContent=String(text);
    return node;
  };
  async function showDetail(item){
    const id=Number(item.p.id);
    if(typeof openProductDetail!=='function')return;
    try{
      await openProductDetail(id);
      if(item.variant&&typeof pickVariant==='function'){
        const stillAvailable=(state.activeDetailProduct?.variants||[])
          .find(v=>String(v.id)===String(item.variant.id)&&v.in_stock!==false);
        if(stillAvailable)pickVariant(stillAvailable.id);
      }
    }catch(e){console.error('BESI: không thể mở phân loại',e);}
  }
  function card(item){
    const p=item.p, v=item.variant;
    const article=el('article','besi-spec-product luxury-card');
    const imageButton=el('button','besi-spec-product-image');
    imageButton.type='button';
    imageButton.setAttribute('aria-label','Xem '+String(p.name||'sản phẩm').slice(0,90));
    const image=el('img');image.loading='lazy';image.decoding='async';
    image.src=readImage(v?.image||p.image)||'/besi-logo.svg';
    image.alt=String(p.name||'Sản phẩm BESI').slice(0,150);
    image.onerror=()=>{image.onerror=null;image.src='/besi-logo.svg';};
    imageButton.append(image);imageButton.addEventListener('click',()=>showDetail(item));
    const body=el('div','besi-spec-product-body');
    const title=el('button','besi-spec-product-title',p.name||'Sản phẩm BESI');
    title.type='button';title.addEventListener('click',()=>showDetail(item));
    const price=el('strong','besi-spec-product-price',money(v?.price||p.price));
    body.append(title);
    if(v)body.append(el('span','besi-spec-product-variant','Phân loại: '+String(v.name||'').slice(0,90)));
    body.append(price);
    const cta=el('button','besi-spec-product-buy',v?'Chọn đúng phân loại':'Xem và mua');
    cta.type='button';cta.addEventListener('click',()=>showDetail(item));
    body.append(cta);article.append(imageButton,body);return article;
  }
  function statusText(){
    const pending=storage.sources.some(s=>!s.done);
    let phrase='Đã kiểm tra '+storage.scanned.toLocaleString('vi-VN')
      +' sản phẩm từ kết quả tìm kiếm; tìm được '+storage.items.length.toLocaleString('vi-VN')+' mẫu phù hợp.';
    if(pending)phrase+=' Vẫn còn kết quả chưa kiểm tra, có thể bấm xem thêm.';
    if(!pending)phrase+=' Đã kiểm tra hết các kết quả trả về từ tìm kiếm.';
    if(!storage.items.length&&pending)phrase+=' Thử bỏ lọc chiều dài hoặc công suất để tìm được nhiều hàng hơn.';
    return phrase;
  }
  function paint(){
    const visible=storage.items.slice(0,storage.displayed);
    grid.replaceChildren(...visible.map(card));
    $('besiSpecStatus').textContent=storage.error||statusText();
    if(!visible.length&&!storage.loading){
      const msg=el('div','besi-spec-empty','Chưa thấy sản phẩm khớp thông số trong các trang đã kiểm tra. Bạn có thể mở rộng bộ lọc hoặc xem tiếp các kết quả.');
      grid.append(msg);
    }
    loadMore.hidden=!storage.sources.some(s=>!s.done)&&storage.displayed>=storage.items.length;
    loadMore.disabled=storage.loading;
    loadMore.textContent=storage.loading?'Đang kiểm tra sản phẩm…':storage.displayed<storage.items.length?'Xem thêm sản phẩm phù hợp':'Tìm tiếp trong kho hàng';
  }
  async function scanOne(src,version){
    if(src.done||version!==storage.requestId)return;
    const currentPage=src.page;
    const url='/api/products?'+new URLSearchParams({
      search:src.term,limit:String(PAGE_SIZE),page:String(currentPage),inStock:'1'
    });
    const res=await fetch(url,{credentials:'same-origin'});
    if(!res.ok)throw new Error('Không thể đọc danh mục BESI (HTTP '+res.status+')');
    const payload=await res.json();
    if(version!==storage.requestId)return;
    if(!payload.success||!Array.isArray(payload.data))throw new Error('Dữ liệu danh mục không hợp lệ');
    src.page++;
    src.done=src.page>(Number(payload.totalPages)||1)||!payload.data.length;
    storage.scanned+=payload.data.length;
    if(typeof rememberProducts==='function')rememberProducts(payload.data);
    for(const p of payload.data){
      if(storage.seen.has(String(p.id)))continue;
      storage.seen.add(String(p.id));
      const hit=isMatch(p,storage.filter);
      if(hit)storage.items.push(hit);
    }
  }
  async function scan(version,requestsLimit){
    storage.loading=true;apply.disabled=true;loadMore.disabled=true;
    try{
      let remaining=requestsLimit;
      // Only query searchable product names; never download the whole supplier feed.
      while(remaining>0&&version===storage.requestId){
        const active=storage.sources.filter(s=>!s.done).slice(0,Math.min(remaining,2));
        if(!active.length)break;
        await Promise.all(active.map(src=>scanOne(src,version)));
        remaining-=active.length;
        if(storage.items.length>=storage.displayed+TAKE)break;
      }
    }catch(e){
      if(version===storage.requestId){
        storage.error='Không kết nối được danh mục: '+String(e.message).slice(0,110);
      }
    }finally{
      if(version===storage.requestId){
        storage.loading=false;apply.disabled=false;
        if(!storage.displayed)storage.displayed=Math.min(TAKE,storage.items.length);
        else if(storage.displayed<storage.items.length)storage.displayed=Math.min(storage.displayed+TAKE,storage.items.length);
        paint();
      }
    }
  }
  function leave(){
    storage.requestId++;
    storage.active=false;
    results.hidden=true;
    $('catalog').classList.remove('besi-filter-mode');
    root.querySelectorAll('input[name="besiLength"]')[0].checked=true;
    root.querySelectorAll('input[name="besiWatt"]')[0].checked=true;
    $('besiSpecColor').value='';
    root.querySelector('input[name="besiConnector"][value="c-lightning"]').checked=true;
  }
  function applySpecs(){
    const selected=form(),version=++storage.requestId;
    storage.active=true;
    storage.filter=selected;
    storage.sources=queryTerms(selected.type).map(term=>({term,page:1,done:false}));
    storage.seen.clear();storage.items=[];storage.displayed=0;storage.scanned=0;storage.error='';
    results.hidden=false;
    $('catalog').classList.add('besi-filter-mode');
    $('besiSpecResultsTitle').textContent=typeName(selected.type)
      +(selected.length?' · '+String(selected.length).replace('.',',')+'m':'')
      +(selected.power?' · '+selected.power+'W':'');
    $('besiSpecStatus').textContent='Đang kiểm tra tên và phân loại sản phẩm trên BESI…';
    grid.replaceChildren();
    results.scrollIntoView({behavior:'smooth',block:'start'});
    scan(version,MAX_FIRST_REQUESTS);
  }
  apply.addEventListener('click',applySpecs);
  loadMore.addEventListener('click',()=>{
    if(storage.loading)return;
    if(storage.displayed<storage.items.length){
      storage.displayed=Math.min(storage.displayed+TAKE,storage.items.length);paint();
    }else scan(storage.requestId,MAX_NEXT_REQUESTS);
  });
  $('besiExitSpecs').addEventListener('click',leave);
  $('besiResetSpecs').addEventListener('click',()=>{
    leave();document.getElementById('productGrid')?.scrollIntoView({behavior:'smooth',block:'start'});
  });
  // Standard catalog search/sort/category/filter remains fully functional.
  document.addEventListener('click',event=>{
    if(!storage.active)return;
    const button=event.target.closest('#searchBtn,.cat-btn,.brand-pill,.price-pill,[data-store-action],.market-links a,#btnLoadMore');
    if(button)leave();
  },true);
  document.getElementById('searchInput')?.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&storage.active)leave();
  },true);
  // Browser navigation and deep links should restore the ordinary list.
  window.addEventListener('popstate',()=>{if(storage.active)leave();});
  window.BesiSpecs={connectorMatch,declaredLength,isMatch};
})();
