/* Tài khoản KHÁCH SỈ: đăng nhập (đã duyệt) mới thấy giá sỉ; chưa đăng nhập = giá lẻ.
 * Giá luôn do máy chủ tính theo cookie – file này chỉ hiện nút, hộp đăng nhập/đăng ký và đặt
 * <body data-tier="wholesale|retail"> để chữ trên thẻ SP nói đúng loại giá. */
(() => {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let account = { logged_in: false, tier: 'retail', customer: null };

  function setTier(a) {
    account = a || account;
    document.body.dataset.tier = account.tier === 'wholesale' ? 'wholesale' : 'retail';
    renderButton();
    prefillCheckout();
    window.dispatchEvent(new CustomEvent('storefront:tier', { detail: account }));
  }

  /** Khách đã đăng nhập: điền sẵn họ tên + SĐT ở form đặt hàng (chỉ ô đang trống – không ghi đè). */
  function prefillCheckout() {
    const c = account.customer;
    if (!c) return;
    const name = document.getElementById('custName');
    const phone = document.getElementById('custPhone');
    if (name && !name.value.trim()) name.value = c.name;
    if (phone && !phone.value.trim()) phone.value = c.phone;
  }

  function renderButton() {
    const btn = document.getElementById('accountBtn');
    if (!btn) return;
    const c = account.customer;
    let line1 = 'Khách sỉ';
    let line2 = 'Đăng nhập';
    if (c && account.tier === 'wholesale') { line1 = esc(c.name.split(' ').pop()); line2 = '<b class="acct-tier-si">Giá sỉ</b>'; }
    else if (c) { line1 = esc(c.name.split(' ').pop()); line2 = '<b class="acct-tier-wait">Chờ duyệt</b>'; }
    btn.innerHTML = `<i class="fa-solid fa-user-tie"></i><span>${line1}<br>${line2}</span>`;
  }

  function modal() {
    let m = document.getElementById('accountModal');
    if (m) return m;
    m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.id = 'accountModal';
    m.setAttribute('aria-hidden', 'true');
    m.innerHTML = '<div class="modal-dialog checkout-dialog account-dialog"><div class="modal-top flex-between"><h3 id="acctTitle"></h3><button type="button" class="modal-close-icon" data-acct-close aria-label="Đóng">&times;</button></div><div id="acctBody"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-acct-close]')) close(); });
    return m;
  }
  const close = () => { const m = document.getElementById('accountModal'); if (m) { m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); } };

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' });
    const json = await res.json().catch(() => ({ success: false, error: 'Máy chủ không phản hồi.' }));
    if (!json.success) throw new Error(json.error || 'Không thực hiện được.');
    return json;
  }

  // Giỏ hàng + "đơn đã đặt trên máy này" nằm trong trình duyệt. Máy dùng chung (shop nhiều người):
  // đăng xuất, hoặc đăng nhập tài khoản KHÁC trên cùng máy → xoá, để người sau không thấy của người trước.
  // (Khách chưa đăng nhập bỏ hàng vào giỏ rồi mới đăng nhập thì giữ nguyên giỏ.)
  const OWNER_KEY = 'hm_acct_owner';
  const clearLocal = () => { try { ['hm_cart_v1', 'hm_my_orders', OWNER_KEY].forEach(k => localStorage.removeItem(k)); } catch (e) {} };
  /** Ghi máy này thuộc khách id; trả true nếu vừa xoá dữ liệu của khách trước. */
  function claimDevice(id) {
    let cleared = false;
    try {
      const prev = localStorage.getItem(OWNER_KEY);
      if (prev && prev !== id) { clearLocal(); cleared = true; }
      localStorage.setItem(OWNER_KEY, id);
    } catch (e) {}
    return cleared;
  }

  // Giá trên trang, trong giỏ, giá đẩy realtime đều theo cookie → tải lại để mọi thứ đổi cùng lúc
  const reloadPrices = msg => { try { sessionStorage.setItem('hm_acct_msg', msg || ''); } catch (e) {} location.reload(); };

  function show(view = 'login', note = '') {
    const m = modal();
    const title = m.querySelector('#acctTitle');
    const body = m.querySelector('#acctBody');
    const c = account.customer;
    if (c) {
      title.innerHTML = '<i class="fa-solid fa-user-tie"></i> Tài khoản khách sỉ';
      body.innerHTML = `<div class="acct-info">
          <div><strong>${esc(c.name)}</strong>${c.shop_name ? ` · ${esc(c.shop_name)}` : ''}</div>
          <div>SĐT: ${esc(c.phone)}</div>
          ${account.tier === 'wholesale'
            ? '<div class="acct-state ok"><i class="fa-solid fa-circle-check"></i> Đã duyệt – bạn đang xem và mua theo <b>giá sỉ</b>.</div>'
            : '<div class="acct-state wait"><i class="fa-regular fa-clock"></i> Đang chờ cửa hàng duyệt. Trong lúc chờ, giá hiển thị là giá lẻ.</div>'}
        </div>
        <h4 class="acct-orders-title"><i class="fa-solid fa-receipt"></i> Đơn hàng của tôi</h4>
        <div class="acct-orders" id="acctOrders"><p class="acct-empty"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải đơn hàng…</p></div>
        <div class="checkout-actions flex-between"><span></span><button type="button" class="btn-ghost" id="acctLogout"><i class="fa-solid fa-right-from-bracket"></i> Đăng xuất</button></div>`;
      body.querySelector('#acctLogout').onclick = async () => {
        try { await post('/api/account/logout'); clearLocal(); reloadPrices('Đã đăng xuất – đang xem giá lẻ.'); } catch (e) { showErr(e.message); }
      };
      loadOrders();
    } else if (view === 'register') {
      title.innerHTML = '<i class="fa-solid fa-user-plus"></i> Đăng ký khách sỉ';
      body.innerHTML = `<form class="checkout-form" id="acctForm">
          <p class="acct-lead">Dành cho shop / đại lý mua sỉ. Cửa hàng duyệt xong bạn sẽ thấy giá sỉ khi đăng nhập.</p>
          <div class="form-row"><div class="form-field"><label>Họ tên *</label><input name="name" required maxlength="80" autocomplete="name"></div>
          <div class="form-field"><label>Số điện thoại *</label><input name="phone" type="tel" required autocomplete="tel" placeholder="09xxxxxxxx"></div></div>
          <div class="form-row"><div class="form-field"><label>Tên shop / cửa hàng</label><input name="shop_name" maxlength="120" autocomplete="organization"></div>
          <div class="form-field"><label>Mật khẩu * (tối thiểu 6 ký tự)</label><input name="password" type="password" required minlength="6" autocomplete="new-password"></div></div>
          <div class="form-field"><label>Bạn bán ở đâu? (link Facebook/Shopee, địa chỉ shop…)</label><input name="note" maxlength="300"></div>
          <div class="acct-err" id="acctErr" hidden></div>
          <div class="checkout-actions flex-between"><button type="button" class="btn-ghost" data-acct-view="login">Đã có tài khoản? Đăng nhập</button><button type="submit" class="btn-primary"><i class="fa-solid fa-paper-plane"></i> Gửi đăng ký</button></div>
        </form>`;
    } else {
      title.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Đăng nhập khách sỉ';
      body.innerHTML = `<form class="checkout-form" id="acctForm">
          <p class="acct-lead">${note ? esc(note) : 'Giá trên web đang là <b>giá lẻ</b>. Khách sỉ đã được duyệt đăng nhập để xem và mua theo giá sỉ.'}</p>
          <div class="form-row"><div class="form-field"><label>Số điện thoại</label><input name="phone" type="tel" required autocomplete="username"></div>
          <div class="form-field"><label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password"></div></div>
          <div class="acct-err" id="acctErr" hidden></div>
          <div class="checkout-actions flex-between"><button type="button" class="btn-ghost" data-acct-view="register">Chưa có tài khoản? Đăng ký sỉ</button><button type="submit" class="btn-primary"><i class="fa-solid fa-right-to-bracket"></i> Đăng nhập</button></div>
        </form>`;
    }
    body.querySelectorAll('[data-acct-view]').forEach(b => { b.onclick = () => show(b.dataset.acctView); });
    const form = body.querySelector('#acctForm');
    if (form) form.onsubmit = async e => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const data = Object.fromEntries(new FormData(form).entries());
      btn.disabled = true;
      try {
        const json = await post(view === 'register' ? '/api/account/register' : '/api/account/login', data);
        const changedOwner = json.data.customer?.id ? claimDevice(json.data.customer.id) : false;
        if (json.data.tier === 'wholesale' || changedOwner) reloadPrices(json.message);
        else { setTier(json.data); show('login'); }
      } catch (err) {
        showErr(err.message);
      } finally {
        btn.disabled = false;
      }
    };
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
  }
  // ───────────── Đơn hàng của tôi ─────────────
  let orders = [];
  const money = n => `${Number(n || 0).toLocaleString('vi-VN')} đ`;
  const when = iso => new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function loadOrders() {
    const box = document.getElementById('acctOrders');
    if (!box) return;
    try {
      const res = await fetch('/api/account/orders', { credentials: 'same-origin', cache: 'no-store' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Không tải được đơn hàng.');
      orders = json.data || [];
      box.innerHTML = orders.length
        ? orders.map(orderCard).join('')
        : '<p class="acct-empty">Chưa có đơn nào. Các đơn bạn đặt khi đã đăng nhập sẽ hiện ở đây.</p>';
      box.querySelectorAll('[data-reorder]').forEach(b => { b.onclick = () => reorder(b.dataset.reorder, b); });
    } catch (e) {
      box.innerHTML = `<p class="acct-err">${esc(e.message)}</p>`;
    }
  }

  function orderCard(o) {
    const [label, color] = (typeof STATUS_VI !== 'undefined' && STATUS_VI[o.status]) || [o.status, '#64748b'];
    const count = o.items.reduce((s, i) => s + i.quantity, 0);
    const items = o.items.map(i => `<div class="acct-oi"><span>${esc(i.name)}${i.variant_name ? ` <em>[${esc(i.variant_name)}]</em>` : ''} × ${i.quantity}</span><span>${money(i.price * i.quantity)}</span></div>`).join('');
    // Dùng lại khối ngày giao + mã vận đơn của trang tra cứu đơn (app.js)
    const track = (typeof deliveryBlock === 'function' ? deliveryBlock(o) : '') + (o.shipping_ref_code && typeof shipmentBlock === 'function' ? shipmentBlock(o) : '');
    return `<details class="acct-order">
      <summary>
        <span class="acct-oid">#${esc(o.id)}</span>
        <span class="acct-odate">${when(o.created_at)} · ${count} món</span>
        <span class="acct-ost" style="color:${color}">${esc(label)}</span>
        <strong class="acct-ototal">${money(o.total_amount)}</strong>
      </summary>
      <div class="acct-obody">
        ${items}
        <div class="acct-oi"><span>Phí vận chuyển</span><span>${o.shipping_fee ? money(o.shipping_fee) : 'Miễn phí'}</span></div>
        <div class="acct-oi acct-ometa"><span>${o.payment_method === 'COD' ? 'Thanh toán khi nhận hàng' : 'Chuyển khoản'}${o.price_tier === 'wholesale' ? ' · giá sỉ' : o.price_tier === 'retail' ? ' · giá lẻ' : ''}</span><span>Giao tới: ${esc([o.address, o.customer?.ward_name, o.customer?.province].filter(Boolean).join(', '))}</span></div>
        ${o.cancel_reason ? `<div class="acct-oi acct-ometa"><span>Lý do huỷ: ${esc(o.cancel_reason)}</span></div>` : ''}
        ${track}
        <div class="acct-oactions">${o.status === 'COMPLETED' && o.access_key ? `<a class="btn-ghost" href="/danh-gia/${encodeURIComponent(o.id)}?k=${encodeURIComponent(o.access_key)}"><i class="fa-solid fa-star"></i> Đánh giá</a>` : ''}<button type="button" class="btn-primary" data-reorder="${esc(o.id)}"><i class="fa-solid fa-rotate-right"></i> Mua lại đơn này</button></div>
      </div>
    </details>`;
  }

  /** Cho lại các món của đơn vào giỏ theo giá & tồn kho HIỆN TẠI (giá đơn cũ có thể đã đổi). */
  async function reorder(id, btn) {
    const o = orders.find(x => x.id === id);
    if (!o || typeof addLineToCart !== 'function' || typeof cartLine !== 'function') return;
    btn.disabled = true;
    const skipped = [];
    let added = 0;
    for (const it of o.items) {
      const label = it.name + (it.variant_name ? ` [${it.variant_name}]` : '');
      try {
        const res = await fetch(`/api/products/${encodeURIComponent(it.id)}`, { credentials: 'same-origin' });
        const json = res.ok ? await res.json() : null;
        const p = json && json.success ? json.data : null;
        if (!p || p.in_stock === false) { skipped.push(`${label} (hết hàng)`); continue; }
        const vs = Array.isArray(p.variants) ? p.variants : [];
        const v = it.variation_id ? vs.find(x => String(x.id) === String(it.variation_id)) || null : null;
        if (!v && vs.length > 1) { skipped.push(`${label} (phân loại không còn)`); continue; }
        if (v && v.in_stock === false) { skipped.push(`${label} (hết hàng)`); continue; }
        if (typeof productCache !== 'undefined' && productCache.set) productCache.set(p.id, p);
        addLineToCart(cartLine(p, Math.min(50, it.quantity), v));
        added++;
      } catch (e) {
        skipped.push(`${label} (chưa tải được)`);
      }
    }
    btn.disabled = false;
    if (added) {
      close();
      if (typeof openCartDrawer === 'function') openCartDrawer();
    }
    const msg = added
      ? `Đã cho ${added} món vào giỏ theo giá hiện tại.${skipped.length ? ' Không thêm được: ' + skipped.join(', ') + '.' : ''}`
      : `Không thêm được món nào: ${skipped.join(', ')}.`;
    if (skipped.length && window.uiAlert) window.uiAlert(msg);
    else if (window.showToast) window.showToast(msg);
  }

  function showErr(msg) {
    const el = document.getElementById('acctErr');
    if (el) { el.hidden = false; el.textContent = msg; } else if (window.uiAlert) window.uiAlert(msg);
  }

  window.HM_ACCOUNT = { get: () => account, open: show, isWholesale: () => account.tier === 'wholesale' };
  // Bắt ở pha capture: nút nằm trong thẻ SP thì không mở luôn chi tiết SP
  document.addEventListener('click', e => {
    const t = e.target.closest('#accountBtn, [data-store-action="account"]');
    if (t) { e.preventDefault(); e.stopPropagation(); show(t.dataset.acctView || 'login'); }
  }, true);

  document.body.dataset.tier = 'retail';
  fetch('/api/account/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(r => r.json()).then(j => j.success && setTier(j.data)).catch(() => setTier(null));
  try {
    const msg = sessionStorage.getItem('hm_acct_msg');
    if (msg) { sessionStorage.removeItem('hm_acct_msg'); setTimeout(() => (window.showToast ? window.showToast(msg) : null), 600); }
  } catch (e) {}
})();
