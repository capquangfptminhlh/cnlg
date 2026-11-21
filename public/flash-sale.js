/* HOÀNG MINH STORE — Flash Sale theo khung giờ (SP đổi theo khung 3 giờ, đếm ngược tới khung sau).
   Chỉ hiện số liệu thật: giá, % giảm, bảo hành. Không có đơn hàng / người xem / số suất bịa.
   - Đồng bộ trực tiếp với /api/flash-sale và Socket.IO PRODUCTS_UPDATED. */
(() => {
  'use strict';

  const section = document.getElementById('flashSaleSection');
  const track = document.getElementById('fsTrack');
  const slotBadge = document.getElementById('fsSlotBadge');
  const elH = document.getElementById('fsHours');
  const elM = document.getElementById('fsMinutes');
  const elS = document.getElementById('fsSeconds');
  const viewAllBtn = document.getElementById('fsViewAllBtn');
  const prevBtn = document.getElementById('fsPrevBtn');
  const nextBtn = document.getElementById('fsNextBtn');
  const promoFlashCount = document.getElementById('promoFlashCount');
  const promoUnder99Count = document.getElementById('promoUnder99Count');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let fsItems = [];
  let slotEndsAtMs = 0;
  let cdTimer = null;
  let reloadingSlot = false;

  function escHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function fmtPrice(n) {
    const num = Number(n);
    return Number.isFinite(num) ? num.toLocaleString('vi-VN') + ' đ' : 'Liên hệ';
  }

  function fmtCompact(n) {
    const val = Math.max(0, Math.round(Number(n) || 0));
    if (val >= 1000000) return (val / 1000000).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + 'TR';
    if (val >= 1000) return Math.round(val / 1000).toLocaleString('vi-VN') + 'K';
    return val.toLocaleString('vi-VN') + 'đ';
  }

  function pad2(n) {
    return String(Math.max(0, Math.floor(n))).padStart(2, '0');
  }

  function setDigit(el, nextVal) {
    if (!el || el.textContent === nextVal) return;
    el.textContent = nextVal;
    if (!reducedMotion.matches) {
      el.classList.remove('is-ticking');
      void el.offsetWidth;
      el.classList.add('is-ticking');
    }
  }

  function renderCard(p) {
    const id = Number(p.id);
    if (!Number.isSafeInteger(id) || id <= 0) return '';
    const price = Number(p.price) || 0;
    const oldPrice = Number(p.original_price) || 0;
    const hasOld = oldPrice > price;
    const discount = hasOld ? Math.max(0, Math.round(Number(p.discount_percent) || ((1 - price / oldPrice) * 100))) : 0;
    const savedAmt = hasOld ? oldPrice - price : 0;
    const warrantyText = p.warranty || 'Không bảo hành';
    const fallbackSvg = 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="100%" height="100%" fill="#fff7f4"/><text x="50%" y="50%" fill="#d97757" text-anchor="middle" dominant-baseline="central" font-size="18">Hoang Minh Store</text></svg>'
    );

    return `<article class="fs-card" role="listitem" data-id="${id}" data-product-id="${id}">
      <button type="button" class="fs-media" data-shop-product="${id}" aria-label="Xem ${escHtml(p.name)}">
        <img loading="lazy" src="${escHtml(p.image || fallbackSvg)}" alt="${escHtml(p.name)}">
      </button>
      <span class="card-tag tag-flash"><i class="fa-solid fa-bolt"></i> GIÁ SỈ</span>
      ${discount >= 10 ? `<span class="card-corner-off"><b>-${discount}%</b><small>GIẢM</small></span>` : ''}
      <button type="button" class="card-heart" data-favorite-id="${id}" aria-pressed="false" aria-label="Lưu sản phẩm"><i class="fa-regular fa-heart"></i></button>
      <div class="fs-body">
        <button type="button" class="fs-title" data-shop-product="${id}" title="${escHtml(p.name)}">${escHtml(p.name)}</button>
        <div class="fs-price-row">
          <strong class="fs-price">${fmtPrice(price)}</strong>
          ${hasOld ? `<span class="fs-old-price">${fmtPrice(oldPrice)}</span>` : ''}
        </div>
        ${savedAmt >= 3000
          ? `<span class="si-save-chip"><i class="fa-solid fa-fire-flame-curved"></i> Rẻ hơn ${fmtCompact(savedAmt)}</span>`
          : `<span class="si-save-chip is-base"><i class="fa-solid fa-check-double"></i> Lẻ = Giá sỉ</span>`}
        <div class="fs-warranty-line"><i class="fa-solid fa-shield-halved"></i> ${escHtml(warrantyText)}</div>
        <div class="fs-actions">
          <button type="button" class="fs-cart-btn" data-shop-cart="${id}" aria-label="Thêm vào giỏ"><i class="fa-solid fa-cart-plus"></i></button>
          <button type="button" class="fs-buy-btn" data-shop-buy="${id}">Chốt Giá Sỉ</button>
        </div>
      </div>
    </article>`;
  }

  function renderTrack() {
    if (!section || !track) return;
    const active = fsItems.filter(p => p && p.in_stock !== false);
    if (!active.length) {
      section.hidden = true;
      return;
    }
    track.innerHTML = active.map(renderCard).join('');
    section.hidden = false;
    window.dispatchEvent(new Event('storefront:flash-sale-rendered'));
  }

  function tickCountdown() {
    if (!slotEndsAtMs) return;
    const diffSec = Math.max(0, Math.floor((slotEndsAtMs - Date.now()) / 1000));
    const h = Math.floor(diffSec / 3600);
    const m = Math.floor((diffSec % 3600) / 60);
    const s = diffSec % 60;
    setDigit(elH, pad2(h));
    setDigit(elM, pad2(m));
    setDigit(elS, pad2(s));
    if (diffSec <= 0 && !reloadingSlot) {
      reloadingSlot = true;
      setTimeout(() => {
        reloadingSlot = false;
        loadFlashSale();
      }, 1500);
    }
  }

  async function loadFlashSale() {
    try {
      const res = await fetch('/api/flash-sale');
      const json = await res.json();
      if (!json.success || !json.data) return;
      const { slotLabel, slotEndsAt, stats, items } = json.data;
      fsItems = Array.isArray(items) ? items : [];
      if (typeof rememberProducts === 'function') rememberProducts(fsItems);

      if (slotBadge && slotLabel) {
        slotBadge.innerHTML = `<span class="fs-live-dot"></span> Khung ${escHtml(slotLabel)} · Đang nổ deal`;
      }
      if (stats) {
        if (promoFlashCount && stats.totalFlashSale) {
          promoFlashCount.innerHTML = `${Number(stats.totalFlashSale).toLocaleString('vi-VN')} deal giảm tới 70% <i class="fa-solid fa-arrow-right"></i>`;
        }
        if (promoUnder99Count && stats.under99kCount) {
          promoUnder99Count.innerHTML = `${Number(stats.under99kCount).toLocaleString('vi-VN')} món dưới 99K <i class="fa-solid fa-arrow-right"></i>`;
        }
        if (viewAllBtn && stats.totalFlashSale) {
          viewAllBtn.innerHTML = `Xem tất cả ${Number(stats.totalFlashSale).toLocaleString('vi-VN')} Deal <i class="fa-solid fa-chevron-right"></i>`;
        }
      }
      const parsedEnd = Date.parse(slotEndsAt);
      if (Number.isFinite(parsedEnd)) {
        slotEndsAtMs = parsedEnd;
        tickCountdown();
        if (!cdTimer) cdTimer = setInterval(tickCountdown, 1000);
      }
      renderTrack();
    } catch (_) {}
  }

  prevBtn?.addEventListener('click', () => {
    if (!track) return;
    const step = Math.max(240, Math.round(track.clientWidth * 0.82));
    track.scrollBy({ left: -step, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  });

  nextBtn?.addEventListener('click', () => {
    if (!track) return;
    const step = Math.max(240, Math.round(track.clientWidth * 0.82));
    track.scrollBy({ left: step, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  });

  viewAllBtn?.addEventListener('click', () => {
    if (typeof state !== 'undefined' && state.currentCategory !== 'all') {
      document.querySelector('#categoriesContainer .cat-btn[data-id="all"]')?.click();
    }
    document.querySelector('.price-pill[data-flash="1"]')?.click();
    document.getElementById('catalog')?.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
  });

  if (typeof socket !== 'undefined' && socket && typeof socket.on === 'function') {
    socket.on('PRODUCTS_UPDATED', payload => {
      const patches = Array.isArray(payload?.items) ? payload.items : [];
      if (!patches.length || !fsItems.length) return;
      let dirty = false;
      for (const patch of patches) {
        const hit = fsItems.find(x => x.id === patch.id);
        if (hit) {
          Object.assign(hit, patch);
          dirty = true;
        }
      }
      if (dirty) renderTrack();
    });
  }

  if (section && track) loadFlashSale();
})();
