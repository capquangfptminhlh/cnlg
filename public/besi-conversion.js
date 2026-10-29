/* BESI conversion layer: use ONLY products already returned by the sanitized
 * public product catalog. No fabricated orders, ratings, sale prices or urgency.
 * Do not request upstream feeds or reveal supplier information.
 */
(() => {
  'use strict';
  const root = document.getElementById('besiPickList');
  const liveCount = document.getElementById('besiLiveCount');
  if (!root) return;
  const parent = root.closest('.market-banner-side');
  let loaded = false;
  const fallback = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
    '<rect width="96" height="96" rx="12" fill="#f4f6fa"/>' +
    '<text x="48" y="55" text-anchor="middle" fill="#f4512c" font-family="sans-serif" font-size="20" font-weight="bold">BESI</text></svg>'
  );
  const safeImage = value => {
    const u = String(value || '');
    // Images must be served by BESI's existing first-party image proxy.
    if (/^\/(?:cdn\/|api\/catalog-image\/|images\/)/i.test(u) && !u.includes('\\') && !u.includes('//')) return u;
    return fallback;
  };
  function textEl(tag,className,value) {
    const el = document.createElement(tag);
    if (className) el.className=className;
    el.textContent=String(value??'');
    return el;
  }
  function productCard(item){
    const id = Number(item.id);
    if (!Number.isSafeInteger(id) || id<0) return null;
    const price = Number(item.price);
    if (!Number.isFinite(price) || price<=0 || item.in_stock===false) return null;
    const article = document.createElement('article');
    article.className='besi-pick';
    const preview=document.createElement('button');
    preview.type='button';preview.className='besi-pick-preview';
    preview.dataset.shopProduct=String(id);
    preview.setAttribute('aria-label','Xem chi tiết '+String(item.name||'sản phẩm').slice(0,95));
    const img=document.createElement('img');
    img.className='besi-pick-image';img.loading='lazy';img.decoding='async';
    img.src=safeImage(item.image);img.alt='';
    img.onerror=()=>{img.onerror=null;img.src=fallback;};
    const summary=document.createElement('span');
    summary.className='besi-pick-summary';
    const title=textEl('span','besi-pick-title',String(item.name||'Sản phẩm BESI').slice(0,115));
    const cost=textEl('strong','besi-pick-price',price.toLocaleString('vi-VN')+'đ');
    summary.append(title,cost);preview.append(img,summary);
    const buy=document.createElement('button');
    buy.type='button';buy.className='besi-pick-buy';
    buy.dataset.shopBuy=String(id);
    buy.textContent='Mua ngay';
    buy.setAttribute('aria-label','Mua ngay '+String(item.name||'sản phẩm').slice(0,75));
    article.append(preview,buy);
    return article;
  }
  function render(items) {
    if (loaded || !Array.isArray(items)) return;
    const seen=new Set();
    const candidates=items.filter(p=>{
      const id=Number(p?.id);
      const ok=Number.isSafeInteger(id)&&id>=0&&!seen.has(id)&&p.in_stock!==false&&Number(p.price)>0;
      if(ok)seen.add(id);
      return ok;
    });
    // Prioritize actual product photographs; blank placeholders decrease trust.
    const photographed=candidates.filter(p=>safeImage(p.image)!==fallback);
    const cards=photographed.slice(0,3).map(productCard).filter(Boolean);
    if (cards.length<2) return; // preserve existing quick links if catalog unavailable
    root.replaceChildren(...cards);
    root.hidden=false;
    parent?.classList.add('has-besi-picks');
    loaded=true;
  }
  function updateCount(){
    if(!liveCount)return;
    const value=document.getElementById('heroTotalProd')?.textContent?.trim()||'';
    const numeric=Number(value.replace(/\./g,'').replace(/,/g,''));
    liveCount.classList.toggle('is-ready',Number.isFinite(numeric)&&numeric>0);
  }
  const countTarget=document.getElementById('heroTotalProd');
  if(countTarget) {
    new MutationObserver(updateCount).observe(countTarget,{childList:true,characterData:true,subtree:true});
    updateCount();
  }
  window.addEventListener('storefront:products',event=>render(event.detail?.products));
  // The product list sometimes resolves before this script is evaluated.
  try{
    if(typeof state !== 'undefined' && Array.isArray(state.products)){
      render(state.products);
    }
  }catch(_){/* do not interfere with the storefront */}
})();
