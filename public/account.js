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
    window.dispatchEvent(new CustomEvent('storefront:tier', { detail: account }));
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
        <div class="checkout-actions flex-between"><span></span><button type="button" class="btn-ghost" id="acctLogout"><i class="fa-solid fa-right-from-bracket"></i> Đăng xuất</button></div>`;
      body.querySelector('#acctLogout').onclick = async () => {
        try { await post('/api/account/logout'); reloadPrices('Đã đăng xuất – đang xem giá lẻ.'); } catch (e) { showErr(e.message); }
      };
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
        if (json.data.tier === 'wholesale') reloadPrices(json.message);
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
