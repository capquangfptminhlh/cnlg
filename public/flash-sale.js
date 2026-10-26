/* HOÀNG MINH STORE — Flash Sale Khung Giờ, Hiệu Ứng Đơn Hàng Liên Tục & Khan Hiếm Kích Thích Mua Hàng
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
    const fireWidth = Math.min(94, Math.max(58, 46 + discount));
    const fireLabel = discount >= 45 ? `GIẢM SỐC -${discount}%` : 'SẮP CHÁY KHO';
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
        <div class="fs-fire-bar" aria-label="${escHtml(fireLabel)}">
          <span class="fs-fire-fill" style="width:${fireWidth}%"></span>
          <span class="fs-fire-text"><i class="fa-solid fa-fire"></i> ${escHtml(fireLabel)}</span>
        </div>
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
      startLiveOrderStream();
    } catch (_) {
      startLiveOrderStream();
    }
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

  // =========================================================================
  // 1. HIỆU ỨNG ĐƠN HÀNG NHẢY LIÊN TỤC (LIVE SOCIAL PROOF ORDER STREAM)
  // =========================================================================
  const BUYERS = [
    ['Anh Minh Tuấn', '098***412', 'TP. Hồ Chí Minh'],
    ['Chị Lan Anh', '091***836', 'Hà Nội'],
    ['Anh Quốc Bảo', '090***205', 'Đà Nẵng'],
    ['Chị Thu Hà', '038***619', 'Bình Dương'],
    ['Anh Hoàng Nam', '097***540', 'Đồng Nai'],
    ['Chị Ngọc Mai', '093***128', 'Hải Phòng'],
    ['Anh Đức Huy', '035***904', 'Cần Thơ'],
    ['Chị Phương Thảo', '096***371', 'Bắc Ninh'],
    ['Anh Gia Hưng', '086***752', 'Khánh Hòa'],
    ['Chị Thanh Trúc', '094***663', 'Quảng Ninh'],
    ['Anh Trọng Nghĩa', '039***185', 'Nghệ An'],
    ['Chị Mỹ Linh', '070***490', 'Bà Rịa - Vũng Tàu'],
    ['Anh Hải Đăng', '092***817', 'Thanh Hóa'],
    ['Chị Khánh Vy', '089***234', 'Lâm Đồng'],
    ['Anh Tiến Đạt', '037***509', 'Long An'],
    ['Chị Kim Ngân', '079***941', 'Hưng Yên'],
    ['Anh Minh Khôi', '098***167', 'TP. Hồ Chí Minh'],
    ['Chị Bảo Châu', '091***723', 'Hà Nội'],
    ['Anh Quang Vinh', '093***658', 'Bình Định'],
    ['Chị Yến Nhi', '036***402', 'Thái Nguyên']
  ];
  const ORDER_VERBS = [
    'vừa chốt đơn giá sỉ',
    'vừa đặt mua 2 sản phẩm',
    'vừa săn thành công Flash Sale',
    'vừa đặt đơn COD',
    'vừa chốt nhanh 3 món giá sỉ',
    'vừa giữ suất ưu đãi'
  ];
  const ORDER_TIMES = ['Vừa xong', '6 giây trước', '14 giây trước', '25 giây trước', '42 giây trước', '1 phút trước'];

  let orderToastEl = null;
  let orderLoopTimer = null;
  let orderHideTimer = null;
  let orderHover = false;
  let orderMuted = false;
  let orderCursor = Math.floor(Math.random() * BUYERS.length);
  let prodCursor = 0;

  function candidateProducts() {
    const map = new Map();
    for (const p of fsItems) {
      if (p && p.in_stock !== false && p.image) map.set(p.id, p);
    }
    if (typeof state !== 'undefined' && Array.isArray(state.products)) {
      for (const p of state.products) {
        if (p && p.in_stock !== false && p.image && !map.has(p.id)) map.set(p.id, p);
      }
    }
    return [...map.values()];
  }

  function ensureOrderToast() {
    if (orderToastEl) return orderToastEl;
    orderToastEl = document.createElement('aside');
    orderToastEl.className = 'fs-live-spotlight hm-live-order-toast';
    orderToastEl.id = 'fsLiveSpotlight';
    orderToastEl.setAttribute('aria-label', 'Thông báo đơn hàng mới');
    orderToastEl.addEventListener('mouseenter', () => {
      orderHover = true;
      clearTimeout(orderHideTimer);
    });
    orderToastEl.addEventListener('mouseleave', () => {
      orderHover = false;
      scheduleNextOrderToast(1600);
    });
    orderToastEl.addEventListener('click', e => {
      if (e.target.closest('.fs-spot-close')) {
        orderMuted = true;
        orderToastEl.classList.remove('is-shown');
        clearTimeout(orderLoopTimer);
        clearTimeout(orderHideTimer);
        return;
      }
      const id = Number(orderToastEl.dataset.productId);
      if (Number.isSafeInteger(id) && id > 0 && typeof openProductDetail === 'function') {
        orderToastEl.classList.remove('is-shown');
        openProductDetail(id);
      }
    });
    document.body.appendChild(orderToastEl);
    return orderToastEl;
  }

  function isBlockingModalOpen() {
    return ['checkoutModal', 'qrModal', 'trackModal'].some(id => document.getElementById(id)?.classList.contains('open'))
      || document.getElementById('cartDrawer')?.classList.contains('open')
      || document.body.classList.contains('cat-sheet-open')
      || (window.innerWidth <= 760 && document.getElementById('productDetailModal')?.classList.contains('open'));
  }

  function scheduleNextOrderToast(delayMs) {
    clearTimeout(orderLoopTimer);
    if (orderMuted || reducedMotion.matches) return;
    orderLoopTimer = setTimeout(popOrderToast, delayMs);
  }

  function popOrderToast() {
    if (orderMuted || reducedMotion.matches) return;
    if (document.hidden || orderHover || isBlockingModalOpen()) {
      scheduleNextOrderToast(2800);
      return;
    }
    const pool = candidateProducts();
    if (!pool.length) {
      scheduleNextOrderToast(2500);
      return;
    }
    const buyer = BUYERS[orderCursor % BUYERS.length];
    const verb = ORDER_VERBS[(orderCursor * 3 + prodCursor) % ORDER_VERBS.length];
    const ago = ORDER_TIMES[(orderCursor + prodCursor) % ORDER_TIMES.length];
    const item = pool[prodCursor % pool.length];
    orderCursor++;
    prodCursor++;

    const el = ensureOrderToast();
    el.dataset.productId = String(item.id);
    const disc = Number(item.discount_percent) || 0;
    el.innerHTML = `
      <div class="hm-order-thumb-wrap">
        <img class="fs-spot-thumb" src="${escHtml(item.image)}" alt="" loading="lazy">
        <span class="hm-order-check"><i class="fa-solid fa-check"></i></span>
      </div>
      <div class="fs-spot-info">
        <div class="hm-order-buyer">
          <strong>${escHtml(buyer[0])}</strong> <small>(${escHtml(buyer[1])} · ${escHtml(buyer[2])})</small>
        </div>
        <div class="hm-order-action">${escHtml(verb)}: <b>${escHtml(item.name)}</b></div>
        <div class="fs-spot-price">
          <strong>${fmtPrice(item.price)}</strong>
          ${disc > 0 ? `<span>-${disc}%</span>` : '<span>Giá sỉ</span>'}
          <em class="hm-order-time"><i class="fa-solid fa-circle-check"></i> ${escHtml(ago)}</em>
        </div>
      </div>
      <button type="button" class="fs-spot-close" aria-label="Tắt thông báo đơn hàng">&times;</button>`;

    el.classList.remove('is-shown');
    void el.offsetWidth;
    el.classList.add('is-shown');

    clearTimeout(orderHideTimer);
    orderHideTimer = setTimeout(() => {
      if (!orderHover) {
        el.classList.remove('is-shown');
        const nextGap = 1200 + Math.floor(Math.random() * 1000);
        scheduleNextOrderToast(nextGap);
      }
    }, 4000);
  }

  function startLiveOrderStream() {
    if (orderLoopTimer || orderMuted || reducedMotion.matches) return;
    scheduleNextOrderToast(800);
  }

  window.addEventListener('storefront:products', () => {
    if (!orderToastEl || !orderToastEl.classList.contains('is-shown')) {
      scheduleNextOrderToast(600);
    }
  });
  window.addEventListener('storefront:flash-sale-rendered', () => {
    if (!orderToastEl || !orderToastEl.classList.contains('is-shown')) {
      scheduleNextOrderToast(600);
    }
  });

  // =========================================================================
  // 2. HIỆU ỨNG KHAN HIẾM TRỰC TIẾP TRONG TRANG CHI TIẾT SẢN PHẨM
  // =========================================================================
  let detailUrgencyTimer = null;
  let detailDropTimer = null;

  function stopDetailUrgency() {
    clearInterval(detailUrgencyTimer);
    clearTimeout(detailDropTimer);
    detailUrgencyTimer = null;
    detailDropTimer = null;
  }

  window.addEventListener('storefront:detail-open', () => {
    stopDetailUrgency();
    if (reducedMotion.matches) return;
    const modal = document.getElementById('productDetailModal');
    if (!modal) return;

    // Nhịp người đang xem trực tuyến tăng/giảm tự nhiên
    detailUrgencyTimer = setInterval(() => {
      if (!modal.classList.contains('open')) {
        stopDetailUrgency();
        return;
      }
      const vEl = document.getElementById('detailViewerCount');
      if (vEl) {
        const cur = Number.parseInt(vEl.textContent, 10) || 12;
        const delta = Math.random() > 0.45 ? 1 : -1;
        const next = Math.max(6, Math.min(39, cur + delta));
        vEl.textContent = String(next);
      }
    }, 3200);

    // Sau 4.2s khách đang xem: giảm nhẹ 1 suất còn lại để kích thích chốt đơn ngay
    detailDropTimer = setTimeout(() => {
      if (!modal.classList.contains('open')) return;
      const leftEl = document.getElementById('detailUrgentLeft');
      const box = modal.querySelector('.detail-urgency-box');
      if (!leftEl || !box) return;
      const cur = Number.parseInt(leftEl.textContent, 10) || 3;
      if (cur > 2) {
        leftEl.textContent = String(cur - 1);
        box.classList.remove('is-just-claimed');
        void box.offsetWidth;
        box.classList.add('is-just-claimed');
      }
    }, 4200);
  });

  if (section && track) {
    loadFlashSale();
  } else {
    startLiveOrderStream();
  }
})();
