/* HOANG MINH STORE — progressive interaction & animation controller
   Safeguards: respects reduced motion, visibility and keyboard navigation;
   animations never alter prices, order/payment state, or admin behaviour. */
(() => {
  'use strict';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hero = document.querySelector('.market-main-banner');
  const grid = document.getElementById('productGrid');
  const featuredGrid = document.getElementById('featuredProducts');
  const cart = document.getElementById('cartDrawer');
  const cartBackdrop = document.getElementById('cartBackdrop');
  const cartCount = document.getElementById('cartCount');
  const cartTrigger = document.getElementById('openCartBtn');
  const overlayIds = ['productDetailModal','checkoutModal','qrModal','trackModal','favoritesModal'];
  const overlays = overlayIds.map(id => document.getElementById(id)).filter(Boolean);
  let revealObserver = null;
  let lastCartCount = Number.parseInt(cartCount?.textContent || '0',10) || 0;
  let lastCartClick = null;
  let previousFocus = null;
  let activeOverlay = null;
  let ticking = false;

  // Real, keyboard accessible banner carousel — informational messages only;
  // never pretend a promotion, review score or discount exists.
  const slides = [
    {label:'HOÀNG MINH STORE',over:'KHÁM PHÁ ĐIỀU HAY',
      headline:'Mọi thứ bạn cần,<span><em>ở ngay đây.</em></span>',
      description:'Phụ kiện, công nghệ và tiện ích cho mỗi ngày.',
      cta:'Xem sản phẩm',href:'#catalog'},
    {label:'MUA SẮM DỄ DÀNG',over:'DỄ TÌM · DỄ CHỌN',
      headline:'Chọn đúng sản phẩm,<span><em>hợp nhu cầu.</em></span>',
      description:'Duyệt danh mục, lọc giá và xem thông tin chi tiết.',
      cta:'Khám phá danh mục',href:'#catalog'},
    {label:'HOÀNG MINH STORE',over:'TIỆN LỢI MỖI NGÀY',
      headline:'Thêm vào giỏ,<span><em>mua thật dễ.</em></span>',
      description:'Chọn món bạn thích và quản lý giỏ hàng.',
      cta:'Mua sắm ngay',href:'#catalog'}
  ];
  if (hero) {
    const heading=hero.querySelector('.market-banner-copy h1');
    const over=hero.querySelector('.banner-overline');
    const label=hero.querySelector('.market-banner-label');
    const subtitle=hero.querySelector('.market-banner-copy p');
    const shopBtn=hero.querySelector('.banner-shop-btn');
    const dotBar=hero.querySelector('.banner-slides');
    if (heading && over && label && subtitle && shopBtn && dotBar) {
      dotBar.setAttribute('role','group');
      dotBar.setAttribute('aria-label','Chọn nội dung banner');
      // Move dots from the copy block to the banner for correct positioning.
      hero.appendChild(dotBar);
      dotBar.innerHTML=slides.map((s,i)=>
        '<button type="button" data-market-slide="'+i+'" aria-label="Banner '+(i+1)+': '+s.label+'"'+
        (i===0?' class="active" aria-current="true"':' aria-current="false"')+'></button>'
      ).join('');
      hero.insertAdjacentHTML('beforeend',
        '<button class="banner-carousel-control previous" type="button" data-market-prev aria-label="Banner trước"><i class="fa-solid fa-chevron-left"></i></button>'+
        '<button class="banner-carousel-control next" type="button" data-market-next aria-label="Banner tiếp"><i class="fa-solid fa-chevron-right"></i></button>'
      );
      let current=0,timer=null,transitionTimer=null;
      const stopped=()=>reducedMotion.matches || document.hidden || hero.matches(':hover') || hero.matches(':focus-within');
      const clearTimers=()=>{clearInterval(timer);timer=null;clearTimeout(transitionTimer);transitionTimer=null;};
      function applySlide(n,instant=false){
        const next=(n+slides.length)%slides.length;
        if(next===current && !instant)return;
        current=next;
        const setContents=()=>{
          const s=slides[next];
          hero.dataset.slide=String(next);
          label.innerHTML='<i class="fa-solid fa-star"></i> '+s.label;
          over.textContent=s.over;
          heading.innerHTML=s.headline; // all values are hardcoded above, never external data
          subtitle.textContent=s.description;
          shopBtn.innerHTML=s.cta+' <i class="fa-solid fa-arrow-right"></i>';
          shopBtn.setAttribute('href',s.href);
          dotBar.querySelectorAll('button').forEach((btn,i)=>{
            btn.classList.toggle('active',i===next);
            btn.setAttribute('aria-current',String(i===next));
          });
          hero.classList.remove('is-switching');
          hero.classList.remove('hero-animated-in');
          if(!reducedMotion.matches){void hero.offsetWidth;hero.classList.add('hero-animated-in');}
        };
        clearTimeout(transitionTimer);
        if(instant || reducedMotion.matches) setContents();
        else {
          hero.classList.add('is-switching');
          transitionTimer=setTimeout(setContents,180);
        }
      }
      function stop(){if(timer){clearInterval(timer);timer=null;}}
      function start(){
        stop();
        if(stopped()) return;
        timer=setInterval(()=>{if(!stopped())applySlide(current+1);},7000);
      }
      function choose(n){ applySlide(n); start(); }
      dotBar.addEventListener('click',e=>{
        const btn=e.target.closest('[data-market-slide]');if(btn)choose(Number(btn.dataset.marketSlide));
      });
      hero.querySelector('[data-market-prev]')?.addEventListener('click',()=>choose(current-1));
      hero.querySelector('[data-market-next]')?.addEventListener('click',()=>choose(current+1));
      hero.addEventListener('mouseenter',stop);hero.addEventListener('mouseleave',start);
      hero.addEventListener('focusin',stop);hero.addEventListener('focusout',()=>setTimeout(start,0));
      document.addEventListener('visibilitychange',()=>document.hidden?stop():start());
      reducedMotion.addEventListener?.('change',()=>{if(reducedMotion.matches){clearTimers();hero.classList.remove('hero-animated-in','is-switching');applySlide(current,true);}else start();});
      applySlide(0,true);
      if(!reducedMotion.matches){hero.classList.add('hero-animated-in');start();}
    }
  }

  // Animate sections only when in view. Dynamic cards get observed after data refresh.
  const staticTargets=['.market-main-banner','.market-banner-side','.market-sidebar',
    '.market-shortcuts','.featured-header','.filter-bar','.market-footer-offers'];
  function initReveals(){
    if(reducedMotion.matches || !('IntersectionObserver' in window))return;
    revealObserver=new IntersectionObserver(entries=>{
      for(const entry of entries)if(entry.isIntersecting){
        entry.target.classList.add('is-inview');
        revealObserver.unobserve(entry.target);
      }
    },{threshold:.045,rootMargin:'0px 0px 70px 0px'});
    const observe=node=>{
      if(node && !node.classList.contains('reveal-target')){
        node.classList.add('reveal-target');
        revealObserver.observe(node);
      }
    };
    staticTargets.forEach(selector=>document.querySelectorAll(selector).forEach(observe));
    const observeCards=()=>{
      document.querySelectorAll('#productGrid .luxury-card, #featuredProducts .featured-card').forEach(observe);
      document.querySelectorAll('#featuredSection').forEach(s=>{
        if(!s.hidden) observe(s.querySelector('.featured-header'));
      });
    };
    observeCards();
    for(const container of [grid,featuredGrid].filter(Boolean)){
      new MutationObserver(observeCards).observe(container,{childList:true});
    }
    // Never enable the hidden pre-reveal state until initial items are registered.
    document.documentElement.classList.add('motion-ready');
    reducedMotion.addEventListener?.('change',()=>{
      if(reducedMotion.matches){
        revealObserver.disconnect();
        document.documentElement.classList.remove('motion-ready');
      }else{
        document.querySelectorAll('.reveal-target:not(.is-inview)').forEach(node=>revealObserver.observe(node));
        document.documentElement.classList.add('motion-ready');
      }
    });
  }
  initReveals();

  // Loading indicator is tied to genuine catalog API requests.
  window.addEventListener('storefront:loading',()=>{
    grid?.classList.add('is-fetching');
    document.getElementById('catalogCount')?.setAttribute('aria-busy','true');
  });
  const clearLoading=()=>{
    grid?.classList.remove('is-fetching');
    document.getElementById('catalogCount')?.setAttribute('aria-busy','false');
  };
  window.addEventListener('storefront:products',clearLoading);
  window.addEventListener('storefront:error',clearLoading);

  // Animated scroll progress and minimal sticky navigation.
  const progress=document.createElement('div');
  progress.className='market-scroll-progress';
  progress.setAttribute('aria-hidden','true');
  document.body.appendChild(progress);
  const backTop=document.createElement('button');
  backTop.type='button';backTop.className='store-to-top';
  backTop.setAttribute('aria-label','Lên đầu trang');
  backTop.innerHTML='<i class="fa-solid fa-arrow-up"></i>';
  backTop.addEventListener('click',()=>window.scrollTo({top:0,behavior:reducedMotion.matches?'auto':'smooth'}));
  document.body.appendChild(backTop);
  function updateScroll(){
    ticking=false;
    const y=window.scrollY||0;
    document.body.classList.toggle('shop-scrolled',y>72);
    backTop.classList.toggle('is-visible',y>600);
    const pageHeight=Math.max(1,document.documentElement.scrollHeight-window.innerHeight);
    progress.style.transform='scaleX('+Math.min(1,Math.max(0,y/pageHeight))+')';
  }
  function onScroll(){
    if(ticking)return;
    ticking=true;window.requestAnimationFrame(updateScroll);
  }
  window.addEventListener('scroll',onScroll,{passive:true});
  window.addEventListener('resize',onScroll,{passive:true});
  updateScroll();

  // Real cart changes cause the pop; never animate before the cart is updated.
  function popCart(){
    for(const node of [cartTrigger,document.querySelector('.mobile-bottom-nav [data-store-action="cart"]')].filter(Boolean)){
      node.classList.remove('is-cart-bumping');void node.offsetWidth;
      node.classList.add('is-cart-bumping');
      node.addEventListener('animationend',()=>node.classList.remove('is-cart-bumping'),{once:true});
    }
  }
  if(cartCount){
    new MutationObserver(()=>{
      const count=Number.parseInt(cartCount.textContent,10)||0;
      if(count>lastCartCount && !reducedMotion.matches)popCart();
      lastCartCount=count;
    }).observe(cartCount,{characterData:true,childList:true,subtree:true});
  }
  // Capture the specific add-to-cart button from a real user click.
  document.addEventListener('click',e=>{
    const source=e.target.closest('.btn-add-mini,.btn-add-cart-large,#detailAddCartBtn,.btn-detail-cart,.btn-add-cart');
    if(source && !source.disabled)lastCartClick={node:source,at:Date.now()};
    const heart=e.target.closest('.card-heart');
    if(heart && !reducedMotion.matches){
      heart.classList.remove('is-heart-popping');void heart.offsetWidth;
      heart.classList.add('is-heart-popping');
    }
  },true);
  window.addEventListener('storefront:cart-add',()=>{
    if(reducedMotion.matches || !lastCartClick || Date.now()-lastCartClick.at>1000)return;
    const source=lastCartClick.node;lastCartClick=null;
    if(!source.isConnected)return;
    const from=source.getBoundingClientRect();
    const destination=(window.innerWidth<=700?document.querySelector('.mobile-bottom-nav [data-store-action="cart"]'):cartTrigger)||cartTrigger;
    if(!destination)return;
    const to=destination.getBoundingClientRect();
    const startX=from.left+from.width/2,startY=from.top+from.height/2;
    const endX=to.left+to.width/2,endY=to.top+to.height/2;
    const dot=document.createElement('div');dot.className='quick-fly-dot';
    dot.innerHTML='<i class="fa-solid fa-bag-shopping"></i>';
    dot.style.left=startX+'px';dot.style.top=startY+'px';
    document.body.appendChild(dot);
    const anim=dot.animate([
      {transform:'translate(-50%,-50%) scale(1)',opacity:1,offset:0},
      {transform:'translate('+((endX-startX)*.48-15)+'px,'+((endY-startY)*.45-76)+'px) scale(.9)',opacity:.95,offset:.55},
      {transform:'translate('+(endX-startX)+'px,'+(endY-startY)+'px) scale(.22)',opacity:0,offset:1}
    ],{duration:640,easing:'cubic-bezier(.17,.67,.3,1)',fill:'forwards'});
    anim.finished.catch(()=>{}).finally(()=>dot.remove());
    // Failsafe for browsers where animation callbacks are interrupted.
    setTimeout(()=>dot.remove(),900);
  });

  // Modal & drawer keyboard/focus management; the QR is never cancelled by closing the dialog.
  const focusableSelector='a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const isShown=el=>Boolean(el.getClientRects().length && getComputedStyle(el).visibility!=='hidden');
  function topDialog(){
    for(let i=overlays.length-1;i>=0;i--)if(overlays[i].classList.contains('open'))return overlays[i];
    return cart?.classList.contains('open')?cart:null;
  }
  function syncOverlays(){
    const drawerOpen=Boolean(cart?.classList.contains('open'));
    cartBackdrop?.classList.toggle('is-visible',drawerOpen);
    cartBackdrop?.setAttribute('aria-hidden',String(!drawerOpen));
    cart?.setAttribute('aria-hidden',String(!drawerOpen));
    cartTrigger?.setAttribute('aria-expanded',String(drawerOpen));
    overlays.forEach(el=>el.setAttribute('aria-hidden',String(!el.classList.contains('open'))));
    const next=topDialog();
    document.body.classList.toggle('is-overlay-open',Boolean(next));
    if(next===activeOverlay)return;
    if(next){
      if(!activeOverlay)previousFocus=document.activeElement;
      activeOverlay=next;
      window.requestAnimationFrame(()=>{
        if(topDialog()!==next)return;
        const focusable=[...next.querySelectorAll(focusableSelector)].filter(isShown);
        if(focusable.length)focusable[0].focus({preventScroll:true});
      });
    }else{
      activeOverlay=null;
      const focus=previousFocus;previousFocus=null;
      if(focus?.isConnected && isShown(focus))focus.focus({preventScroll:true});
    }
  }
  const observables=[...overlays,cart].filter(Boolean);
  const modalObserver=new MutationObserver(syncOverlays);
  observables.forEach(el=>modalObserver.observe(el,{attributes:true,attributeFilter:['class']}));
  document.addEventListener('keydown',e=>{
    const top=topDialog();
    if(!top)return;
    if(e.key==='Escape'){
      e.preventDefault();
      const closeMap={
        productDetailModal:'closeDetailModalBtn',
        checkoutModal:'closeCheckoutBtn',
        qrModal:'closeQrModalBtn',
        trackModal:'closeTrackBtn',
        favoritesModal:'closeFavoritesBtn',
        cartDrawer:'closeCartBtn'
      };
      document.getElementById(closeMap[top.id])?.click();
      return;
    }
    if(e.key!=='Tab')return;
    const focusable=[...top.querySelectorAll(focusableSelector)].filter(isShown);
    if(!focusable.length)return;
    const first=focusable[0],last=focusable[focusable.length-1];
    if(e.shiftKey && (document.activeElement===first || !top.contains(document.activeElement))){
      e.preventDefault();last.focus();
    }else if(!e.shiftKey && (document.activeElement===last || !top.contains(document.activeElement))){
      e.preventDefault();first.focus();
    }
  });
  for(const el of overlays){
    if(el.id==='qrModal')continue; // Avoid an accidental close while payment is pending.
    el.addEventListener('click',e=>{
      if(e.target!==el)return;
      const closeMap={productDetailModal:'closeDetailModalBtn',checkoutModal:'closeCheckoutBtn',trackModal:'closeTrackBtn',favoritesModal:'closeFavoritesBtn'};
      document.getElementById(closeMap[el.id])?.click();
    });
  }
  syncOverlays();
  const toast=document.getElementById('toastNotification');
  if(toast){toast.setAttribute('role','status');toast.setAttribute('aria-live','polite');}
  // no fake login, discount, payment or order completion animations.
})();
