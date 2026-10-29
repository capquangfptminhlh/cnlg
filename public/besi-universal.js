/* BESI universal multi-industry buyer search.
 * Public first-party product APIs only, no supplier feed scraping.
 */
(()=>{
 'use strict';
 const $=id=>document.getElementById(id);
 const root=$('besiUniversalFinder'),result=$('besiUniversalResults');
 if(!root||!result)return;
 const attrLabels={
   model:'Dòng máy',length:'Chiều dài',watt:'Công suất',capacity:'Dung lượng pin',
   color:'Màu sắc',size:'Kích cỡ',material:'Chất liệu',storage:'Bộ nhớ',
   ram:'RAM',connector:'Đầu kết nối'
 };
 const colorLabels={den:'Đen',trang:'Trắng',xanh:'Xanh',do:'Đỏ',hong:'Hồng',
   vang:'Vàng',tim:'Tím',xam:'Xám',nau:'Nâu',cam:'Cam'};
 const materialLabels={silicone:'Silicone',tpu:'TPU',cotton:'Cotton',leather:'Da thật',
   pu:'Da PU',plastic:'Nhựa',metal:'Kim loại',glass:'Kính',wood:'Gỗ',
   polyester:'Polyester',nylon:'Nylon'};
 const stateUi={active:false,requestId:0,optionsId:0,loading:false,
   page:0,pages:1,total:0,rows:[],possiblePage:0,possiblePages:1,
   possibleTotal:0,possible:[],loadingPossible:false,filter:null,error:''};
 const make=(tag,cls,text)=>{
   const e=document.createElement(tag);if(cls)e.className=cls;
   if(text!==undefined)e.textContent=String(text);return e;
 };
 const valueLabel=(key,val)=>{
   if(key==='color')return colorLabels[val]||val;
   if(key==='material')return materialLabels[val]||val;
   if(key==='length')return String(val).replace('.',',')+'m';
   if(key==='watt')return val+'W';
   if(key==='capacity')return Number(val).toLocaleString('vi-VN')+'mAh';
   if(key==='model')return val.replace('iphone-','iPhone ').replace('samsung-','Samsung ')
      .replace(/-/g,' ').replace(/\b(pro|max|ultra|plus|mini|air)\b/gi,t=>t[0].toUpperCase()+t.slice(1));
   if(key==='connector')return {'c-lightning':'USB-C → Lightning','a-lightning':'USB-A → Lightning',
     'c-c':'USB-C → USB-C','a-c':'USB-A → USB-C','lightning':'Lightning'}[val]||val;
   return String(val).toUpperCase();
 };
 const selectOptions=(el,options,blankLabel,formatter)=>{
   const current=el.value;
   const base=make('option','',blankLabel);base.value='';
   const fragment=document.createDocumentFragment();fragment.append(base);
   for(const item of options){
     const option=make('option','',formatter(item));
     option.value=String(item.value??item.id);
     fragment.append(option);
   }
   el.replaceChildren(fragment);
   el.value=[...el.options].some(o=>o.value===current)?current:'';
 };
 const formatMoney=x=>Number(x).toLocaleString('vi-VN')+'đ';
 const safeImage=x=>{
   const s=String(x||'');
   return /^\/(?:cdn\/|api\/catalog-image\/|images\/)[a-z0-9/_.?=&%-]+$/i.test(s)
     &&!s.includes('..')?s:'/besi-logo.svg';
 };
 async function detail(p,uncertain){
   if(typeof openProductDetail!=='function')return;
   const id=Number(p.id);if(!Number.isSafeInteger(id)||id<1)return;
   try{
     await openProductDetail(id);
     if(!uncertain&&p.matched_variant&&typeof pickVariant==='function'){
       const actual=(typeof state!=='undefined'&&state.activeDetailProduct?.variants||[])
         .find(x=>String(x.id)===String(p.matched_variant.id)&&x.in_stock!==false);
       if(actual)pickVariant(actual.id);
     }
   }catch(e){console.error('BESI: lỗi mở sản phẩm',e);}
 }
 function productCard(p,uncertain=false){
   const el=make('article','besi-spec-product luxury-card');
   if(uncertain)el.classList.add('besi-spec-product-uncertain');
   const imageButton=make('button','besi-spec-product-image');
   imageButton.type='button';
   imageButton.setAttribute('aria-label','Xem chi tiết '+String(p.name||'sản phẩm').slice(0,100));
   const image=make('img');image.loading='lazy';image.decoding='async';
   image.alt=String(p.name||'Sản phẩm BESI').slice(0,150);
   image.src=safeImage(p.matched_variant?.image||p.image);
   image.onerror=()=>{image.onerror=null;image.src='/besi-logo.svg';};
   imageButton.append(image);
   imageButton.addEventListener('click',()=>detail(p,uncertain));
   const body=make('div','besi-spec-product-body');
   const name=make('button','besi-spec-product-title',p.name||'Sản phẩm BESI');
   name.type='button';name.addEventListener('click',()=>detail(p,uncertain));body.append(name);
   if(uncertain){
     body.append(make('span','besi-spec-uncertain-label','Cần kiểm tra phân loại và thông số'));
   }else if(p.matched_variant){
     body.append(make('span','besi-spec-product-variant',
       'Phân loại: '+String(p.matched_variant.name||'').slice(0,90)));
   }
   body.append(make('strong','besi-spec-product-price',
     formatMoney(p.matched_variant?.price??p.price)));
   if(uncertain)body.append(make('small','besi-universal-price-note',
     'Giá chính xác phụ thuộc phân loại.'));
   const buy=make('button','besi-spec-product-buy',uncertain?'Kiểm tra phân loại':'Xem và mua');
   buy.type='button';buy.addEventListener('click',()=>detail(p,uncertain));body.append(buy);
   el.append(imageButton,body);return el;
 }
 function formValues(){
   return {q:$('besiUniversalQuery').value.trim(),category:$('besiUniversalCategory').value,
     brand:$('besiUniversalBrand').value,attr:$('besiUniversalAttribute').value,
     value:$('besiUniversalValue').value,minPrice:$('besiUniversalMin').value,
     maxPrice:$('besiUniversalMax').value,sort:$('besiUniversalSort').value};
 }
 function paint(){
   $('besiUniversalGrid').replaceChildren(...stateUi.rows.map(p=>productCard(p)));
   $('besiUniversalStatus').textContent=stateUi.error||
     ('Tìm được '+stateUi.total.toLocaleString('vi-VN')+' sản phẩm phù hợp. Hiển thị '+
       stateUi.rows.length.toLocaleString('vi-VN')+' sản phẩm.');
   if(!stateUi.rows.length&&!stateUi.loading){
     $('besiUniversalGrid').append(make('div','besi-spec-empty',
       stateUi.possibleTotal?'Chưa có sản phẩm đủ thông số, hãy xem nhóm cần kiểm tra bên dưới.':
       'Chưa thấy sản phẩm khớp. Hãy thử tìm tên khác, bỏ điều kiện giá hoặc chọn tất cả ngành hàng.'));
   }
   $('besiUniversalMore').hidden=stateUi.loading||stateUi.page>=stateUi.pages||!stateUi.total;
   $('besiUniversalMore').disabled=stateUi.loading;
   const possible=$('besiUniversalPossible');
   possible.hidden=!stateUi.possibleTotal;
   $('besiUniversalPossibleGrid').replaceChildren(...stateUi.possible.map(p=>productCard(p,true)));
   $('besiUniversalPossibleStatus').textContent=
     stateUi.possibleTotal.toLocaleString('vi-VN')+
     ' sản phẩm có thể phù hợp nhưng thiếu dữ liệu để khẳng định chính xác.';
   $('besiUniversalPossibleMore').hidden=stateUi.possiblePage>=stateUi.possiblePages
     ||!stateUi.possibleTotal;
   $('besiUniversalPossibleMore').disabled=stateUi.loadingPossible;
 }
 async function loadOptions(){
   const seq=++stateUi.optionsId;
   const params=new URLSearchParams({
     q:$('besiUniversalQuery').value.trim(),
     category:$('besiUniversalCategory').value||'0'
   });
   $('besiUniversalHint').textContent='Đang đọc thông số từ danh mục BESI…';
   try{
     const response=await fetch('/api/products/discover/options?'+params,{credentials:'same-origin'});
     if(!response.ok)throw Error(response.status===404?'Máy chủ chưa triển khai tìm kiếm toàn ngành':
       'Không thể tải thông số ('+response.status+')');
     const json=await response.json();
     if(seq!==stateUi.optionsId)return;
     if(!json.success||!Array.isArray(json.categories)||!json.facets)throw Error('Danh mục chưa hợp lệ');
     selectOptions($('besiUniversalCategory'),json.categories,'Tất cả ngành hàng',
       x=>x.name+' ('+x.count.toLocaleString('vi-VN')+')');
     selectOptions($('besiUniversalBrand'),json.brands||[],'Tất cả thương hiệu',
       x=>x.value+' ('+x.count.toLocaleString('vi-VN')+')');
     const available=Object.keys(attrLabels).filter(key=>Array.isArray(json.facets[key])&&json.facets[key].length);
     selectOptions($('besiUniversalAttribute'),
       available.map(key=>({value:key})),
       'Chọn thông số (nếu có)',x=>attrLabels[x.value]);
     const key=$('besiUniversalAttribute').value;
     selectOptions($('besiUniversalValue'),key?json.facets[key]:[],'Tất cả',
       x=>valueLabel(key,x.value)+' ('+x.count.toLocaleString('vi-VN')+')');
     $('besiUniversalValue').disabled=!key;
     $('besiUniversalScope').textContent=Number(json.total||0).toLocaleString('vi-VN')+' sản phẩm';
     $('besiUniversalHint').textContent='Chỉ hiển thị thông số có dữ liệu từ kho. Mẫu thiếu hoặc nhiều phân loại cần xác minh được tách riêng.';
     // Keep last options for instant attribute changes without another fetch.
     stateUi.currentFacets=json.facets;
   }catch(e){
     if(seq===stateUi.optionsId){
       $('besiUniversalHint').textContent='Không tải được thông số mới: '+String(e.message).slice(0,110);
     }
   }
 }
 async function fetchPage(page,kind='exact'){
   if(!stateUi.active||stateUi.loading||stateUi.loadingPossible)return;
   const seq=stateUi.requestId;
   if(kind==='possible')stateUi.loadingPossible=true;else stateUi.loading=true;
   $('besiUniversalApply').disabled=true;
   const query=new URLSearchParams({...stateUi.filter,
     page:String(kind==='possible'?1:page),
     possiblePage:String(kind==='possible'?page:1),limit:'24'});
   try{
     const response=await fetch('/api/products/discover?'+query,{credentials:'same-origin'});
     if(!response.ok)throw Error(response.status===404?'Máy chủ chưa cập nhật tìm kiếm toàn ngành':
       'Lỗi truy vấn ('+response.status+')');
     const json=await response.json();
     if(seq!==stateUi.requestId||!stateUi.active)return;
     if(!json.success||!Array.isArray(json.data)||!Array.isArray(json.possible))
       throw Error('Dữ liệu trả về không hợp lệ');
     if(kind==='exact'){
       const ids=new Set(stateUi.rows.map(p=>String(p.id)));
       for(const p of json.data)if(!ids.has(String(p.id))){
         stateUi.rows.push(p);ids.add(String(p.id));
       }
       if(typeof rememberProducts==='function')rememberProducts(json.data);
       stateUi.page=Number(json.page)||page;stateUi.pages=Number(json.totalPages)||1;
       stateUi.total=Number(json.total)||0;
       if(page===1){
         stateUi.possible=json.possible;stateUi.possiblePage=1;
         stateUi.possiblePages=Number(json.possiblePages)||1;
         stateUi.possibleTotal=Number(json.possibleTotal)||0;
       }
     }else{
       const ids=new Set(stateUi.possible.map(p=>String(p.id)));
       for(const p of json.possible)if(!ids.has(String(p.id))){
         stateUi.possible.push(p);ids.add(String(p.id));
       }
       stateUi.possiblePage=Number(json.possiblePage)||page;
     }
     stateUi.error='';
   }catch(e){if(seq===stateUi.requestId)stateUi.error=String(e.message||'Lỗi tải hàng').slice(0,140);}
   finally{
     if(seq===stateUi.requestId){
       stateUi.loading=false;stateUi.loadingPossible=false;
       $('besiUniversalApply').disabled=false;paint();
     }
   }
 }
 function exit(){
   stateUi.requestId++;stateUi.active=false;stateUi.loading=false;
   stateUi.loadingPossible=false;result.hidden=true;
   $('catalog')?.classList.remove('besi-filter-mode');
 }
 function run(){
   window.dispatchEvent(new CustomEvent('besi:universal-filters-start'));
   stateUi.requestId++;stateUi.active=true;stateUi.page=0;stateUi.pages=1;stateUi.total=0;
   stateUi.rows=[];stateUi.possible=[];stateUi.possiblePage=0;stateUi.possibleTotal=0;
   stateUi.possiblePages=1;stateUi.loading=false;stateUi.loadingPossible=false;stateUi.error='';
   stateUi.filter=formValues();
   result.hidden=false;$('catalog')?.classList.add('besi-filter-mode');
   const name=stateUi.filter.q?'“'+stateUi.filter.q.slice(0,90)+'”':'Tất cả ngành hàng';
   $('besiUniversalTitle').textContent='Kết quả cho '+name;
   $('besiUniversalStatus').textContent='Đang tìm trong kho BESI…';
   $('besiUniversalGrid').replaceChildren();$('besiUniversalPossible').hidden=true;
   result.scrollIntoView({behavior:'smooth',block:'start'});
   fetchPage(1);
 }
 let debounce;
 $('besiUniversalForm').addEventListener('submit',e=>{e.preventDefault();run();});
 $('besiUniversalReset').addEventListener('click',()=>{
   exit();root.querySelector('form')?.reset();loadOptions();
   $('productGrid')?.scrollIntoView({behavior:'smooth',block:'start'});
 });
 $('besiUniversalExit').addEventListener('click',exit);
 $('besiUniversalMore').addEventListener('click',()=>fetchPage(stateUi.page+1));
 $('besiUniversalPossibleMore').addEventListener('click',()=>fetchPage(stateUi.possiblePage+1,'possible'));
 $('besiUniversalQuery').addEventListener('input',()=>{
   clearTimeout(debounce);debounce=setTimeout(loadOptions,350);
 });
 $('besiUniversalCategory').addEventListener('change',loadOptions);
 $('besiUniversalAttribute').addEventListener('change',()=>{
   const key=$('besiUniversalAttribute').value;
   selectOptions($('besiUniversalValue'),stateUi.currentFacets?.[key]||[],
     'Tất cả',x=>valueLabel(key,x.value)+' ('+x.count.toLocaleString('vi-VN')+')');
   $('besiUniversalValue').disabled=!key;
 });
 // Keep existing specialised finders mutually exclusive.
 window.addEventListener('besi:category-filters-start',()=>{if(stateUi.active)exit();});
 window.addEventListener('besi:cable-filters-start',()=>{if(stateUi.active)exit();});
 document.addEventListener('click',e=>{
   if(!stateUi.active||e.isTrusted===false)return;
   if(e.target.closest('#searchBtn,.cat-btn,.brand-pill,.price-pill,[data-store-action],.market-links a,#btnLoadMore'))exit();
 },true);
 $('searchInput')?.addEventListener('keydown',e=>{
   if(e.key==='Enter'&&stateUi.active)exit();
 },true);
 window.addEventListener('popstate',()=>{if(stateUi.active)exit();});
 loadOptions();
})();
