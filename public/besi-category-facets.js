/* BESI product-specific filters for cases, chargers and power banks.
 * Existing cable facet finder is preserved and does not share mutable state.
 */
(()=>{
 'use strict';
 const $=id=>document.getElementById(id);
 const tabs=$('besiFacetTabs'),panel=$('besiCategoryFacet');
 if(!tabs||!panel)return;
 const groupNames={cases:'Ốp lưng theo dòng máy',chargers:'Củ sạc theo công suất',powerbanks:'Pin dự phòng theo dung lượng'};
 const categoryParam={cases:'Dòng điện thoại',chargers:'Công suất đầu ra',powerbanks:'Dung lượng pin'};
 const stateUi={category:'cables',requestId:0,loading:false,possibleLoading:false,page:0,
   totalPages:1,total:0,rows:[],possibleRows:[],possiblePage:0,possiblePages:1,
   possibleTotal:0,error:'',selection:'',options:{}};
 const money=n=>Number(n).toLocaleString('vi-VN')+'đ';
 const el=(tag,className,text)=>{
   const node=document.createElement(tag);
   if(className)node.className=className;
   if(text!==undefined)node.textContent=String(text);
   return node;
 };
 const imageUrl=value=>{
   const s=String(value||'');
   return /^\/(?:cdn\/|api\/catalog-image\/|images\/)[a-z0-9/_.,?=&%-]+$/i.test(s)
     &&!s.includes('..')?s:'/besi-logo.svg';
 };
 const nameOf=(category,value)=>{
   if(category==='cases'){
     const match=/^iphone-(\d{2})(?:-(.*))?$/.exec(value);
     if(match)return 'iPhone '+match[1]+(match[2]?' '+match[2].replace(/-/g,' ').replace(/\b\w/g,l=>l.toUpperCase()):'');
     return value.replace(/^galaxy-/,'Samsung Galaxy ').replace(/-/g,' ').replace(/(s|a)(\d+)/,(_,a,n)=>a.toUpperCase()+n)
       .replace(/\b(ultra|plus|fe)\b/gi,s=>s.toUpperCase()==='FE'?'FE':s[0].toUpperCase()+s.slice(1));
   }
   if(category==='chargers')return value+'W';
   if(category==='powerbanks')return Number(value).toLocaleString('vi-VN')+'mAh';
   return value;
 };
 async function showDetail(p,possible){
   const id=Number(p.id);
   if(!Number.isSafeInteger(id)||id<1||typeof openProductDetail!=='function')return;
   try{
     await openProductDetail(id);
     if(!possible&&p.matched_variant&&typeof pickVariant==='function'){
       const v=(typeof state!=='undefined'&&state.activeDetailProduct?.variants||[])
          .find(x=>String(x.id)===String(p.matched_variant.id)&&x.in_stock!==false);
       if(v)pickVariant(v.id);
     }
   }catch(err){console.error('BESI: không mở được chi tiết sản phẩm',err);}
 }
 function card(p,possible){
   const item=el('article','besi-spec-product luxury-card');
   if(possible)item.classList.add('besi-spec-product-uncertain');
   const cover=el('button','besi-spec-product-image');
   cover.type='button';
   cover.setAttribute('aria-label','Xem '+String(p.name||'sản phẩm').slice(0,90));
   const img=el('img');
   img.loading='lazy';img.decoding='async';img.alt=String(p.name||'Sản phẩm BESI').slice(0,140);
   img.src=imageUrl(p.matched_variant?.image||p.image);
   img.onerror=()=>{img.onerror=null;img.src='/besi-logo.svg';};
   cover.append(img);cover.addEventListener('click',()=>showDetail(p,possible));
   const content=el('div','besi-spec-product-body');
   const title=el('button','besi-spec-product-title',p.name||'Sản phẩm BESI');
   title.type='button';title.addEventListener('click',()=>showDetail(p,possible));
   content.append(title);
   if(possible)content.append(el('span','besi-spec-uncertain-label','Chưa rõ thông số — kiểm tra từng phân loại'));
   else if(p.matched_variant)content.append(el('span','besi-spec-product-variant','Phân loại: '+String(p.matched_variant.name||'').slice(0,80)));
   const price=el('strong','besi-spec-product-price',money(p.matched_variant?.price??p.price));
   content.append(price);
   if(possible)content.append(el('small','besi-spec-uncertain-price-note','Giá hiển thị có thể khác theo phân loại.'));
   const buy=el('button','besi-spec-product-buy',possible?'Kiểm tra phân loại':'Xem và mua');
   buy.type='button';buy.addEventListener('click',()=>showDetail(p,possible));
   content.append(buy);item.append(cover,content);
   return item;
 }
 function render(){
   $('besiCategoryResultGrid').replaceChildren(...stateUi.rows.map(p=>card(p,false)));
   $('besiCategoryResultStatus').textContent=stateUi.error||
     'Tìm thấy '+stateUi.total.toLocaleString('vi-VN')+' sản phẩm đã nhận diện. Hiển thị '+
     stateUi.rows.length.toLocaleString('vi-VN')+' kết quả.';
   if(!stateUi.rows.length&&!stateUi.loading){
     $('besiCategoryResultGrid').append(el('div','besi-spec-empty',
       stateUi.possibleTotal?'Chưa có mã xác minh đủ thông số. Xem hàng có thể phù hợp bên dưới.':
         'Chưa có kết quả phù hợp. Hãy thử chọn Tất cả thông số.'));
   }
   $('besiCategoryResultMore').hidden=stateUi.loading||stateUi.page>=stateUi.totalPages||!stateUi.total;
   const box=$('besiCategoryPossible');
   box.hidden=stateUi.possibleTotal===0;
   $('besiCategoryPossibleGrid').replaceChildren(...stateUi.possibleRows.map(p=>card(p,true)));
   $('besiCategoryPossibleStatus').textContent=stateUi.possibleTotal.toLocaleString('vi-VN')+
     ' sản phẩm chưa có đủ dữ liệu để xác nhận. Xem chi tiết và chọn đúng phân loại trước khi mua.';
   $('besiCategoryPossibleMore').hidden=stateUi.possiblePage>=stateUi.possiblePages||!stateUi.possibleTotal;
 }
 async function optionsFor(category){
   if(stateUi.options[category])return stateUi.options[category];
   const res=await fetch('/api/products/category-facets?'+new URLSearchParams({category}),{credentials:'same-origin'});
   if(!res.ok)throw Error(res.status===404?'Máy chủ BESI chưa cập nhật bộ lọc mới':'Không thể lấy thông số ('+res.status+')');
   const obj=await res.json();
   if(!obj.success||!Array.isArray(obj.values))throw Error('Dữ liệu thông số không hợp lệ');
   stateUi.options[category]=obj;return obj;
 }
 async function switchCategory(category){
   const isCables=category==='cables',requestId=++stateUi.requestId;
   stateUi.category=category;
   stateUi.rows=[];stateUi.possibleRows=[];stateUi.loading=false;
   $('besiExitSpecs')?.click(); // Restore the ordinary catalog if a cable search is active.
   for(const tab of tabs.querySelectorAll('button[data-besi-facet-category]')){
     const active=tab.dataset.besiFacetCategory===category;
     tab.classList.toggle('is-current',active);tab.setAttribute('aria-pressed',String(active));
   }
   $('besiSpecFinder').hidden=!isCables;
   $('besiSpecResults').hidden=true;
   panel.hidden=isCables;
   $('besiCategoryFacetResults').hidden=true;
   $('catalog').classList.remove('besi-filter-mode');
   if(isCables)return;
   $('besiCategoryFacetTitle').textContent=groupNames[category];
   $('besiFacetValueLabel').textContent=categoryParam[category];
   $('besiFacetScope').textContent='Đang đọc danh mục…';
   const select=$('besiFacetValue');select.replaceChildren();
   const option=el('option','', 'Tất cả');option.value='';select.append(option);
   try{
     const data=await optionsFor(category);
     if(requestId!==stateUi.requestId)return;
     $('besiFacetScope').textContent=data.productCount.toLocaleString('vi-VN')+' sản phẩm trong ngành hàng';
     for(const value of data.values){
       const opt=el('option','',nameOf(category,String(value)));
       opt.value=String(value);select.append(opt);
     }
   }catch(err){
     if(requestId===stateUi.requestId)$('besiFacetScope').textContent=err.message;
   }
 }
 async function loadPage(page=1){
   if(stateUi.loading||stateUi.category==='cables')return;
   stateUi.loading=true;
   const req=stateUi.requestId;
   $('besiFacetApply').disabled=true;
   const params=new URLSearchParams({category:stateUi.category,value:stateUi.selection,page:String(page),limit:'24'});
   try{
     const res=await fetch('/api/products/category-specs?'+params,{credentials:'same-origin'});
     if(!res.ok)throw Error(res.status===404?'Máy chủ chưa cập nhật bộ lọc mới':'Không thể lấy kết quả ('+res.status+')');
     const data=await res.json();
     if(req!==stateUi.requestId)return;
     if(!data.success||!Array.isArray(data.data))throw Error('Kết quả trả về không hợp lệ');
     stateUi.total=Number(data.total)||0;stateUi.totalPages=Number(data.totalPages)||1;
     stateUi.page=Number(data.page)||page;
     if(page===1){stateUi.rows=[];stateUi.possibleRows=Array.isArray(data.possible)?data.possible:[];
       stateUi.possiblePage=Number(data.possiblePage)||1;
       stateUi.possiblePages=Number(data.possiblePages)||1;
       stateUi.possibleTotal=Number(data.possibleTotal)||0;}
     const seen=new Set(stateUi.rows.map(x=>String(x.id)));
     for(const p of data.data)if(!seen.has(String(p.id))){
       stateUi.rows.push(p);seen.add(String(p.id));
     }
     stateUi.error='';
   }catch(err){if(req===stateUi.requestId)stateUi.error=String(err.message||'Lỗi kết nối');}
   finally{if(req===stateUi.requestId){stateUi.loading=false;$('besiFacetApply').disabled=false;render();}}
 }
 async function loadPossible(){
   if(stateUi.possibleLoading||stateUi.category==='cables'||stateUi.possiblePage>=stateUi.possiblePages)return;
   const req=stateUi.requestId,page=stateUi.possiblePage+1;
   stateUi.possibleLoading=true;
   $('besiCategoryPossibleMore').disabled=true;
   try{
     const params=new URLSearchParams({category:stateUi.category,value:stateUi.selection,page:'1',
       possiblePage:String(page),limit:'24'});
     const res=await fetch('/api/products/category-specs?'+params,{credentials:'same-origin'});
     if(!res.ok)throw Error('Không thể xem thêm');
     const data=await res.json();
     if(req!==stateUi.requestId)return;
     const seen=new Set(stateUi.possibleRows.map(x=>String(x.id)));
     for(const p of data.possible||[])if(!seen.has(String(p.id))){
       seen.add(String(p.id));stateUi.possibleRows.push(p);
     }
     stateUi.possiblePage=page;stateUi.error='';
   }catch(err){if(req===stateUi.requestId)stateUi.error=String(err.message||'Lỗi kết nối');}
   finally{if(req===stateUi.requestId){stateUi.possibleLoading=false;
     $('besiCategoryPossibleMore').disabled=false;render();}}
 }
 function apply(){
   if(stateUi.category==='cables')return;
   stateUi.requestId++;stateUi.page=0;stateUi.total=0;stateUi.totalPages=1;
   stateUi.rows=[];stateUi.possibleRows=[];stateUi.possibleTotal=0;stateUi.possiblePage=0;
   stateUi.possiblePages=1;stateUi.error='';stateUi.loading=false;stateUi.selection=$('besiFacetValue').value;
   $('besiCategoryResultTitle').textContent=groupNames[stateUi.category]+
     (stateUi.selection?' · '+nameOf(stateUi.category,stateUi.selection):'');
   $('besiCategoryFacetResults').hidden=false;
   $('catalog').classList.add('besi-filter-mode');
   $('besiCategoryResultStatus').textContent='Đang tìm trên toàn bộ danh mục BESI…';
   $('besiCategoryResultGrid').replaceChildren();
   $('besiCategoryPossible').hidden=true;
   $('besiCategoryFacetResults').scrollIntoView({behavior:'smooth',block:'start'});
   loadPage(1);
 }
 tabs.addEventListener('click',event=>{
   const button=event.target.closest('button[data-besi-facet-category]');
   if(button)switchCategory(button.dataset.besiFacetCategory);
 });
 $('besiFacetApply').addEventListener('click',apply);
 $('besiCategoryResultMore').addEventListener('click',()=>loadPage(stateUi.page+1));
 $('besiCategoryPossibleMore').addEventListener('click',loadPossible);
 $('besiFacetReset').addEventListener('click',()=>{
   switchCategory('cables');$('productGrid')?.scrollIntoView({behavior:'smooth',block:'start'});
 });
 document.addEventListener('click',event=>{
   if(stateUi.category==='cables'||event.isTrusted===false)return;
   if(event.target.closest('#searchBtn,.cat-btn,.brand-pill,.price-pill,[data-store-action],.market-links a,#btnLoadMore'))
     switchCategory('cables');
 },true);
 $('searchInput')?.addEventListener('keydown',event=>{
   if(event.key==='Enter'&&stateUi.category!=='cables')switchCategory('cables');
 },true);
 window.addEventListener('popstate',()=>{if(stateUi.category!=='cables')switchCategory('cables');});
})();
