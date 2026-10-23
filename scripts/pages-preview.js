/* GitHub Pages test adapter: entire public retail catalog snapshot.
   All names, pictures, catalog prices and category IDs originate from
   data/products.json via the allowlisted static build. No live checkout. */
(() => {
  'use strict';
  window.HM_DEMO_MODE = true;
  const browserFetch=window.fetch.bind(window);
  const snapshotPromise=browserFetch('./products-public.json',{cache:'no-store'})
    .then(response=>{
      if(!response.ok)throw Error('Không tải được danh mục cửa hàng');
      return response.json();
    })
    .then(snapshot=>{
      if(!Array.isArray(snapshot.products)||!Array.isArray(snapshot.categories)||snapshot.products.length<100)
        throw Error('Danh mục không đầy đủ');
      const byId=new Map(snapshot.products.map(p=>[Number(p.id),p]));
      const catById=new Map(snapshot.categories.map(c=>[Number(c.id),c]));
      return {products:snapshot.products,categories:snapshot.categories,byId,catById,
        generatedAt:snapshot.generated_at};
    });
  window.HM_PREVIEW_CATALOG_READY=snapshotPromise;
  const respond=(data,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{
    status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
  }));
  function normalize(value){
    return String(value||'').toLocaleLowerCase('vi').normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').trim();
  }
  function categoryAndChildren(id,categories){
    const all=new Set([Number(id)]);
    let changed=true;
    while(changed){
      changed=false;
      for(const cat of categories){
        if(cat.parent_id!=null&&all.has(Number(cat.parent_id))&&!all.has(Number(cat.id))){
          all.add(Number(cat.id));changed=true;
        }
      }
    }
    return all;
  }
  window.fetch=async (input,init={})=>{
    const raw=typeof input==='string'?input:input?.url;
    if(!raw)return browserFetch(input,init);
    const url=new URL(raw,location.href);
    if(!url.pathname.startsWith('/api/'))return browserFetch(input,init);
    const path=url.pathname,method=(init.method||input?.method||'GET').toUpperCase();
    if(method!=='GET'){
      // Includes all attempts at checkout, QR/payment and shipping quotes.
      return respond({success:false,error:'Trang thử nghiệm không thể đặt hàng hoặc thanh toán.'},403);
    }
    if(path==='/api/shipping/provinces')return respond({success:true,data:[
      {name:'TP. Hồ Chí Minh',region_label:'Miền Nam'},
      {name:'Hà Nội',region_label:'Miền Bắc'},{name:'Đà Nẵng',region_label:'Miền Trung'}
    ]});
    if(path==='/api/realtime/status')return respond({success:true,data:{}});
    let catalog;
    try{catalog=await snapshotPromise;}catch(e){
      return respond({success:false,error:'Không tải được dữ liệu danh mục: '+e.message},503);
    }
    const {products,categories,byId}=catalog;
    if(path==='/api/categories')return respond({success:true,data:categories});
    if(path==='/api/products'){
      const p=url.searchParams;
      const search=normalize(p.get('search')),category=p.get('category')||'all';
      const minimum=p.get('minPrice')==null||p.get('minPrice')===''?-Infinity:Number(p.get('minPrice'));
      const maximum=p.get('maxPrice')==null||p.get('maxPrice')===''?Infinity:Number(p.get('maxPrice'));
      const limit=Math.min(100,Math.max(1,Number(p.get('limit'))||24));
      const page=Math.max(1,Number(p.get('page'))||1);
      const accepted=category==='all'?null:categoryAndChildren(Number(category),categories);
      let filtered=products.filter(item=>
        (!accepted||accepted.has(Number(item.category_id)))&&
        Number(item.price)>=minimum&&Number(item.price)<=maximum&&
        (!search||normalize(item.name).includes(search)||normalize(item.sku).includes(search))
      );
      switch(p.get('sort')){
        case 'price-asc':filtered.sort((a,b)=>a.price-b.price);break;
        case 'price-desc':filtered.sort((a,b)=>b.price-a.price);break;
        case 'name-asc':filtered.sort((a,b)=>a.name.localeCompare(b.name,'vi'));break;
      }
      // Mọi kiểu sắp xếp: món còn hàng đứng trước (giống máy chủ thật)
      filtered=filtered.filter(p=>p.in_stock!==false).concat(filtered.filter(p=>p.in_stock===false));
      const total=filtered.length;
      return respond({success:true,data:filtered.slice((page-1)*limit,page*limit),
        total,page,totalPages:Math.max(1,Math.ceil(total/limit))});
    }
    const match=path.match(/^\/api\/products\/(\d+)$/);
    if(match){
      const product=byId.get(Number(match[1]));
      return respond(product?{success:true,data:product}:{success:false,error:'Không tìm thấy sản phẩm'},product?200:404);
    }
    return respond({success:false,error:'Chức năng chỉ hỗ trợ trên website bán hàng thật.'},404);
  };

  window.io=()=>({
    on(){return this;},emit(){return this;},off(){return this;},disconnect(){return this;}
  });

  function applyDemoSafety(){
    const submit=document.getElementById('submitOrderBtn');
    if(submit){
      submit.type='button';
      submit.textContent='Demo — không đặt hàng thật';
      submit.disabled=true;
      submit.title='Thao tác thanh toán thật đã tắt';
    }
    const hint=document.createElement('p');
    hint.className='demo-checkout-note';
    hint.textContent='CHẾ ĐỘ XEM THỬ. Đây là bản trưng bày: giá lấy từ bản lưu, không cập nhật tức thời và không nhận đơn. Đặt hàng thật tại besi.vn.';
    document.getElementById('checkoutForm')?.prepend(hint);
    snapshotPromise.then(x=>{
      const ribbon=document.querySelector('.pages-demo-ribbon span');
      const date=new Date(x.generatedAt);
      if(ribbon)ribbon.textContent=x.products.length.toLocaleString('vi-VN')+' sản phẩm từ cache GitHub · '+(Number.isNaN(date.getTime())?'Không rõ ngày':date.toLocaleDateString('vi-VN'))+' · Không thanh toán thật';
    }).catch(()=>{
      const ribbon=document.querySelector('.pages-demo-ribbon span');
      if(ribbon)ribbon.textContent='Danh mục đang lỗi tải. Đây không phải trang đặt hàng.';
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyDemoSafety,{once:true});
  else applyDemoSafety();
})();
