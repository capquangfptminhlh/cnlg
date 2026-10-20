/* Browser-only saved products list: never sends customer preferences to the server.
   Prices and availability shown only after a current product API read. */
(() => {
  'use strict';
  const KEY='hm_favorites_v1';
  const modal=document.createElement('div');
  modal.id='favoritesModal';
  modal.className='modal-backdrop';
  modal.setAttribute('aria-hidden','true');
  modal.innerHTML='<div class="modal-dialog favorites-dialog" role="dialog" aria-modal="true" aria-labelledby="favoritesTitle">'+
    '<div class="favorites-top"><div><h2 id="favoritesTitle"><i class="fa-solid fa-heart"></i> Sản phẩm yêu thích</h2>'+
    '<p>Danh sách được lưu trên thiết bị này</p></div>'+
    '<button type="button" id="closeFavoritesBtn" class="modal-close-icon" aria-label="Đóng danh sách yêu thích">&times;</button></div>'+
    '<div id="favoritesBody" class="favorites-body" aria-live="polite"></div>'+
    '<div class="favorites-footer"><button type="button" class="btn-primary-block" id="favoritesContinue">Tiếp tục mua sắm</button></div></div>';
  document.body.appendChild(modal);
  const body=document.getElementById('favoritesBody');

  const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ids=()=>{
    try{
      const list=JSON.parse(localStorage.getItem(KEY)||'[]');
      return Array.isArray(list)?[...new Set(list.map(Number).filter(x=>Number.isSafeInteger(x)&&x>=0))].slice(0,40):[];
    }catch(_){return [];}
  };
  const currency=n=>Number.isFinite(Number(n))?Number(n).toLocaleString('vi-VN')+'đ':'Liên hệ';
  const fallback='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#f3f4f6"/><text x="60" y="65" text-anchor="middle" font-size="10" fill="#9ca3af">Hoàng Minh</text></svg>');
  let renderVersion=0;
  let loaded=new Map();

  function empty(){
    body.innerHTML='<div class="favorites-empty"><i class="fa-regular fa-heart"></i>'+
      '<strong>Chưa có sản phẩm yêu thích</strong><span>Bấm biểu tượng trái tim trên sản phẩm để lưu lại và xem ở đây.</span></div>';
  }
  function row(p){
    const id=Number(p.id);
    const stock=p.in_stock!==false;
    return '<div class="favorites-item" data-favorite-row="'+id+'">'+
      '<button class="favorites-image" type="button" data-favorites-open="'+id+'" aria-label="Xem '+escapeHTML(p.name)+'"><img loading="lazy" alt="'+escapeHTML(p.name)+'" src="'+escapeHTML(p.image||fallback)+'"></button>'+
      '<div class="favorites-detail"><button class="favorites-name" type="button" data-favorites-open="'+id+'">'+escapeHTML(p.name)+'</button>'+
      '<strong class="favorites-price">'+currency(p.price)+'</strong><span class="favorites-stock">'+(stock?'Xem chi tiết & chọn phân loại':'Tạm hết hàng')+'</span>'+
      '<div class="favorites-buttons"><button type="button" data-favorites-open="'+id+'">Xem sản phẩm</button><button type="button" data-favorites-remove="'+id+'"><i class="fa-regular fa-trash-can"></i> Bỏ lưu</button></div></div></div>';
  }
  async function render(){
    const list=ids();
    const version=++renderVersion;
    if(!list.length){empty();return;}
    body.innerHTML='<div class="favorites-loading"><i class="fa-solid fa-spinner fa-spin"></i> Đang cập nhật thông tin sản phẩm...</div>';
    const result=new Array(list.length);
    let index=0;
    async function worker(){
      while(index<list.length){
        const pos=index++; const id=list[pos];
        try{
          const res=await fetch('/api/products/'+encodeURIComponent(id),{credentials:'same-origin'});
          if(!res.ok)continue;
          const json=await res.json();
          if(json.success && json.data)result[pos]=json.data;
        }catch(_){/* individual product may be temporarily unavailable */}
      }
    }
    await Promise.all(Array.from({length:Math.min(4,list.length)},()=>worker()));
    if(version!==renderVersion || !modal.classList.contains('open'))return;
    const products=result.filter(Boolean);
    loaded=new Map(products.map(p=>[Number(p.id),p]));
    body.innerHTML=(products.length?products.map(row).join(''):'<p class="favorites-error">Không thể tải sản phẩm đã lưu. Hãy thử mở lại danh sách khi có kết nối.</p>')+
      (products.length<list.length?'<p class="favorites-error">Một vài sản phẩm không còn khả dụng hoặc chưa thể tải.</p>':'');
  }
  function close(){modal.classList.remove('open');renderVersion++;}
  function open(){modal.classList.add('open');render();}
  document.getElementById('closeFavoritesBtn').addEventListener('click',close);
  document.getElementById('favoritesContinue').addEventListener('click',()=>{
    close();document.getElementById('catalog')?.scrollIntoView({behavior:'smooth'});
  });
  document.addEventListener('click',e=>{
    if(e.target.closest('[data-store-action="favorites"]')){open();return;}
    const rem=e.target.closest('[data-favorites-remove]');
    if(rem){
      const id=Number(rem.dataset.favoritesRemove);
      const set=ids().filter(x=>x!==id);
      try{localStorage.setItem(KEY,JSON.stringify(set));}catch(_){}
      window.dispatchEvent(new Event('storefront:favorite-write'));
      render();
      return;
    }
    const view=e.target.closest('[data-favorites-open]');
    if(view){
      const id=Number(view.dataset.favoritesOpen);
      if(!loaded.has(id))return;
      close();
      if(typeof openProductDetail==='function')openProductDetail(id);
    }
  });
  window.addEventListener('storefront:favorites-changed',()=>{
    if(modal.classList.contains('open'))render();
  });
})();
