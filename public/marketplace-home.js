/* HOANG MINH STORE — Marketplace presentation layer.
   Only uses existing authenticated storefront functions and public product catalog.
   No fake ratings, orders, countdowns, promo codes or invented sale prices. */
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
    const discountBadge = Number.isFinite(discount) && discount > 0 && showOld
      ? '<span class="featured-badge">-' + Math.round(discount) + '%</span>' : '';
    const fallback = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="100%" height="100%" fill="#f8f8fa"/><text x="50%" y="50%" fill="#aab0b9" text-anchor="middle" dominant-baseline="central" font-size="20">HOANGMINH.COM</text></svg>'
    );
    const src = String(p.image || '');
    return '<article class="featured-card" data-product-id="' + id + '">' +
      '<button type="button" class="featured-media" data-shop-product="' + id + '" aria-label="Xem ' + escapeHTML(p.name) + '">' +
      '<img loading="lazy" src="' + escapeHTML(src || fallback) + '" alt="' + escapeHTML(p.name) +
      '" onerror="this.onerror=null;this.src=' + "'" + fallback.replace(/'/g, '') + "'" + '">' +
      '</button>' + discountBadge +
      '<button type="button" class="card-heart" data-favorite-id="' + id + '" aria-pressed="false" aria-label="Lưu sản phẩm"><i class="fa-regular fa-heart"></i></button>' +
      '<div class="featured-info">' +
      '<button type="button" class="featured-name" data-shop-product="' + id + '">' + escapeHTML(p.name) + '</button>' +
      '<strong class="featured-price">' + formatVND(p.price) + '</strong>' +
      (showOld ? '<span class="featured-old">' + formatVND(oldPrice) + '</span>' : '') +
      '<div class="featured-actions"><button type="button" class="featured-cart" data-shop-cart="' + id + '" aria-label="Thêm vào giỏ"' + (soldOut ? ' disabled' : '') + '><i class="fa-solid fa-cart-plus"></i></button>' +
      '<button type="button" class="featured-buy" data-shop-buy="' + id + '"' + (soldOut ? ' disabled' : '') + '>' +
      (soldOut ? 'Hết hàng' : 'Mua ngay') + '</button></div></div></article>';
  }
  function renderFeatured(products) {
    if (!section || !featuredGrid) return;
    const list = (Array.isArray(products) ? products : []).filter(p => numericId(p) !== null).slice(0,6);
    featuredGrid.innerHTML = list.map(featuredCard).join('');
    section.hidden = !list.length;
    updateHeartButtons();
  }

  window.addEventListener('storefront:products', event => {
    renderFeatured(event.detail && event.detail.products);
  });

  function jumpToCatalog() {
    const el = document.getElementById('catalog');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      case 'under500':
        document.querySelector('.price-pill[data-min="0"][data-max="500000"]')?.click();
        jumpToCatalog();
        break;
      case 'sort-low': {
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
    // Bấm danh mục: category-sheet.js cuộn tới danh sách sau khi sản phẩm vẽ xong (mọi khổ màn hình)
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

  // Keep all hearts consistent when a saved product is removed from the wishlist dialog.
  window.addEventListener('storefront:favorite-write', () => {
    saved = favorites();
    updateHeartButtons();
  });

  // The native product renderer emits the event after each successful product API refresh.
  // Also handle a restored view if integration loads the module after the product state.
  try {
    if (typeof state !== 'undefined' && Array.isArray(state.products) && state.products.length) renderFeatured(state.products);
  } catch (_) { /* no storefront state available */ }
})();
