/* HOANG MINH STORE — Marketplace presentation layer.
   Only uses existing authenticated storefront functions and public product catalog.
   No fake ratings, orders, promo codes or invented sale prices. */
(() => {
  'use strict';

  const section = document.getElementById('featuredSection');
  const featuredGrid = document.getElementById('featuredProducts');
  const cartCountSource = document.getElementById('cartCount');
  const mobileCount = document.getElementById('mobileCartCount');
  const FAVORITES_KEY = 'hm_favorites_v1';

  function escapeHTML(input) {
    return String(input ?? '').replace(/[&<>"']/g, ch => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[ch]));
  }
  function formatVND(input) {
    const number = Number(input);
    return Number.isFinite(number) ? number.toLocaleString('vi-VN') + 'đ' : 'Liên hệ';
  }
  function compactVND(amount) {
    const n = Math.max(0, Math.round(Number(amount) || 0));
    if (n >= 1000000) return (n / 1000000).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + 'TR';
    if (n >= 1000) return Math.round(n / 1000).toLocaleString('vi-VN') + 'K';
    return n.toLocaleString('vi-VN') + 'đ';
  }
  function favorites() {
    try {
      const data = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
      return new Set(Array.isArray(data) ? data.map(String) : []);
    } catch (_) { return new Set(); }
  }
  let saved = favorites();

  function updateHeartButtons() {
    document.querySelectorAll('.card-heart').forEach(btn => {
      const liked = saved.has(String(btn.dataset.favoriteId));
      btn.setAttribute('aria-pressed', String(liked));
      btn.setAttribute('aria-label', liked ? 'Bỏ lưu sản phẩm' : 'Lưu sản phẩm');
      btn.innerHTML = liked ? '<i class="fa-solid fa-heart"></i>' : '<i class="fa-regular fa-heart"></i>';
    });
  }
  function toggleFavorite(value) {
    const id = String(value);
    if (saved.has(id)) saved.delete(id); else saved.add(id);
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...saved])); } catch (_) { /* disabled storage */ }
    updateHeartButtons();
    window.dispatchEvent(new Event('storefront:favorites-changed'));
  }
  function numericId(p) {
    const id = Number(p.id);
    return Number.isSafeInteger(id) && id >= 0 ? id : null;
  }
  function featuredCard(p) {
    const id = numericId(p);
    if (id == null) return '';
    const soldOut = p.in_stock === false;
    const oldPrice = Number(p.original_price);
    const price = Number(p.price);
    const showOld = Number.isFinite(oldPrice) && Number.isFinite(price) && oldPrice > price;
    const discount = Number(p.discount_percent);
    const hasOff = Number.isFinite(discount) && discount > 0 && showOld;
    const discountBadge = soldOut ? '<span class="card-tag tag-out">Hết hàng</span>'
      : p.is_flash_sale ? '<span class="card-tag tag-flash"><i class="fa-solid fa-bolt"></i> FLASH SALE</span>'
      : hasOff && discount >= 35 ? '<span class="card-tag tag-deal"><i class="fa-solid fa-fire"></i> GIÁ SỈ -' + Math.round(discount) + '%</span>'
      : p.is_mall ? '<span class="card-tag tag-mall"><i class="fa-solid fa-circle-check"></i> Chính hãng</span>'
      : '<span class="card-tag tag-si"><i class="fa-solid fa-tag"></i> GIÁ SỈ KHO</span>';
    const cornerOff = !soldOut && hasOff && discount >= 20
      ? '<span class="card-corner-off"><b>-' + Math.round(discount) + '%</b><small>GIẢM</small></span>'
      : '';
    const saveChip = !soldOut
      ? (showOld && (oldPrice - price) >= 3000
          ? '<span class="si-save-chip"><i class="fa-solid fa-fire-flame-curved"></i> Rẻ hơn ' + compactVND(oldPrice - price) + ' · Giá sỉ</span>'
          : '<span class="si-save-chip is-base"><i class="fa-solid fa-check-double"></i> Mua 1 món cũng giá sỉ</span>')
      : '';
    const fallback = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="100%" height="100%" fill="#f8f8fa"/><text x="50%" y="50%" fill="#aab0b9" text-anchor="middle" dominant-baseline="central" font-size="20">Hoang Minh Store</text></svg>'
    );
    const src = String(p.image || '');
    return '<article class="featured-card' + (p.is_flash_sale && !soldOut ? ' is-flash-card' : '') + '" data-product-id="' + id + '">' +
      '<button type="button" class="featured-media" data-shop-product="' + id + '" aria-label="Xem ' + escapeHTML(p.name) + '">' +
      '<img loading="lazy" src="' + escapeHTML(src || fallback) + '" alt="' + escapeHTML(p.name) +
      '" onerror="this.onerror=null;this.src=' + "'" + fallback.replace(/'/g, '') + "'" + '">' +
      '</button>' + discountBadge + cornerOff +
      '<button type="button" class="card-heart" data-favorite-id="' + id + '" aria-pressed="false" aria-label="Lưu sản phẩm"><i class="fa-regular fa-heart"></i></button>' +
      '<div class="featured-info">' +
      '<button type="button" class="featured-name" data-shop-product="' + id + '">' + escapeHTML(p.name) + '</button>' +
      '<strong class="featured-price">' + formatVND(p.price) + '</strong>' +
      (showOld ? '<span class="price-old-row"><span class="featured-old">' + formatVND(oldPrice) + '</span>' + (hasOff ? '<span class="price-off">-' + Math.round(discount) + '%</span>' : '') + '</span>' : '') +
      saveChip +
      '<div class="fs-warranty-line"><i class="fa-solid fa-shield-halved"></i> ' + escapeHTML(p.warranty || 'Không bảo hành') + '</div>' +
      '<div class="featured-actions"><button type="button" class="featured-cart" data-shop-cart="' + id + '" aria-label="Thêm vào giỏ"' + (soldOut ? ' disabled' : '') + '><i class="fa-solid fa-cart-plus"></i></button>' +
      '<button type="button" class="featured-buy" data-shop-buy="' + id + '"' + (soldOut ? ' disabled' : '') + '>' +
      (soldOut ? 'Hết hàng' : 'Mua ngay') + '</button></div></div></article>';
  }
  function renderFeatured(products) {
    if (!section || !featuredGrid) return;
    const list = (Array.isArray(products) ? products : []).filter(p => numericId(p) !== null).slice(0,6);
    if (typeof rememberProducts === 'function') rememberProducts(list);
    featuredGrid.innerHTML = list.map(featuredCard).join('');
    section.hidden = !list.length;
    updateHeartButtons();
  }

  // "Sản phẩm nổi bật": lấy riêng (không lặp trang đầu của danh sách bên dưới) – SP còn hàng, giảm nhiều nhất
  // trong 1 trang chọn theo ngày, nên mỗi ngày một nhóm khác. Lỗi mạng → dùng tạm SP đang hiển thị.
  let featuredLoaded = false;
  async function loadFeatured() {
    try {
      const day = Math.floor(Date.now() / 86400000);
      const res = await fetch('/api/products?inStock=1&limit=12&page=' + (day % 10 + 1));
      const json = await res.json();
      const pool = (json.data || []).filter(p => p.image);
      pool.sort((a, b) => (Number(b.discount_percent) || 0) - (Number(a.discount_percent) || 0));
      if (pool.length >= 6) { featuredLoaded = true; renderFeatured(pool); }
    } catch (_) { /* giữ bản dự phòng */ }
  }
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(() => setTimeout(loadFeatured, 800));
  } else {
    setTimeout(loadFeatured, 1000);
  }
  window.addEventListener('storefront:products', event => {
    if (!featuredLoaded) renderFeatured(event.detail && event.detail.products);
    updateHeartButtons();
  });
  window.addEventListener('storefront:flash-sale-rendered', updateHeartButtons);

  function jumpToCatalog() {
    const el = document.getElementById('catalog');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function resetToAllIfNeeded() {
    if (typeof state !== 'undefined' && state.currentCategory !== 'all') {
      const allBtn = document.querySelector('#categoriesContainer .cat-btn[data-id="all"]');
      if (allBtn) allBtn.click();
    }
  }
  function action(type) {
    switch (type) {
      case 'track':
        document.getElementById('openTrackBtn')?.click();
        break;
      case 'cart':
        document.getElementById('openCartBtn')?.click();
        break;
      case 'search': {
        const input = document.getElementById('searchInput');
        input?.scrollIntoView({behavior:'smooth',block:'center'});
        input?.focus({preventScroll:true});
        break;
      }
      case 'flash-sale':
        resetToAllIfNeeded();
        document.querySelector('.price-pill[data-flash="1"]')?.click();
        jumpToCatalog();
        break;
      case 'under99':
        resetToAllIfNeeded();
        document.querySelector('.price-pill[data-min="0"][data-max="99000"]')?.click();
        jumpToCatalog();
        break;
      case 'under500':
        resetToAllIfNeeded();
        document.querySelector('.price-pill[data-min="0"][data-max="500000"]')?.click();
        jumpToCatalog();
        break;
      case 'sort-discount': {
        resetToAllIfNeeded();
        const select = document.getElementById('sortSelect');
        if (select) { select.value = 'discount-desc'; select.dispatchEvent(new Event('change', {bubbles:true})); }
        jumpToCatalog();
        break;
      }
      case 'sort-low': {
        resetToAllIfNeeded();
        const select = document.getElementById('sortSelect');
        if (select) { select.value = 'price-asc'; select.dispatchEvent(new Event('change', {bubbles:true})); }
        jumpToCatalog();
        break;
      }
    }
  }

  document.addEventListener('click', event => {
    const favoriteBtn = event.target.closest('[data-favorite-id]');
    if (favoriteBtn) {
      event.stopPropagation();
      toggleFavorite(favoriteBtn.dataset.favoriteId);
      return;
    }
    const cartBtn = event.target.closest('[data-shop-cart]');
    if (cartBtn) {
      const id = Number(cartBtn.dataset.shopCart);
      if (Number.isSafeInteger(id) && id >= 0 && typeof addToCart === 'function') addToCart(id);
      return;
    }
    const button = event.target.closest('[data-shop-product],[data-shop-buy]');
    if (button) {
      const id = Number(button.dataset.shopProduct ?? button.dataset.shopBuy);
      if (!Number.isSafeInteger(id) || id < 0) return;
      if (button.hasAttribute('data-shop-product') && typeof openProductDetail === 'function') openProductDetail(id);
      else if (typeof buyNowInstant === 'function') buyNowInstant(id);
      return;
    }
    const actionButton = event.target.closest('[data-store-action]');
    if (actionButton) {
      action(actionButton.dataset.storeAction);
      return;
    }
  });

  function updateMobileCartCount() {
    if (!mobileCount || !cartCountSource) return;
    const raw = cartCountSource.textContent.trim();
    const num = Number.parseInt(raw,10);
    const valid = Number.isFinite(num) && num > 0;
    mobileCount.textContent = valid ? String(num) : '0';
    mobileCount.hidden = !valid;
  }
  if (cartCountSource && mobileCount) {
    new MutationObserver(updateMobileCartCount).observe(cartCountSource, {childList:true,characterData:true,subtree:true});
    updateMobileCartCount();
  }

  // Phones see real featured products before the tall Flash Sale carousel.
  // Reorder DOM siblings without duplicating content or altering desktop order.
  const featuredSection = document.getElementById('featuredSection');
  const flashSaleSection = document.getElementById('flashSaleSection');
  if (featuredSection && flashSaleSection && featuredSection.parentNode === flashSaleSection.parentNode) {
    const narrowPhone = window.matchMedia('(max-width: 700px)');
    const arrangeProductSections = () => {
      const parent = featuredSection.parentNode;
      if (!parent || flashSaleSection.parentNode !== parent) return;
      if (narrowPhone.matches && featuredSection.nextElementSibling !== flashSaleSection) {
        parent.insertBefore(featuredSection, flashSaleSection);
      } else if (!narrowPhone.matches && flashSaleSection.nextElementSibling !== featuredSection) {
        parent.insertBefore(flashSaleSection, featuredSection);
      }
    };
    arrangeProductSections();
    narrowPhone.addEventListener('change', arrangeProductSections);
  }

  window.addEventListener('storefront:favorite-write', () => {
    saved = favorites();
    updateHeartButtons();
  });

  try {
    if (!featuredLoaded && typeof state !== 'undefined' && Array.isArray(state.products) && state.products.length) renderFeatured(state.products);
  } catch (_) { /* no storefront state available */ }
})();
