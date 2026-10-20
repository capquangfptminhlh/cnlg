/* HOÀNG MINH — premium storefront progressive enhancement.
 * Existing checkout, prices, wishlist and real API logic stay in app.js.
 * Replaces the white boxes left by unavailable remote images with a clear
 * product-name placeholder, never an unrelated photo or fictional rating. */
(() => {
  'use strict';
  const pending=new WeakSet();
  const observedProducts=new Set();
  const gallery=[
    document.getElementById('heroProductImageA'),
    document.getElementById('heroProductImageB'),
    document.getElementById('heroProductImageC')
  ].filter(Boolean);
  let generation=0;
  const abortImage = (img) => {
    if(!img || !img.isConnected) return;
    const card=img.closest('.luxury-card,.featured-card');
    const container=img.closest('.card-media,.featured-media');
    if(!container || container.querySelector('.premium-image-fallback')) return;
    const name=card?.querySelector('.card-title,.featured-name')?.textContent?.trim()||'Sản phẩm đang cập nhật ảnh';
    const fallback=document.createElement('div');
    fallback.className='premium-image-fallback';
    fallback.setAttribute('role','img');
    fallback.setAttribute('aria-label','Ảnh sản phẩm chưa khả dụng: '+name);
    const icon=document.createElement('i');
    icon.className='fa-solid fa-box-open';
    icon.setAttribute('aria-hidden','true');
    const title=document.createElement('strong');
    title.textContent=name;
    const hint=document.createElement('small');
    hint.textContent='ĐANG CẬP NHẬT ẢNH';
    fallback.append(icon,title,hint);
    img.remove();
    const overlay=container.querySelector('.card-quick-overlay');
    container.insertBefore(fallback,overlay||null);
  };
  function trackImage(img) {
    if(pending.has(img))return;
    pending.add(img);
    img.addEventListener('error',()=>abortImage(img),{once:true});
    if(img.complete&&!img.naturalWidth)abortImage(img);
  }
  function observeCards() {
    document.querySelectorAll('#productGrid .card-media img,#featuredProducts .featured-media img')
      .forEach(trackImage);
  }
  const cardObserver=new MutationObserver(observeCards);
  [document.getElementById('productGrid'),document.getElementById('featuredProducts')]
    .filter(Boolean).forEach(node=>cardObserver.observe(node,{childList:true,subtree:true}));
  observeCards();

  function validURL(candidate) {
    if(typeof candidate!=='string'||candidate.length>1700)return '';
    try {
      const url=new URL(candidate,window.location.href);
      return ['https:','http:'].includes(url.protocol)?url.href:'';
    } catch (_) {return ''}
  }
  function galleryFromProducts(data) {
    const products=Array.isArray(data)?data:[];
    // Same public product photos the catalog uses. No fabricated merchandise.
    const candidates=products
      .filter(p=>p?.in_stock!==false&&p?.image)
      .map(p=>({id:p.id,source:validURL(p.image_hd||p.image)}))
      .filter(p=>p.source);
    if(!candidates.length||!gallery.length)return;
    const thisGeneration=++generation;
    let next=0,success=0,processed=0;
    const claimed=new Set();
    const limit=Math.min(candidates.length,36);

    async function loadCandidate(candidate){
      return new Promise(resolve=>{
        const image=new Image();
        let handled=false;
        function finish(ok){
          if(handled)return;
          handled=true;
          image.onload=image.onerror=null;
          resolve(ok);
        }
        image.onload=()=>finish(image.naturalWidth>0&&image.naturalHeight>0);
        image.onerror=()=>finish(false);
        image.src=candidate.source;
        if(image.complete)finish(image.naturalWidth>0);
        window.setTimeout(()=>finish(false),2200);
      });
    }
    async function worker(){
      while(next<limit&&success<gallery.length&&thisGeneration===generation){
        const candidate=candidates[next++];
        if(claimed.has(candidate.id))continue;
        claimed.add(candidate.id);
        const ok=await loadCandidate(candidate);
        if(!ok||thisGeneration!==generation)continue;
        const slot=gallery[success++];
        if(!slot)break;
        slot.src=candidate.source;
        slot.closest('.premium-product-shot')?.classList.add('has-photo');
      }
    }
    // 3 concurrent probes so an inaccessible image server does not freeze UI.
    Promise.all([worker(),worker(),worker()]).catch(()=>{});
  }
  window.addEventListener('storefront:products',event=>{
    observeCards();
    if(!observedProducts.size){
      const data=event.detail?.products||[];
      data.forEach(p=>observedProducts.add(p.id));
      galleryFromProducts(data);
    }
  });
  // If a gallery slot has loaded but later fails, keep its intentional icon.
  gallery.forEach(img=>img.addEventListener('error',()=>{
    img.closest('.premium-product-shot')?.classList.remove('has-photo');
    img.removeAttribute('src');
  }));

  // Navigation highlights the correct section without substituting a fake account.
  const nav=document.querySelector('.mobile-bottom-nav');
  if(nav){
    nav.addEventListener('click',e=>{
      const hit=e.target.closest('a,button');
      if(!hit)return;
      nav.querySelectorAll('a,button').forEach(item=>{
        item.classList.remove('active');
        if(item.tagName==='A')item.removeAttribute('aria-current');
      });
      hit.classList.add('active');
      if(hit.tagName==='A')hit.setAttribute('aria-current','page');
    });
  }
})();
