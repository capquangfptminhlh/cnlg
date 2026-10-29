/* BESI specification finder — indexed SERVER results across entire catalog.
 * No supplier credentials, fake variations or whole-catalog browser scraping.
 * Existing checkout, catalog, inventory and prices stay unchanged.
 */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const root=$('besiSpecFinder'),results=$('besiSpecResults'),grid=$('besiSpecGrid');
  if(!root||!results||!grid)return;
  const apply=$('besiApplySpecs'),loadMore=$('besiSpecLoadMore');
  if(window.matchMedia&&window.matchMedia('(max-width: 700px)').matches){
    const details=$('besiSpecDetails');if(details)details.open=false;
  }
  const possibleBox=$('besiSpecPossible'),possibleGrid=$('besiSpecPossibleGrid'),
    possibleMore=$('besiSpecPossibleMore');
  const stateUi={active:false,seq:0,page:0,total:0,totalPages:1,loading:false,
    rows:[],filter:null,error:'',possibleTotal:0,possiblePages:1,possiblePage:0,
    possibleRows:[],possibleLoading:false};
  const NAMES={'c-lightning':'USB-C → Lightning','a-lightning':'USB-A → Lightning',
    'lightning':'Cáp Lightning','c-c':'USB-C → USB-C','a-c':'USB-A → USB-C'};
  const money=x=>Number(x).toLocaleString('vi-VN')+'đ';
  const form=()=>({
    type:root.querySelector('input[name="besiConnector"]:checked')?.value||'c-lightning',
    length:root.querySelector('input[name="besiLength"]:checked')?.value||'0',
    power:root.querySelector('input[name="besiWatt"]:checked')?.value||'0',
    color:$('besiSpecColor').value||''
  });
  const create=(tag,cls,text)=>{
    const e=document.createElement(tag);if(cls)e.className=cls;
    if(text!==undefined)e.textContent=String(text);return e;
  };
  function localImage(src){
    const s=String(src||'');
    return /^\/(?:images\/|cdn\/|api\/catalog-image\/)[a-z0-9/_.,?=&%-]+$/i.test(s)
      &&!s.includes('..')?s:'/besi-logo.svg';
  }
  async function showDetail(product){
    const id=Number(product.id);
    if(!Number.isSafeInteger(id)||id<1||typeof openProductDetail!=='function')return;
    try{
      await openProductDetail(id);
      // Reconfirm stock against fresh detail data before selecting a variation.
      const wanted=product.matched_variant;
      if(wanted&&product.verified_spec!==false&&typeof pickVariant==='function'){
        const available=(typeof state!=='undefined'&&state.activeDetailProduct?.variants||[])
          .find(v=>String(v.id)===String(wanted.id)&&v.in_stock!==false);
        if(available)pickVariant(available.id);
      }
    }catch(e){console.error('BESI: không thể mở sản phẩm',e);}
  }
  function card(product,unverified=false){
    const variation=product.matched_variant;
    const article=create('article','besi-spec-product luxury-card');
    const button=create('button','besi-spec-product-image');
    button.type='button';
    button.setAttribute('aria-label','Xem chi tiết '+String(product.name||'sản phẩm').slice(0,90));
    const img=create('img');img.loading='lazy';img.decoding='async';
    img.src=localImage(variation?.image||product.image);
    img.alt=String(product.name||'Sản phẩm BESI').slice(0,150);
    img.onerror=()=>{img.onerror=null;img.src='/besi-logo.svg';};
    button.append(img);button.addEventListener('click',()=>showDetail(product));
    const body=create('div','besi-spec-product-body');
    const title=create('button','besi-spec-product-title',product.name||'Sản phẩm BESI');
    title.type='button';title.addEventListener('click',()=>showDetail(product));
    const price=Number(variation?.price??product.price);
    const current=create('strong','besi-spec-product-price',money(price));
    body.append(title);
    if(unverified){
      article.classList.add('besi-spec-product-uncertain');
      const notice=create('span','besi-spec-uncertain-label','Chưa đủ thông số · kiểm tra trước khi mua');
      body.append(notice);
    }else if(variation){
      body.append(create('span','besi-spec-product-variant','Phân loại: '+String(variation.name||'').slice(0,100)));
    }
    body.append(current);
    const buy=create('button','besi-spec-product-buy',unverified?'Kiểm tra phân loại':variation?'Chọn phân loại này':'Xem và mua');
    buy.type='button';buy.addEventListener('click',()=>showDetail(product));
    body.append(buy);article.append(button,body);return article;
  }
  function update(){
    grid.replaceChildren(...stateUi.rows.map(card));
    const count=stateUi.rows.length;
    $('besiSpecStatus').textContent=stateUi.error||
      'Tìm được '+stateUi.total.toLocaleString('vi-VN')+' sản phẩm phù hợp trong danh mục. '
      +'Đang hiển thị '+count.toLocaleString('vi-VN')+' sản phẩm.';
    if(!count&&!stateUi.loading){
      grid.append(create('div','besi-spec-empty',
        stateUi.possibleTotal?
          'Chưa có sản phẩm xác minh đủ thông số. Xem mục “Có thể phù hợp” bên dưới để không bỏ sót mã hàng.':
          'Chưa có sản phẩm đáp ứng đủ thông số này. Hãy bỏ bớt lọc chiều dài, màu hoặc công suất.'));
    }
    loadMore.hidden=stateUi.loading||stateUi.page>=stateUi.totalPages||!stateUi.total;
    loadMore.disabled=stateUi.loading;
    loadMore.textContent=stateUi.loading?'Đang tải…':'Xem thêm sản phẩm ('+
      (stateUi.total-count).toLocaleString('vi-VN')+' còn lại)';
    if(possibleBox&&possibleGrid&&possibleMore){
      possibleBox.hidden=stateUi.possibleTotal===0;
      possibleGrid.replaceChildren(...stateUi.possibleRows.map(p=>card(p,true)));
      $('besiSpecPossibleStatus').textContent=stateUi.possibleTotal.toLocaleString('vi-VN')
        +' sản phẩm chưa có đủ thông số để khẳng định khớp chính xác. Hãy mở chi tiết xác nhận trước khi mua.';
      possibleMore.hidden=stateUi.possiblePage>=stateUi.possiblePages||!stateUi.possibleTotal;
      possibleMore.disabled=stateUi.possibleLoading||stateUi.loading;
    }
  }
  async function requestPage(seq,page){
    if(stateUi.loading||!stateUi.active)return;
    stateUi.loading=true;apply.disabled=true;loadMore.disabled=true;
    const params=new URLSearchParams({...stateUi.filter,page:String(page),limit:'24'});
    try{
      const response=await fetch('/api/products/specs?'+params.toString(),{credentials:'same-origin'});
      if(!response.ok)throw new Error(response.status===404?
        'Máy chủ chưa triển khai bộ chỉ mục mới':'Không tải được kết quả (HTTP '+response.status+')');
      const json=await response.json();
      if(seq!==stateUi.seq||!stateUi.active)return;
      if(!json.success||!Array.isArray(json.data))throw new Error('Dữ liệu tìm kiếm không hợp lệ');
      if(typeof rememberProducts==='function')rememberProducts(json.data);
      stateUi.page=Number(json.page)||page;
      stateUi.total=Number(json.total)||0;
      stateUi.totalPages=Number(json.totalPages)||1;
      stateUi.possibleTotal=Number(json.possibleTotal)||0;
      stateUi.possiblePages=Number(json.possiblePages)||1;
      if(page===1&&Array.isArray(json.possible)){
        stateUi.possibleRows=json.possible;
        stateUi.possiblePage=Number(json.possiblePage)||1;
      }
      if(page===1)stateUi.rows=[];
      const existing=new Set(stateUi.rows.map(p=>String(p.id)));
      for(const p of json.data){
        if(!existing.has(String(p.id))){stateUi.rows.push(p);existing.add(String(p.id));}
      }
      stateUi.error='';
    }catch(error){
      if(seq===stateUi.seq)stateUi.error=String(error.message||'Lỗi kết nối').slice(0,120);
    }finally{
      if(seq===stateUi.seq){
        stateUi.loading=false;apply.disabled=false;update();
      }
    }
  }
  async function loadPossible(){
    if(stateUi.loading||stateUi.possibleLoading||!stateUi.active
      ||stateUi.possiblePage>=stateUi.possiblePages)return;
    const seq=stateUi.seq, page=stateUi.possiblePage+1;
    stateUi.possibleLoading=true;
    possibleMore.disabled=true;
    const params=new URLSearchParams({...stateUi.filter,page:'1',possiblePage:String(page),limit:'24'});
    try{
      const response=await fetch('/api/products/specs?'+params.toString(),{credentials:'same-origin'});
      if(!response.ok)throw new Error('Không thể tải thêm sản phẩm chưa rõ thông số');
      const json=await response.json();
      if(seq!==stateUi.seq||!stateUi.active)return;
      if(!json.success||!Array.isArray(json.possible))throw new Error('Kết quả không hợp lệ');
      const seen=new Set(stateUi.possibleRows.map(x=>String(x.id)));
      for(const item of json.possible)if(!seen.has(String(item.id))){
        stateUi.possibleRows.push(item);seen.add(String(item.id));
      }
      stateUi.possiblePage=page;
    }catch(error){
      if(seq===stateUi.seq)stateUi.error=String(error.message||'Lỗi tải dữ liệu');
    }finally{
      if(seq===stateUi.seq){stateUi.possibleLoading=false;update();}
    }
  }
  function exit(){
    stateUi.seq++;stateUi.active=false;stateUi.loading=false;
    results.hidden=true;
    $('catalog').classList.remove('besi-filter-mode');
    root.querySelector('input[name="besiConnector"][value="c-lightning"]').checked=true;
    root.querySelector('input[name="besiLength"][value=""]').checked=true;
    root.querySelector('input[name="besiWatt"][value=""]').checked=true;
    $('besiSpecColor').value='';
  }
  function run(){
    window.dispatchEvent(new CustomEvent('besi:cable-filters-start'));
    stateUi.seq++;stateUi.active=true;stateUi.page=0;stateUi.total=0;
    stateUi.totalPages=1;stateUi.rows=[];stateUi.error='';stateUi.loading=false;
    stateUi.possibleTotal=0;stateUi.possiblePage=0;stateUi.possiblePages=1;
    stateUi.possibleRows=[];stateUi.possibleLoading=false;
    if(possibleBox)possibleBox.hidden=true;
    stateUi.filter=form();
    results.hidden=false;
    $('catalog').classList.add('besi-filter-mode');
    $('besiSpecResultsTitle').textContent=(NAMES[stateUi.filter.type]||'Cáp sạc')
      +(Number(stateUi.filter.length)?' · '+stateUi.filter.length.replace('.',',')+'m':'')
      +(Number(stateUi.filter.power)?' · '+stateUi.filter.power+'W':'');
    $('besiSpecStatus').textContent='Đang tìm trên toàn bộ danh mục BESI…';
    grid.replaceChildren();
    results.scrollIntoView({behavior:'smooth',block:'start'});
    requestPage(stateUi.seq,1);
  }
  apply.addEventListener('click',run);
  loadMore.addEventListener('click',()=>{if(!stateUi.loading)requestPage(stateUi.seq,stateUi.page+1);});
  possibleMore?.addEventListener('click',loadPossible);
  $('besiExitSpecs').addEventListener('click',exit);
  $('besiResetSpecs').addEventListener('click',()=>{
    exit();$('productGrid')?.scrollIntoView({behavior:'smooth',block:'start'});
  });
  document.addEventListener('click',event=>{
    if(!stateUi.active||event.isTrusted===false)return;
    if(event.target.closest('#searchBtn,.cat-btn,.brand-pill,.price-pill,[data-store-action],.market-links a,#btnLoadMore'))exit();
  },true);
  $('searchInput')?.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&stateUi.active)exit();
  },true);
  window.addEventListener('besi:category-filters-start',()=>{if(stateUi.active)exit();});
  window.addEventListener('popstate',()=>{if(stateUi.active)exit();});
})();
