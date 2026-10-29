/* BESI accessory filters — fully indexed server search, original order flow. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const root=$('besiCategoryFinder'),output=$('besiCategoryResults');
  if(!root||!output)return;
  const names={case:'Ốp lưng điện thoại',charger:'Củ sạc nhanh',powerbank:'Pin dự phòng'};
  const stateUi={category:'case',active:false,seq:0,page:0,total:0,pages:1,
    possiblePage:0,possibleTotal:0,possiblePages:1,rows:[],possible:[],
    loading:false,loadingPossible:false,error:'',filter:null};
  const els={
    grid:$('besiCategoryGrid'),status:$('besiCategoryStatus'),title:$('besiCategoryResultsTitle'),
    more:$('besiCategoryMore'),possibleBox:$('besiCategoryPossible'),
    possibleGrid:$('besiCategoryPossibleGrid'),possibleStatus:$('besiCategoryPossibleStatus'),
    possibleMore:$('besiCategoryPossibleMore'),apply:$('besiCategoryApply')
  };
  const create=(tag,cls,text)=>{
    const el=document.createElement(tag);
    if(cls)el.className=cls;
    if(text!==undefined)el.textContent=String(text);
    return el;
  };
  const imgSrc=v=>{
    const s=String(v||'');
    return /^\/(?:cdn\/|api\/catalog-image\/|images\/)[a-z0-9/_.?=&%-]+$/i.test(s)
      &&!s.includes('..')?s:'/besi-logo.svg';
  };
  const money=v=>Number(v).toLocaleString('vi-VN')+'đ';
  function form(){
    return {
      category:stateUi.category,
      model:stateUi.category==='case'?$('besiCaseModel').value:'',
      watt:stateUi.category==='charger'?$('besiChargerWatt').value:
        stateUi.category==='powerbank'?$('besiPowerbankWatt').value:'',
      capacity:stateUi.category==='powerbank'?$('besiPowerbankCapacity').value:'',
      color:$('besiCategoryColor').value
    };
  }
  const dynamicLoaded=new Set();
  function modelLabel(value){
    if(value.startsWith('iphone-'))return 'iPhone '+value.slice(7).replace(/-/g,' ')
      .replace(/\b(pro|max|plus|mini|air)\b/gi,w=>w[0].toUpperCase()+w.slice(1));
    return value.replace(/^samsung-/,'Galaxy ').replace(/-/g,' ')
      .replace(/\b(s|a)(\d+)/,(_,family,num)=>family.toUpperCase()+num)
      .replace(/\b(ultra|plus)\b/gi,w=>w[0].toUpperCase()+w.slice(1))
      .replace(/\bfe\b/gi,'FE');
  }
  function addOptions(selectId,values,label){
    const select=$(selectId);if(!select||!Array.isArray(values))return;
    const known=new Set([...select.options].map(x=>x.value));
    const fresh=values.filter(v=>!known.has(String(v))).slice(0,500);
    if(!fresh.length)return;
    const group=document.createElement('optgroup');
    group.label='Mẫu có nhắc đến trong danh mục BESI';
    for(const value of fresh){
      const option=document.createElement('option');
      option.value=String(value);option.textContent=label(value);group.append(option);
    }
    select.append(group);
  }
  async function loadDynamicOptions(category){
    if(dynamicLoaded.has(category))return;
    try{
      const response=await fetch('/api/products/category-facets?'+
        new URLSearchParams({category}),{credentials:'same-origin'});
      if(!response.ok)return; // Older servers preserve existing fallback choices.
      const data=await response.json();
      if(!data.success||data.category!==category)return;
      if(category==='case')addOptions('besiCaseModel',data.models,modelLabel);
      if(category==='charger')addOptions('besiChargerWatt',data.watts,v=>v+'W');
      if(category==='powerbank'){
        addOptions('besiPowerbankWatt',data.watts,v=>v+'W');
        addOptions('besiPowerbankCapacity',data.capacities,v=>Number(v).toLocaleString('vi-VN')+'mAh');
      }
      dynamicLoaded.add(category);
    }catch(_){/* static options remain available when offline */}
  }
  function switchCategory(category){
    if(!Object.hasOwn(names,category))return;
    if(stateUi.active&&stateUi.category!==category)exit();
    stateUi.category=category;
    for(const b of root.querySelectorAll('[data-besi-category]'))
      b.setAttribute('aria-pressed',String(b.dataset.besiCategory===category));
    $('besiCaseModelBox').hidden=category!=='case';
    $('besiChargerWattBox').hidden=category!=='charger';
    $('besiPowerbankCapacityBox').hidden=category!=='powerbank';
    $('besiPowerbankWattBox').hidden=category!=='powerbank';
    loadDynamicOptions(category);
  }
  async function detail(product,unverified=false){
    const id=Number(product.id);
    if(!Number.isSafeInteger(id)||id<1||typeof openProductDetail!=='function')return;
    await openProductDetail(id);
    const v=product.matched_variant;
    if(!unverified&&product.verified_spec!==false&&v&&typeof pickVariant==='function'){
      const current=typeof state!=='undefined'?state.activeDetailProduct:null;
      const actual=(current?.variants||[]).find(x=>String(x.id)===String(v.id)&&x.in_stock!==false);
      if(actual)pickVariant(actual.id);
    }
  }
  function card(p,unverified=false){
    const article=create('article','besi-spec-product luxury-card');
    if(unverified)article.classList.add('besi-spec-product-uncertain');
    const photo=create('button','besi-spec-product-image');
    photo.type='button';
    photo.setAttribute('aria-label','Xem '+String(p.name||'sản phẩm').slice(0,95));
    const image=create('img');image.loading='lazy';image.decoding='async';
    image.src=imgSrc(p.matched_variant?.image||p.image);
    image.alt=String(p.name||'Sản phẩm BESI').slice(0,150);
    image.onerror=()=>{image.onerror=null;image.src='/besi-logo.svg';};
    photo.append(image);
    photo.addEventListener('click',()=>detail(p,unverified).catch(()=>{}));
    const body=create('div','besi-spec-product-body');
    const title=create('button','besi-spec-product-title',p.name||'Sản phẩm BESI');
    title.type='button';title.addEventListener('click',()=>detail(p,unverified).catch(()=>{}));
    body.append(title);
    if(unverified){
      body.append(create('span','besi-spec-uncertain-label',
        'Chưa rõ thông số — kiểm tra phân loại'));
    }else if(p.matched_variant){
      body.append(create('span','besi-spec-product-variant',
        'Phân loại: '+String(p.matched_variant.name||'').slice(0,90)));
    }
    body.append(create('strong','besi-spec-product-price',
      money(p.matched_variant?.price??p.price)));
    const buy=create('button','besi-spec-product-buy',unverified?'Kiểm tra phân loại':'Xem và mua');
    buy.type='button';buy.addEventListener('click',()=>detail(p,unverified).catch(()=>{}));
    body.append(buy);
    article.append(photo,body);return article;
  }
  function paint(){
    els.grid.replaceChildren(...stateUi.rows.map(p=>card(p)));
    els.status.textContent=stateUi.error||
      ('Tìm được '+stateUi.total.toLocaleString('vi-VN')+' sản phẩm khớp thông số đã ghi. '+
       'Đang xem '+stateUi.rows.length.toLocaleString('vi-VN')+' sản phẩm.');
    if(!stateUi.rows.length&&!stateUi.loading)
      els.grid.append(create('div','besi-spec-empty',
        stateUi.possibleTotal?'Chưa có kết quả đủ thông số. Kiểm tra nhóm có thể phù hợp bên dưới.':
          'Chưa tìm được hàng theo lựa chọn này. Thử bỏ bớt một điều kiện lọc.'));
    els.more.hidden=stateUi.loading||stateUi.page>=stateUi.pages||!stateUi.total;
    els.more.disabled=stateUi.loading;
    els.possibleBox.hidden=!stateUi.possibleTotal;
    els.possibleGrid.replaceChildren(...stateUi.possible.map(p=>card(p,true)));
    els.possibleStatus.textContent=stateUi.possibleTotal.toLocaleString('vi-VN')+
      ' sản phẩm chưa rõ hết thông số, cần xem chi tiết trước khi mua.';
    els.possibleMore.hidden=!stateUi.possibleTotal||
      stateUi.possiblePage>=stateUi.possiblePages;
    els.possibleMore.disabled=stateUi.loadingPossible;
  }
  async function requestPage(page,kind='matched'){
    if(!stateUi.active||stateUi.loading||stateUi.loadingPossible)return;
    const seq=stateUi.seq;
    if(kind==='possible')stateUi.loadingPossible=true;
    else stateUi.loading=true;
    els.apply.disabled=true;
    const options={...stateUi.filter,limit:'24',
      page:String(kind==='possible'?1:page),
      possiblePage:String(kind==='possible'?page:1)};
    try{
      const res=await fetch('/api/products/category-specs?'+new URLSearchParams(options),{
        credentials:'same-origin'
      });
      if(!res.ok)throw Error(res.status===404?'Máy chủ chưa triển khai bộ lọc ngành hàng':
        'Lỗi tải danh mục (HTTP '+res.status+')');
      const json=await res.json();
      if(seq!==stateUi.seq||!stateUi.active)return;
      if(!json.success||!Array.isArray(json.data)||!Array.isArray(json.possible))
        throw Error('Dữ liệu bộ lọc chưa hợp lệ');
      if(kind==='matched'){
        if(typeof rememberProducts==='function')rememberProducts(json.data);
        const seen=new Set(stateUi.rows.map(p=>String(p.id)));
        for(const product of json.data)if(!seen.has(String(product.id))){
          stateUi.rows.push(product);seen.add(String(product.id));
        }
        stateUi.page=Number(json.page)||page;
        stateUi.total=Number(json.total)||0;
        stateUi.pages=Number(json.totalPages)||1;
        if(page===1){
          stateUi.possible=json.possible;
          stateUi.possibleTotal=Number(json.possibleTotal)||0;
          stateUi.possiblePages=Number(json.possiblePages)||1;
          stateUi.possiblePage=1;
        }
      }else{
        const seen=new Set(stateUi.possible.map(p=>String(p.id)));
        for(const product of json.possible)if(!seen.has(String(product.id))){
          stateUi.possible.push(product);seen.add(String(product.id));
        }
        stateUi.possiblePage=Number(json.possiblePage)||page;
      }
      stateUi.error='';
    }catch(e){
      if(seq===stateUi.seq)stateUi.error=String(e.message||'Lỗi kết nối');
    }finally{
      if(seq===stateUi.seq){
        stateUi.loading=false;stateUi.loadingPossible=false;
        els.apply.disabled=false;paint();
      }
    }
  }
  function exit(){
    stateUi.seq++;stateUi.active=false;stateUi.loading=false;
    stateUi.loadingPossible=false;output.hidden=true;
    $('catalog')?.classList.remove('besi-filter-mode');
  }
  function run(){
    window.dispatchEvent(new CustomEvent('besi:category-filters-start'));
    stateUi.seq++;stateUi.active=true;
    stateUi.page=0;stateUi.pages=1;stateUi.rows=[];stateUi.total=0;
    stateUi.possiblePage=0;stateUi.possiblePages=1;stateUi.possibleTotal=0;
    stateUi.possible=[];stateUi.error='';stateUi.loading=false;
    stateUi.loadingPossible=false;stateUi.filter=form();
    output.hidden=false;
    $('catalog')?.classList.add('besi-filter-mode');
    const extras=stateUi.filter.model||stateUi.filter.watt&&stateUi.filter.watt+'W'
      ||stateUi.filter.capacity&&Number(stateUi.filter.capacity).toLocaleString('vi-VN')+'mAh'||'';
    els.title.textContent=names[stateUi.category]+(extras?' · '+extras.replaceAll('-',' '):'');
    els.status.textContent='Đang tìm trên danh mục BESI…';
    els.grid.replaceChildren();els.possibleBox.hidden=true;
    output.scrollIntoView({behavior:'smooth',block:'start'});
    requestPage(1);
  }
  root.querySelectorAll('[data-besi-category]').forEach(b=>{
    b.addEventListener('click',()=>switchCategory(b.dataset.besiCategory));
  });
  els.apply.addEventListener('click',run);
  els.more.addEventListener('click',()=>requestPage(stateUi.page+1));
  els.possibleMore.addEventListener('click',()=>requestPage(stateUi.possiblePage+1,'possible'));
  $('besiCategoryExit').addEventListener('click',()=>{exit();$('productGrid')?.scrollIntoView({behavior:'smooth'});});
  window.addEventListener('besi:cable-filters-start',()=>{if(stateUi.active)exit();});
  document.addEventListener('click',event=>{
    if(!stateUi.active||event.isTrusted===false)return;
    if(event.target.closest('#searchBtn,.cat-btn,.brand-pill,.price-pill,[data-store-action],.market-links a,#btnLoadMore'))exit();
  },true);
  $('searchInput')?.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&stateUi.active)exit();
  },true);
  window.addEventListener('besi:universal-filters-start',()=>{if(stateUi.active)exit();});
  window.addEventListener('popstate',()=>{if(stateUi.active)exit();});
  switchCategory('case');
})();
