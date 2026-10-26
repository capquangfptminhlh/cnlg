const socket = io();

const statProducts = document.getElementById('statProducts');
const statOrders = document.getElementById('statOrders');
const statRevenue = document.getElementById('statRevenue');
const syncNowBtn = document.getElementById('syncNowBtn');
const configForm = document.getElementById('configForm');
const ordersTableBody = document.getElementById('ordersTableBody');

// Form inputs
const cfgSimulationMode = document.getElementById('cfgSimulationMode');
const cfgBankId = document.getElementById('cfgBankId');
const cfgAccountNo = document.getElementById('cfgAccountNo');
const cfgAccountName = document.getElementById('cfgAccountName');

function formatPrice(number) {
  return (number || 0).toLocaleString('vi-VN') + ' đ';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// API quản trị cần mật khẩu (header x-admin-key). Mật khẩu: biến ADMIN_PASSWORD trong .env,
// hoặc mật khẩu server tự sinh ở data/admin-secret.json (in ra console khi khởi động).
const ADMIN_KEY_STORE = 'hm_admin_key';
socket.on('connect', () => {
  const k = sessionStorage.getItem(ADMIN_KEY_STORE) || '';
  if (k) socket.emit('join-admin', k);
});
async function logoutAdminPortal() {
  if (!(await uiConfirm('Khoá phiên quản trị trên trình duyệt này?'))) return;
  try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
  try { sessionStorage.removeItem(ADMIN_KEY_STORE); } catch (e) {}
  location.reload();
}
// Hỏi mật khẩu quản trị 1 lần cho mọi request đang chờ; kiểm tra với server trước khi lưu, sai thì hỏi lại.
let adminKeyAsk = null;
function askAdminKey() {
  if (!adminKeyAsk) {
    adminKeyAsk = (async () => {
      let note = '';
      for (;;) {
        const entered = await uiPrompt(`${note}Nhập mật khẩu quản trị (biến ADMIN_PASSWORD trong .env, hoặc mật khẩu tự sinh trong data/admin-secret.json):`, { type: 'password', ok: 'Đăng nhập' });
        if (!entered) return null;
        const r = await fetch('/api/admin/session', { headers: { 'x-admin-key': entered.trim() } });
        if (r.ok) {
          sessionStorage.setItem(ADMIN_KEY_STORE, entered.trim());
          socket.emit('join-admin', entered.trim());
          return entered.trim();
        }
        if (r.status === 429) {
          const j = await r.json().catch(() => ({}));
          await uiAlert(j.error || 'Sai mật khẩu quá nhiều lần, thử lại sau.');
          return null;
        }
        note = 'Sai mật khẩu quản trị. ';
      }
    })().finally(() => setTimeout(() => { adminKeyAsk = null; }, 0));
  }
  return adminKeyAsk;
}

async function adminFetch(url, opts = {}, retry = true) {
  const key = sessionStorage.getItem(ADMIN_KEY_STORE) || '';
  const headers = { ...(opts.headers || {}), ...(key ? { 'x-admin-key': key } : {}) };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && retry) {
    sessionStorage.removeItem(ADMIN_KEY_STORE);
    const entered = await askAdminKey();
    if (!entered) throw new Error('Chưa đăng nhập quản trị');
    return adminFetch(url, opts, false);
  }
  if (res.status === 401) {
    sessionStorage.removeItem(ADMIN_KEY_STORE);
    throw new Error('Sai mật khẩu quản trị');
  }
  return res;
}

const STATUS_LABEL = {
  CONFIRMED: ['pending', 'COD – CHỜ ĐẶT KHO'],
  PENDING_PAYMENT: ['pending', 'CHỜ THANH TOÁN'],
  PAYMENT_REPORTED: ['reported', 'KHÁCH BÁO ĐÃ CK'],
  PAID: ['paid', 'ĐÃ THANH TOÁN'],
  PROCESSING: ['paid', 'ĐANG XỬ LÝ'],
  COMPLETED: ['paid', 'HOÀN TẤT'],
  CANCELLED: ['cancelled', 'ĐÃ HUỶ']
};

async function loadData() {
  // Load stats & config
  try {
    const [cfgRes, ordRes, prodRes] = await Promise.all([
      adminFetch('/api/admin/config').then(r => r.json()),
      adminFetch('/api/admin/orders').then(r => r.json()),
      fetch('/api/products?limit=1').then(r => r.json())
    ]);

    // Fill Config
    if (cfgRes.success && cfgRes.data) {
      const cfg = cfgRes.data;
      if (document.getElementById('dropbuyLoginUser')) {
        document.getElementById('dropbuyLoginUser').value = cfg.dropbuy?.username || '';
      }
      cfgSimulationMode.checked = cfg.dropbuy?.simulationMode !== false;
      cfgBankId.value = cfg.bank?.bankId || '970422';
      cfgAccountNo.value = cfg.bank?.accountNo || '';
      cfgAccountName.value = cfg.bank?.accountName || '';
      // Cảnh báo nếu vẫn là số tài khoản mẫu có sẵn trong mã nguồn ban đầu
      const warn = document.getElementById('bankWarning');
      if (warn) warn.style.display = !cfg.bank?.accountNo || cfg.bank.accountNo === '0386888999' ? 'block' : 'none';
    }

    // Fill Stats
    if (prodRes.success) {
      statProducts.innerText = (prodRes.total || 0).toLocaleString('vi-VN');
    }

    if (ordRes.success && ordRes.data) {
      const orders = ordRes.data;
      const real = orders.filter(o => !o.is_test);
      statOrders.innerText = real.length;
      const waiting = real.filter(o => o.dropbuy_sync?.status === 'WAITING_STAFF' && o.status !== 'CANCELLED').length;
      const statWaiting = document.getElementById('statWaiting');
      if (statWaiting) {
        statWaiting.innerText = waiting;
        statWaiting.style.color = waiting ? '#e8462c' : '#16a34a';
      }

      // Giống báo cáo: chuyển khoản đã nhận tiền, COD đã giao xong; bỏ đơn thử
      const revenue = real
        .filter(o => (o.payment_method === 'COD' ? o.status === 'COMPLETED' : ['PAID', 'PROCESSING', 'COMPLETED'].includes(o.status)))
        .reduce((sum, o) => sum + (o.total_amount || 0), 0);
      statRevenue.innerText = formatPrice(revenue);

      renderOrders(orders);
    }

  } catch (err) {
    console.error('Lỗi tải dữ liệu admin:', err);
  }
}

let orderFilterState = { status: 'all', q: '', hideTest: true };

const MODULE_META = {
  'overview': ['Tổng quan & Doanh thu', 'Thống kê doanh thu thực thu, lợi nhuận gộp và sản phẩm bán chạy'],
  'orders': ['Quản lý Đơn hàng', 'Theo dõi, lọc trạng thái và đặt đơn khách sang kho DropBuy'],
  'pricing-rules': ['Công thức Tính giá bán', 'Thiết lập giá gốc CTV/Flash Sale, % lãi mặc định và % lãi theo danh mục'],
  'pricing-products': ['Bảng giá từng Sản phẩm', 'Tra cứu giá vốn và đặt giá bán riêng cho từng sản phẩm trong kho'],
  'auto-order': ['Tự đặt đơn & Thanh toán', 'Cấu hình tự động đẩy đơn sang DropBuy và phương thức thanh toán mở cho khách'],
  'shipping': ['Cấu hình Vận chuyển', 'Thiết lập phí ship thật theo Phường/Xã từ kho DropBuy và hạn thanh toán'],
  'payments': ['Ngân hàng & Đối soát CK', 'Cấu hình tài khoản nhận tiền VietQR và lịch sử Webhook SePay / Casso'],
  'dropbuy': ['Kết nối Kho DropBuy', 'Quản lý tài khoản đại lý DropBuy, đồng bộ Realtime và kiểm tra kết nối API'],
  'techmall': ['Kho TechMall.vn & Giá riêng', 'Đăng nhập đại lý TechMall lấy giá sỉ, cài đặt % lãi riêng và đồng bộ realtime 5 phút/lần']
};

function toggleAdminSidebar(open) {
  const sb = document.getElementById('adminSidebar');
  const bd = document.getElementById('sidebarBackdrop');
  if (!sb || !bd) return;
  const show = open === undefined ? !sb.classList.contains('open') : !!open;
  sb.classList.toggle('open', show);
  bd.classList.toggle('open', show);
}

function switchAdminModule(modName, pushHash = true) {
  // Hỗ trợ tên cũ 'pricing' / 'order-setup' / 'reports' nếu có bookmark
  const alias = { pricing: 'pricing-rules', 'order-setup': 'auto-order', reports: 'overview' };
  const normalized = alias[modName] || modName;
  const target = MODULE_META[normalized] ? normalized : 'orders';
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.target === target);
  });
  document.querySelectorAll('.admin-module-pane').forEach(pane => {
    pane.classList.toggle('active', pane.dataset.module === target);
  });
  const [title, sub] = MODULE_META[target];
  const titleEl = document.getElementById('topbarModuleTitle');
  const subEl = document.getElementById('topbarModuleSub');
  if (titleEl) titleEl.innerText = title;
  if (subEl) subEl.innerText = sub;
  toggleAdminSidebar(false);
  if (pushHash && history.replaceState) {
    history.replaceState(null, '', '#' + target);
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (target === 'techmall') loadTechmallAll();
}

function setOrderQuickFilter(filterKey) {
  orderFilterState.status = filterKey || 'all';
  document.querySelectorAll('#orderFilterPills .order-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === orderFilterState.status);
  });
  if (lastOrders.length) renderOrders(lastOrders);
}

window.addEventListener('DOMContentLoaded', () => {
  const hideTestEl = document.getElementById('orderHideTest');
  if (hideTestEl) orderFilterState.hideTest = !!hideTestEl.checked;

  const initialHash = (location.hash || '').replace(/^#/, '');
  if (initialHash) switchAdminModule(initialHash, false);
  window.addEventListener('hashchange', () => {
    const h = (location.hash || '').replace(/^#/, '');
    if (h) switchAdminModule(h, false);
  });
  const searchEl = document.getElementById('orderSearchInput');
  if (searchEl) {
    searchEl.addEventListener('input', e => {
      orderFilterState.q = String(e.target.value || '').trim().toLowerCase();
      renderOrders(lastOrders);
    });
  }
  if (hideTestEl) {
    hideTestEl.addEventListener('change', e => {
      orderFilterState.hideTest = !!e.target.checked;
      renderOrders(lastOrders);
    });
  }
});

function matchOrderFilter(o, filterKey) {
  if (filterKey === 'waiting') {
    const ready = (o.payment_method === 'COD' && o.status === 'CONFIRMED') || (o.payment_method !== 'COD' && o.status === 'PAID');
    return ready || o.dropbuy_sync?.status === 'WAITING_STAFF' || o.dropbuy_sync?.status === 'FAILED';
  }
  if (filterKey === 'unpaid') return ['PENDING_PAYMENT', 'PAYMENT_REPORTED'].includes(o.status);
  if (filterKey === 'processing') return o.status === 'PROCESSING';
  if (filterKey === 'completed') return o.status === 'COMPLETED';
  if (filterKey === 'cancelled') return o.status === 'CANCELLED';
  return true;
}

function updateOrderFilterCounts(orders) {
  const base = orderFilterState.hideTest ? orders.filter(o => !o.is_test) : orders;
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
  setTxt('cntOrderAll', base.length);
  setTxt('cntOrderWaiting', base.filter(o => matchOrderFilter(o, 'waiting')).length);
  setTxt('cntOrderUnpaid', base.filter(o => matchOrderFilter(o, 'unpaid')).length);
  setTxt('cntOrderProcessing', base.filter(o => matchOrderFilter(o, 'processing')).length);
  setTxt('cntOrderCompleted', base.filter(o => matchOrderFilter(o, 'completed')).length);
  setTxt('cntOrderCancelled', base.filter(o => matchOrderFilter(o, 'cancelled')).length);
  setTxt('navBadgeOrders', orders.filter(o => !o.is_test).length);
}

function adminThumbUrl(u) {
  if (!u || typeof u !== 'string') return '';
  const m = u.match(/^https?:\/\/r6[is]\.pen\.dropbuy\.vn\/(md2?\/.*)$/i);
  if (m) return '/cdn/' + m[1];
  if (/^(https?:)?\/\/(?:[\w-]+\.)*dropbuy\.vn(\/|$)/i.test(u)) return '/logo.svg';
  return u;
}

function renderOrders(orders) {
  lastOrders = orders;
  updateOrderFilterCounts(orders);
  let filtered = orders.slice();
  if (orderFilterState.hideTest) filtered = filtered.filter(o => !o.is_test);
  if (orderFilterState.status && orderFilterState.status !== 'all') {
    filtered = filtered.filter(o => matchOrderFilter(o, orderFilterState.status));
  }
  if (orderFilterState.q) {
    const q = orderFilterState.q;
    filtered = filtered.filter(o => {
      const hay = [
        o.id,
        o.dropbuy_sync?.order_code,
        ...(o.dropbuy_sync?.orders || []).map(x => x.code),
        o.dropbuy_sync?.shipping_ref_code,
        o.customer?.name,
        o.customer?.phone,
        o.customer?.address,
        o.customer?.province,
        ...(o.items || []).map(i => i.name + ' ' + (i.sku || ''))
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  orders = filtered;
  if (orders.length === 0) {
    ordersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b; padding:32px;">Không có đơn hàng nào khớp bộ lọc</td></tr>';
    return;
  }

  ordersTableBody.innerHTML = orders.map(o => {
    const [cls, label] = STATUS_LABEL[o.status] || ['pending', o.status];
    const cost = (o.items || []).reduce((s, i) => s + (i.dropbuy_cost || 0) * i.quantity, 0);
    const canConfirm = o.payment_method !== 'COD' && ['PENDING_PAYMENT', 'PAYMENT_REPORTED'].includes(o.status);
    const ds = o.dropbuy_sync || {};
    const dbCode = (ds.orders || []).map(x => x.code).filter(Boolean).join(', ') || ds.order_code || '';
    const dbChip = dbCode
      ? `<div class="ord-db-chip ordered" title="Mã đơn kho DropBuy"><i class="fa-solid fa-box"></i> ${esc(dbCode)}</div>`
      : `<div class="ord-db-chip"><i class="fa-regular fa-clock"></i> Chưa đặt kho</div>`;

    const syncHint = ds.status === 'WAITING_STAFF' ? '<span style="font-size:11.5px; color:#b45309; font-weight:500;">⏳ Chờ đặt sang kho</span>'
      : ds.status === 'WAITING_DROPBUY_LOGIN' ? '<span style="font-size:11.5px; color:#dc2626;">⚠ Chưa đăng nhập kho</span>'
      : ds.status === 'FAILED' ? `<span style="font-size:11.5px; color:#dc2626;">⚠ ${esc(ds.error || 'Lỗi DropBuy')}</span>`
      : ds.status === 'SUBMIT_UNKNOWN' ? `<span style="font-size:11.5px; color:#dc2626;">⚠ ${esc(ds.error)}</span>`
      : ds.status === 'SUBMITTING' ? '<span style="font-size:11.5px; color:#b45309;">Đang gửi sang kho...</span>'
      : ds.status === 'IN_DROPBUY_CART' ? '<span style="font-size:11.5px; color:#059669;">✓ Đã thêm vào giỏ kho</span>' : '';

    const readyForKho = (o.payment_method === 'COD' && o.status === 'CONFIRMED') || (o.payment_method !== 'COD' && o.status === 'PAID');
    const digits = String(o.customer?.phone || '').replace(/\D/g, '').replace(/^84/, '0');
    const fullAddr = [o.customer?.address, o.customer?.ward_name, o.customer?.province_name || o.customer?.province].filter(Boolean).join(', ');
    const timeStr = new Date(o.created_at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });

    const itemsHtml = (o.items || []).map(i => {
      const thumb = i.image ? `<img class="ord-item-thumb" src="${esc(adminThumbUrl(i.image))}" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
      const title = i.dropbuy_url
        ? `<a class="ord-item-title" href="${esc(i.dropbuy_url)}" target="_blank" rel="noopener">${esc(i.name)}</a>`
        : `<div class="ord-item-title">${esc(i.name)}</div>`;
      return `<div class="ord-item-row">
        ${thumb}
        <div class="ord-item-body">
          ${title}
          <div class="ord-item-meta">
            <span class="ord-qty-pill">×${i.quantity}</span>
            ${i.variant_name ? `<span>[${esc(i.variant_name)}]</span>` : ''}
            ${i.sku ? `<span>${esc(i.sku)}</span>` : ''}
            ${i.dropbuy_cost ? `<span title="Giá vốn DropBuy">Vốn: ${formatPrice(i.dropbuy_cost)}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    let actions;
    if (canConfirm) {
      actions = `<div class="ord-action-group">
        <button class="btn-check-paid btn-sm" onclick="confirmOrder('${esc(o.id)}')"><i class="fa-solid fa-check"></i> Đã nhận tiền</button>
        <button class="btn-ghost btn-sm" onclick="setOrderStatus('${esc(o.id)}', 'CANCELLED')">Huỷ</button>
      </div>`;
    } else if (readyForKho) {
      const locked = ['SUBMITTING', 'SUBMIT_UNKNOWN'].includes(ds.status);
      actions = `<div class="ord-action-group">
          <button class="btn-check-paid btn-sm" onclick="copyReceiver('${esc(o.id)}')"><i class="fa-regular fa-copy"></i> Sao chép ĐC</button>
          <button class="btn-ghost btn-sm" onclick="attachDropbuyCode('${esc(o.id)}')"><i class="fa-solid fa-hashtag"></i> Nhập mã kho</button>
        </div>
        <details style="font-size:11.5px; width:100%;">
          <summary style="cursor:pointer; color:#ea580c; font-weight:500; user-select:none;">Đặt tự động / chi tiết COD</summary>
          <div style="margin-top:6px; display:flex; flex-direction:column; gap:6px;">
            ${staffBox(o)}
            <div class="ord-action-group">
              <button class="btn-ghost btn-sm" onclick="pushToDropbuyCart('${esc(o.id)}')"><i class="fa-solid fa-cart-arrow-down"></i> Vào giỏ kho</button>
              ${locked ? '' : `<button class="btn-primary btn-sm" onclick="placeOnDropbuy('${esc(o.id)}')"><i class="fa-solid fa-bolt"></i> Đặt hộ ngay</button>`}
              ${o.payment_method === 'COD' ? `<button class="btn-ghost btn-sm" onclick="setOrderStatus('${esc(o.id)}', 'CANCELLED')">Huỷ đơn</button>` : ''}
            </div>
          </div>
        </details>`;
    } else if (o.status === 'PROCESSING') {
      actions = `${o.dropbuy_sync?.problem ? `<div style="font-size:11.5px; color:#dc2626;">⚠ ${esc(o.dropbuy_sync.problem)}</div>` : ''}
        <div class="ord-action-group">
          <button class="btn-check-paid btn-sm" onclick="setOrderStatus('${esc(o.id)}', 'COMPLETED')"><i class="fa-solid fa-check"></i> Đã giao xong</button>
          ${(ds.orders || []).length || ds.order_id ? `<button class="btn-ghost btn-sm" onclick="cancelOnDropbuy('${esc(o.id)}')">Huỷ trên kho</button>` : ''}
        </div>`;
    } else if (o.status === 'CANCELLED') {
      actions = '<span style="color:#64748b; font-size:12px;"><i class="fa-solid fa-ban"></i> Đã đóng đơn</span>';
    } else {
      actions = `<span style="color:#059669; font-size:12px; font-weight:600;"><i class="fa-solid fa-circle-check"></i> ${label}</span>`;
    }

    const grossProfit = (o.subtotal ?? o.total_amount) - cost;

    return `
    <tr>
      <td data-label="Đơn hàng">
        <div class="ord-id-code">#${esc(o.id)}</div>
        <div class="ord-time">${timeStr}</div>
        ${dbChip}
        ${ds.current_label ? `<div style="font-size:11px; color:#059669; margin-top:4px; font-weight:500;">${esc(ds.current_label)}</div>` : ''}
        ${ds.shipping_ref_code ? `<div style="font-size:11px; color:#64748b; margin-top:2px;">VĐ: <code>${esc(ds.shipping_ref_code)}</code></div>` : ''}
      </td>
      <td data-label="Khách hàng">
        <div class="ord-cust-name">${esc(o.customer?.name || '—')}</div>
        <div class="ord-cust-phone">
          <span>${esc(o.customer?.phone || '')}</span>
          ${/^0\d{9}$/.test(digits) ? `<a class="ord-zalo-btn" href="https://zalo.me/${digits}" target="_blank" rel="noopener" title="Nhắn Zalo cho khách">Zalo</a>` : ''}
        </div>
        <div class="ord-cust-addr">${esc(fullAddr)}</div>
        ${o.customer?.note ? `<div class="ord-cust-note"><i class="fa-regular fa-note-sticky"></i> ${esc(o.customer.note)}</div>` : ''}
      </td>
      <td data-label="Sản phẩm">
        <div class="ord-item-list">${itemsHtml}</div>
        <div class="ord-summary-foot">
          ${o.shipping_fee != null ? `<span>Ship: <strong>${o.shipping_fee ? formatPrice(o.shipping_fee) : 'Miễn phí'}</strong></span>` : ''}
          ${cost ? `<span class="ord-profit-tag">${grossProfit >= 0 ? 'Lãi gộp: +' : 'Lỗ gộp: '}${formatPrice(grossProfit)}</span>` : ''}
        </div>
      </td>
      <td data-label="Thanh toán" style="white-space:nowrap;">
        <div class="ord-total-val">${formatPrice(o.total_amount)}</div>
        <span class="ord-pay-badge ${o.payment_method === 'COD' ? 'cod' : 'bank'}">${o.payment_method === 'COD' ? 'COD · Thu hộ' : 'Chuyển khoản'}</span>
        ${ds.spend ? `<div style="font-size:11.5px; color:#64748b; margin-top:4px;" class="num">Quỹ kho: -${formatPrice(ds.spend)}</div><div style="font-size:11.5px; color:#059669; font-weight:600;" class="num">Lãi ròng: ${formatPrice(o.total_amount - ds.spend)}</div>` : ''}
        ${o.payment_via ? `<div style="font-size:11px; color:#059669; margin-top:3px;">✓ ${o.payment_via === 'admin' ? 'Xác nhận tay' : `Tự động (${esc(o.payment_via)})`}</div>` : ''}
        ${o.late_payment ? `<div style="font-size:11px; color:#dc2626; margin-top:3px;">⚠ Tiền về sau huỷ: ${formatPrice(o.late_payment.amount)}</div>` : ''}
      </td>
      <td data-label="Trạng thái">
        <div style="display:flex; flex-direction:column; align-items:flex-start; gap:5px;">
          ${o.is_test ? '<span class="status-pill cancelled">Đơn thử</span>' : ''}
          <span class="status-pill ${cls}">${label}</span>
          ${syncHint}
          ${o.needs_attention && o.status === 'PAYMENT_REPORTED' ? '<span style="font-size:11.5px; color:#dc2626; font-weight:500;">⚠ Báo CK lâu – cần đối soát</span>' : ''}
          ${o.cancel_reason ? `<span style="font-size:11.5px; color:#64748b; max-width:165px;">${esc(o.cancel_reason)}</span>` : ''}
        </div>
      </td>
      <td data-label="Thao tác">
        <div class="ord-actions-col">
          ${actions}
          <div class="ord-sub-links">
            ${o.status !== 'PENDING_PAYMENT' && !o.is_test ? `<button type="button" class="link-btn" onclick="customerMessageFor('${esc(o.id)}')"><i class="fa-regular fa-comment-dots"></i> Tin nhắn khách</button><span>·</span>` : ''}
            <a href="#" onclick="toggleTestOrder('${esc(o.id)}', ${!o.is_test}); return false;">${o.is_test ? 'Bỏ đơn thử' : 'Đơn thử'}</a>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

let lastOrders = [];
async function pushToDropbuyCart(orderId) {
  if (!await uiConfirm(`Đưa các sản phẩm của đơn #${orderId} vào giỏ hàng DropBuy của bạn?`)) return;
  try {
    const json = await (await adminFetch(`/api/admin/orders/${orderId}/push-dropbuy-cart`, { method: 'POST', body: '{}' })).json();
    if (!json.success) throw new Error(json.error);
    const lines = json.data.pushed.map(p => `• ${p.name}${p.variant_name ? ` [${p.variant_name}]` : ''} × ${p.quantity}${p.in_cart ? '' : ' (KHÔNG thấy trong giỏ!)'}`).join('\n');
    copyReceiver(orderId, true);
    if (await uiConfirm(`${json.message}\n\n${lines}\n\nThông tin người nhận đã được sao chép. Mở giỏ DropBuy ngay?`)) window.open(json.data.cart_url, '_blank', 'noopener');
    loadData();
  } catch (e) {
    uiAlert('Lỗi: ' + e.message);
  }
}

async function customerMessageFor(orderId) {
  try {
    const json = await (await adminFetch(`/api/admin/orders/${orderId}/customer-message`)).json();
    if (!json.success) throw new Error(json.error);
    const d = json.data;
    let copied = false;
    try { await navigator.clipboard.writeText(d.text); copied = true; } catch (e) {}
    const warn = d.local_link ? '\n\n⚠ Link tra cứu đang là địa chỉ máy nội bộ – khách bên ngoài chưa mở được cho tới khi cửa hàng có tên miền (đặt PUBLIC_BASE_URL).' : '';
    if (!copied) await uiPrompt('Sao chép tin nhắn gửi khách:', { value: d.text, readOnly: true });
    if (d.zalo) {
      if (await uiConfirm(`${copied ? 'Đã sao chép tin nhắn:' : 'Tin nhắn:'}\n\n${d.text}${warn}\n\nMở Zalo tới ${d.phone} để dán gửi?`, { ok: 'Mở Zalo', cancel: 'Đóng' })) window.open(d.zalo, '_blank', 'noopener');
    } else if (copied) {
      uiAlert(`Đã sao chép tin nhắn:\n\n${d.text}${warn}`);
    }
  } catch (e) {
    uiAlert('Lỗi: ' + e.message);
  }
}

async function toggleTestOrder(orderId, isTest) {
  if (isTest && !(await uiConfirm(`Đánh dấu #${orderId} là đơn thử? Đơn sẽ bị loại khỏi báo cáo doanh thu và không tự đặt sang DropBuy.`))) return;
  const json = await (await adminFetch(`/api/admin/orders/${orderId}/test-flag`, { method: 'POST', body: JSON.stringify({ is_test: isTest }) })).json();
  if (!json.success) uiAlert('Lỗi: ' + json.error);
  loadData();
  loadReport();
}

async function placeOnDropbuy(orderId) {
  if (!await uiConfirm(`Đặt đơn #${orderId} trên DropBuy ngay? Tiền vốn + ship sẽ bị trừ vào quỹ DropBuy của bạn.`)) return;
  try {
    const json = await (await adminFetch(`/api/admin/orders/${orderId}/place-dropbuy`, { method: 'POST', body: '{}' })).json();
    uiAlert(json.success ? json.message : 'Chưa đặt được: ' + json.error);
  } catch (e) {
    uiAlert('Lỗi: ' + e.message);
  }
  loadData();
  loadAutoOrder();
}

async function cancelOnDropbuy(orderId) {
  if (!await uiConfirm(`Huỷ đơn #${orderId} trên DropBuy? (Chỉ huỷ được khi kho chưa đóng gói)`)) return;
  try {
    const json = await (await adminFetch(`/api/admin/orders/${orderId}/cancel-dropbuy`, { method: 'POST', body: '{}' })).json();
    uiAlert(json.success ? json.message : 'Không huỷ được: ' + json.error);
  } catch (e) {
    uiAlert('Lỗi: ' + e.message);
  }
  loadData();
}

async function attachDropbuyCode(orderId) {
  const code = await uiPrompt(`Mã đơn trên DropBuy của đơn #${orderId} (xem ở dropbuy.vn → Đơn mua):`, { placeholder: 'Ví dụ: D-261020-1657154' });
  if (!code) return;
  try {
    const json = await (await adminFetch(`/api/admin/orders/${orderId}/dropbuy-code`, { method: 'POST', body: JSON.stringify({ code }) })).json();
    if (!json.success) throw new Error(json.error);
    loadData();
  } catch (e) {
    uiAlert('Lỗi: ' + e.message);
  }
}

// Số tiền nhân viên nhập ô "Thu hộ (COD)" trên DropBuy: đơn COD = tổng khách trả; đơn đã chuyển khoản = 0
function codToCollect(o) {
  return o.payment_method === 'COD' ? (o.total_amount || 0) : 0;
}

/** Khung tóm tắt để nhân viên đặt đơn dropship trên DropBuy */
function staffBox(o) {
  const live = o.shipping_live;
  const carriers = { V: 'Viettel Post', S: 'SPX' };
  const shipDb = live?.fee != null ? `${formatPrice(live.fee)}${live.depots?.length ? ` (${[...new Set(live.depots.map(d => carriers[d.method] || d.method))].join(' + ')}${live.depots.length > 1 ? `, ${live.depots.length} kho` : ''})` : ''}` : 'chưa có';
  const cost = (o.items || []).reduce((s, i) => s + (i.dropbuy_cost || 0) * i.quantity, 0);
  const profit = cost && live?.fee != null ? (o.total_amount || 0) - cost - live.fee : null;
  return `<div class="staff-box">
    <div><span>Thu hộ (COD) nhập trên DropBuy:</span> <strong>${formatPrice(codToCollect(o))}</strong></div>
    <div><span>Phí ship DropBuy dự kiến:</span> ${shipDb}</div>
    <div><span>Giao tới:</span> ${esc(o.customer?.ward_name || '')}${o.customer?.ward_name ? ', ' : ''}${esc(o.customer?.province_name || o.customer?.province || '')}</div>
    ${profit != null ? `<div><span>Lãi dự kiến:</span> <strong style="color:${profit >= 0 ? '#067647' : '#d92d20'};">${formatPrice(profit)}</strong></div>` : ''}
  </div>`;
}

function copyReceiver(orderId, silent = false) {
  const o = lastOrders.find(x => x.id === orderId);
  if (!o) return;
  const c = o.customer || {};
  const items = (o.items || []).map(i => `- ${i.name}${i.variant_name ? ` [${i.variant_name}]` : ''} x${i.quantity}${i.sku ? ` (SKU ${i.sku})` : ''}`).join('\n');
  const text = `Người nhận: ${c.name}\nSĐT: ${c.phone}\nĐịa chỉ: ${c.address}${c.ward_name ? `, ${c.ward_name}` : ''}${c.province_name || c.province ? `, ${c.province_name || c.province}` : ''}\nThu hộ (COD): ${codToCollect(o).toLocaleString('vi-VN')}\nĐơn shop: ${o.id}${c.note ? `\nGhi chú: ${c.note}` : ''}\nSản phẩm:\n${items}`;
  navigator.clipboard.writeText(text).then(() => { if (!silent) uiAlert('Đã sao chép:\n\n' + text); }).catch(() => uiPrompt('Sao chép thông tin người nhận:', { value: text, readOnly: true }));
}

async function setOrderStatus(orderId, status) {
  if (status === 'CANCELLED' && !await uiConfirm(`Huỷ đơn #${orderId}?`)) return;
  try {
    const json = await (await adminFetch(`/api/admin/orders/${orderId}/status`, { method: 'POST', body: JSON.stringify({ status }) })).json();
    if (!json.success) throw new Error(json.error);
    loadData();
  } catch (e) {
    uiAlert('Lỗi: ' + e.message);
  }
}

async function confirmOrder(orderId) {
  try {
    if (!await uiConfirm(`Xác nhận đã nhận đủ tiền cho đơn #${orderId}? (kiểm tra sao kê ngân hàng trước)`)) return;
    const res = await adminFetch(`/api/orders/${orderId}/confirm-payment`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      uiAlert(`Đã xác nhận thanh toán đơn #${orderId}! Sự kiện realtime đã được bắn tới khách hàng.`);
      loadData();
    } else {
      uiAlert('Lỗi: ' + json.error);
    }
  } catch (e) {
    uiAlert('Lỗi: ' + e.message);
  }
}

// Save config
configForm.addEventListener('submit', async e => {
  e.preventDefault();

  const userEl = document.getElementById('dropbuyLoginUser');
  const passEl = document.getElementById('dropbuyLoginPass');

  const newConfig = {
    dropbuy: {
      username: userEl ? userEl.value.trim() : '',
      simulationMode: cfgSimulationMode.checked
    },
    bank: {
      bankId: cfgBankId.value,
      bankName: cfgBankId.options[cfgBankId.selectedIndex].text.split('(')[0].trim(),
      accountNo: cfgAccountNo.value.trim(),
      accountName: cfgAccountName.value.trim()
    }
  };

  try {
    const res = await adminFetch('/api/admin/config', {
      method: 'POST',
      body: JSON.stringify(newConfig)
    });
    const json = await res.json();
    uiAlert(json.success ? json.message : 'Lỗi: ' + json.error);
  } catch (err) {
    uiAlert('Lỗi lưu cấu hình: ' + err.message);
  }
});

// Trigger full sync
syncNowBtn.addEventListener('click', async () => {
  if (!await uiConfirm('Bạn có muốn đồng bộ lại 100% toàn bộ kho hàng từ DropBuy.vn ngay bây giờ?')) return;

  syncNowBtn.disabled = true;
  syncNowBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đồng bộ từ DropBuy...';

  try {
    const res = await adminFetch('/api/admin/sync', { method: 'POST', body: JSON.stringify({ maxPages: 20 }) });
    const json = await res.json();
    uiAlert(json.message);
  } catch (err) {
    uiAlert('Lỗi khởi động đồng bộ: ' + err.message);
    syncNowBtn.disabled = false;
    syncNowBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Đồng Bộ Lại Toàn Bộ Kho DropBuy';
  }
});

// Trigger full image & details download
const downloadAllImagesBtn = document.getElementById('downloadAllImagesBtn');
if (downloadAllImagesBtn) {
  downloadAllImagesBtn.addEventListener('click', async () => {
    if (!await uiConfirm('Tải chi tiết & toàn bộ album ảnh của tất cả sản phẩm về ổ đĩa server? (chạy nền, mất nhiều thời gian)')) return;

    downloadAllImagesBtn.disabled = true;
    downloadAllImagesBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải album ảnh ngầm...';

    try {
      const res = await adminFetch('/api/admin/download-all-images', { method: 'POST' });
      const json = await res.json();
      uiAlert(json.message);
    } catch (err) {
      uiAlert('Lỗi: ' + err.message);
      downloadAllImagesBtn.disabled = false;
      downloadAllImagesBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Tải Full Album Ảnh Về Ổ Đĩa Server';
    }
  });
}

socket.on('DOWNLOAD_PROGRESS', data => {
  if (downloadAllImagesBtn) {
    downloadAllImagesBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đã tải ${data.current}/${data.total} SP...`;
  }
});

socket.on('DOWNLOAD_COMPLETED', data => {
  uiAlert(`Đã hoàn tất tải 100% album ảnh của toàn bộ ${data.total} sản phẩm về lưu trữ trên máy chủ!`);
  if (downloadAllImagesBtn) {
    downloadAllImagesBtn.disabled = false;
    downloadAllImagesBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Tải Full Album Ảnh Về Ổ Đĩa Server';
  }
});

// Realtime listeners
socket.on('CATALOG_SYNC_COMPLETED', data => {
  const msg = data.wholesale ? `Đã đồng bộ xong ${data.total} sản phẩm kèm GIÁ SỈ ĐẠI LÝ F1!` : `Đã đồng bộ xong toàn bộ ${data.total} sản phẩm từ kho DropBuy!`;
  uiAlert(msg);
  syncNowBtn.disabled = false;
  syncNowBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Đồng Bộ Lại Toàn Bộ Kho DropBuy';
  loadData();
});

socket.on('DROPBUY_AUTH_CHANGED', () => {
  updateAuthStatusUI();
  loadData();
});

socket.on('PAYMENT_CONFIRMED', () => {
  loadData();
});

socket.on('ADMIN_PAYMENT_REPORTED', () => {
  loadData();
});

socket.on('ADMIN_ORDER_CHANGED', () => {
  loadData();
});

// DropBuy Wholesale Auth UI
const dropbuyAuthBadge = document.getElementById('dropbuyAuthBadge');
const dropbuyLoginUser = document.getElementById('dropbuyLoginUser');
const dropbuyLoginPass = document.getElementById('dropbuyLoginPass');
const btnDropbuyLogin = document.getElementById('btnDropbuyLogin');
const btnDropbuyLogout = document.getElementById('btnDropbuyLogout');
const dropbuyAuthMsg = document.getElementById('dropbuyAuthMsg');
const dropbuyManualCookie = document.getElementById('dropbuyManualCookie');
const btnSaveCookie = document.getElementById('btnSaveCookie');
const daemonStatusText = document.getElementById('daemonStatusText');

async function updateDaemonStatusUI() {
  try {
    const res = await adminFetch('/api/admin/realtime-status').then(r => r.json());
    if (res.success && res.data) {
      const d = res.data;
      const lastStr = d.lastSyncTime ? new Date(d.lastSyncTime).toLocaleTimeString('vi-VN') : 'chưa có';
      const nextStr = d.nextSyncTime ? new Date(d.nextSyncTime).toLocaleTimeString('vi-VN') : '5 phút nữa';
      const badge = document.getElementById('daemonBadgeText');
      if (badge && d.stock && d.price) badge.innerText = `Realtime: tồn kho ${d.stock.intervalSeconds}s · giá ${Math.round(d.price.intervalSeconds / 60)} phút`;
      if (daemonStatusText && d.stock && d.price) {
        const t = x => (x ? new Date(x).toLocaleTimeString('vi-VN') : 'chưa có');
        const err = [d.stock.lastError && `tồn kho: ${esc(d.stock.lastError)}`, d.price.lastError && `giá: ${esc(d.price.lastError)}`].filter(Boolean).join(' · ');
        daemonStatusText.innerHTML = `<strong>${(d.totalProducts || 0).toLocaleString('vi-VN')} SP</strong> · Tồn kho cập nhật lúc <strong>${t(d.stock.lastOk)}</strong> (${d.stock.lastDurationMs ?? '-'}ms) · Giá cập nhật lúc <strong>${t(d.price.lastOk)}</strong> · Lần quét giá kế tiếp: <strong>${t(d.price.nextRun)}</strong>${err ? ` · <span style="color:#ef4444;">Lỗi: ${err}</span>` : ''}`;
      } else if (daemonStatusText) {
        daemonStatusText.innerHTML = `Đang đồng bộ <strong>${(d.totalProducts || 0).toLocaleString('vi-VN')} SP</strong> (giá & tồn kho) mỗi <strong>${d.intervalMinutes} phút</strong>. Quét gần nhất: <strong>${lastStr}</strong> ➔ Lần kế tiếp: <strong>${nextStr}</strong>${d.lastError ? ` · <span style="color:#ef4444;">Lỗi lần trước: ${esc(d.lastError)}</span>` : ''}`;
      }
    }
  } catch (e) {}
}
setInterval(updateDaemonStatusUI, 10000);

socket.on('ADMIN_REALTIME_HEARTBEAT', () => {
  updateDaemonStatusUI();
});
socket.on('REALTIME_HEARTBEAT', data => {
  updateDaemonStatusUI();
});

async function forgetDropbuyCredentials() {
  if (!(await uiConfirm('Xoá tài khoản DropBuy đã lưu? Khi phiên hết hạn bạn sẽ phải đăng nhập tay.'))) return;
  const json = await (await adminFetch('/api/dropbuy/forget-credentials', { method: 'POST', body: '{}' })).json();
  uiAlert(json.message || json.error);
  updateAuthStatusUI();
}

async function updateAuthStatusUI() {
  updateDaemonStatusUI();
  try {
    const res = await adminFetch('/api/dropbuy/auth-status').then(r => r.json());
    if (res.success && res.data) {
      const d = res.data;
      const rem = document.getElementById('dropbuyRememberInfo');
      if (rem) {
        rem.style.display = d.remember?.saved ? 'block' : 'none';
        rem.innerHTML = d.remember?.saved
          ? `<i class="fa-solid fa-shield-halved"></i> Đã lưu tài khoản <strong>${esc(d.remember.username)}</strong> (mã hoá) để tự đăng nhập lại. <a href="#" onclick="forgetDropbuyCredentials(); return false;">Xoá</a>`
          : '';
      }
      if (d.authenticated) {
        dropbuyAuthBadge.className = 'auth-badge badge-connected';
        dropbuyAuthBadge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Đã kết nối: ${esc(d.username || 'Đại lý')}`;
        // Vẫn cho đăng nhập lại khi đang kết nối: gia hạn phiên / bật "Ghi nhớ" để tự đăng nhập lại
        btnDropbuyLogin.style.display = 'inline-flex';
        btnDropbuyLogin.innerHTML = `<i class="fa-solid fa-rotate"></i> ${d.remember?.saved ? 'Đăng nhập lại & gia hạn phiên' : 'Đăng nhập lại & ghi nhớ (tự gia hạn)'}`;
        btnDropbuyLogout.style.display = 'inline-flex';
        dropbuyLoginPass.value = '';
        dropbuyAuthMsg.style.display = 'block';
        dropbuyAuthMsg.style.background = '#ecfdf5';
        dropbuyAuthMsg.style.color = '#10b981';
        dropbuyAuthMsg.style.border = '1px solid #a7f3d0';
        dropbuyAuthMsg.innerHTML = `<i class="fa-solid fa-bolt"></i> <strong>${esc(d.message)}</strong>`;
      } else {
        dropbuyAuthBadge.className = 'auth-badge badge-disconnected';
        dropbuyAuthBadge.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Chưa kết nối`;
        btnDropbuyLogin.style.display = 'inline-flex';
        btnDropbuyLogin.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Đăng Nhập & Kích Hoạt Giá Sỉ';
        btnDropbuyLogout.style.display = 'none';
        if (d.expired) {
          dropbuyAuthMsg.style.display = 'block';
          dropbuyAuthMsg.style.background = '#fef2f2';
          dropbuyAuthMsg.style.color = '#ef4444';
          dropbuyAuthMsg.style.border = '1px solid #fecaca';
          dropbuyAuthMsg.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(d.message)}`;
        } else {
          dropbuyAuthMsg.style.display = 'none';
        }
      }
    }
  } catch (err) {
    console.error('Lỗi kiểm tra auth DropBuy:', err);
  }
}

if (btnDropbuyLogin) {
  btnDropbuyLogin.addEventListener('click', async () => {
    const username = dropbuyLoginUser.value.trim();
    const password = dropbuyLoginPass.value;
    if (!username || !password) {
      uiAlert('Vui lòng nhập đầy đủ tài khoản và mật khẩu DropBuy!');
      return;
    }

    btnDropbuyLogin.disabled = true;
    btnDropbuyLogin.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đăng nhập DropBuy...';
    dropbuyAuthMsg.style.display = 'block';
    dropbuyAuthMsg.style.background = '#fffbeb';
    dropbuyAuthMsg.style.color = '#f59e0b';
    dropbuyAuthMsg.style.border = '1px solid #fde68a';
    dropbuyAuthMsg.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xác thực tài khoản với DropBuy và kích hoạt giá sỉ...';

    try {
      const res = await adminFetch('/api/dropbuy/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, totp_code: (document.getElementById('dropbuyLoginTotp')?.value || '').trim() || undefined, remember: !!document.getElementById('dropbuyRemember')?.checked })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Đăng nhập DropBuy thất bại');
      }

      uiAlert('Đăng nhập DropBuy thành công! Hệ thống đang tự động đồng bộ lại 100% kho hàng theo GIÁ SỈ ĐẠI LÝ F1.');
      updateAuthStatusUI();
      loadData();
    } catch (err) {
      uiAlert('Lỗi: ' + err.message);
      dropbuyAuthMsg.style.background = '#fef2f2';
      dropbuyAuthMsg.style.color = '#ef4444';
      dropbuyAuthMsg.style.border = '1px solid #fecaca';
      dropbuyAuthMsg.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Lỗi: ${esc(err.message)}`;
    } finally {
      btnDropbuyLogin.disabled = false;
      btnDropbuyLogin.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Đăng Nhập & Kích Hoạt Giá Sỉ';
    }
  });
}

if (btnDropbuyLogout) {
  btnDropbuyLogout.addEventListener('click', async () => {
    if (!await uiConfirm('Bạn có chắc muốn đăng xuất DropBuy? Hệ thống sẽ quay về giá bán lẻ công khai.')) return;
    try {
      await adminFetch('/api/dropbuy/logout', { method: 'POST' });
      uiAlert('Đã đăng xuất tài khoản DropBuy.');
      updateAuthStatusUI();
    } catch (e) {
      uiAlert('Lỗi: ' + e.message);
    }
  });
}

if (btnSaveCookie) {
  btnSaveCookie.addEventListener('click', async () => {
    const cookie = dropbuyManualCookie.value.trim();
    if (!cookie) {
      uiAlert('Vui lòng dán chuỗi cookie!');
      return;
    }
    btnSaveCookie.disabled = true;
    btnSaveCookie.innerText = 'Đang kiểm tra...';
    try {
      const res = await adminFetch('/api/dropbuy/set-cookie', {
        method: 'POST',
        body: JSON.stringify({ cookie })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Cookie không hợp lệ');
      uiAlert('Lưu cookie thành công! Đã kích hoạt giá sỉ đại lý.');
      dropbuyManualCookie.value = '';
      updateAuthStatusUI();
      loadData();
    } catch (err) {
      uiAlert('Lỗi: ' + err.message);
    } finally {
      btnSaveCookie.disabled = false;
      btnSaveCookie.innerText = 'Lưu Cookie';
    }
  });
}

loadData();
updateAuthStatusUI();


// ============================ THIẾT LẬP GIÁ BÁN ============================
const pricingState = { page: 1, search: '', filter: '', categories: [] };

function fmtPct(v) {
  return v == null || v === '' ? '' : String(v);
}

async function loadPricing() {
  try {
    const json = await (await adminFetch('/api/admin/pricing')).json();
    if (!json.success) throw new Error(json.error);
    const { rules, categories, stats, dropbuy } = json.data;
    pricingState.categories = categories;

    document.getElementById('prBase').value = rules.base;
    document.getElementById('prMarkup').value = rules.markupPercent;
    document.getElementById('prMinProfit').value = rules.minProfit;
    document.getElementById('prRoundTo').value = String(rules.roundTo);
    document.getElementById('prCapAtPublic').checked = !!rules.capAtPublic;

    const badge = document.getElementById('pricingAuthBadge');
    const note = document.getElementById('pricingAuthNote');
    if (dropbuy.authenticated) {
      badge.className = 'auth-badge badge-connected';
      badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Đang lấy giá CTV của ${esc(dropbuy.username || 'tài khoản DropBuy')}`;
      note.innerHTML = `Đã có giá CTV cho <strong>${stats.wholesaleCount.toLocaleString('vi-VN')}/${stats.total.toLocaleString('vi-VN')}</strong> sản phẩm. Giá CTV được cập nhật lại mỗi lần quét giá.`;
    } else {
      badge.className = 'auth-badge badge-disconnected';
      badge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Chưa đăng nhập DropBuy';
      note.innerHTML = `<span style="color:#f59e0b;">Chưa đăng nhập DropBuy nên chưa có giá CTV – giá gốc đang là <strong>giá niêm yết công khai</strong>. Đăng nhập ở thẻ <strong>Đăng Nhập DropBuy</strong> phía trên để lấy giá CTV chính xác.</span>`;
    }

    document.getElementById('pricingStats').innerHTML = [
      ['Sản phẩm', stats.total.toLocaleString('vi-VN')],
      ['Có giá CTV', stats.wholesaleCount.toLocaleString('vi-VN')],
      ['Lãi TB / SP còn hàng', formatPrice(stats.avgProfit)],
      ['SP bị lỗ', stats.negativeProfit],
      ['Giá bán > niêm yết DropBuy', stats.abovePublic.toLocaleString('vi-VN')]
    ].map(([k, v]) => `<div class="pricing-stat"><span>${k}</span><strong>${v}</strong></div>`).join('');

    document.getElementById('prCategoryList').innerHTML = categories.map(c => `
      <label class="pricing-cat">
        <span>${esc(c.name)} <small>(${c.product_count})</small></span>
        <input type="number" min="0" max="300" step="0.5" data-cat="${c.id}" value="${fmtPct(c.markupPercent)}" placeholder="${rules.markupPercent}">
        <span>%</span>
      </label>`).join('');
  } catch (e) {
    document.getElementById('pricingAuthNote').innerText = 'Lỗi tải thiết lập giá: ' + e.message;
  }
}

document.getElementById('pricingForm').addEventListener('submit', async e => {
  e.preventDefault();
  const categoryMarkups = {};
  document.querySelectorAll('#prCategoryList input[data-cat]').forEach(inp => {
    if (inp.value !== '') categoryMarkups[inp.dataset.cat] = parseFloat(inp.value);
  });
  const body = {
    base: document.getElementById('prBase').value,
    markupPercent: parseFloat(document.getElementById('prMarkup').value),
    minProfit: parseFloat(document.getElementById('prMinProfit').value) || 0,
    roundTo: parseInt(document.getElementById('prRoundTo').value, 10),
    capAtPublic: document.getElementById('prCapAtPublic').checked,
    categoryMarkups
  };
  const msg = document.getElementById('pricingSaveMsg');
  msg.innerText = 'Đang áp dụng...';
  try {
    const json = await (await adminFetch('/api/admin/pricing', { method: 'POST', body: JSON.stringify(body) })).json();
    if (!json.success) throw new Error(json.error);
    msg.innerText = json.message;
    loadPricing();
    loadPricingTable();
  } catch (err) {
    msg.innerText = 'Lỗi: ' + err.message;
  }
});

async function loadPricingTable() {
  const params = new URLSearchParams({ page: pricingState.page, limit: 20, search: pricingState.search, filter: pricingState.filter });
  const tbody = document.getElementById('pricingTableBody');
  try {
    const json = await (await adminFetch(`/api/admin/pricing/products?${params}`)).json();
    if (!json.success) throw new Error(json.error);
    if (json.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b; padding:28px;">Không tìm thấy sản phẩm nào khớp điều kiện</td></tr>';
    } else {
      tbody.innerHTML = json.data.map(r => {
        const thumb = r.image ? `<img class="ord-item-thumb" src="${esc(adminThumbUrl(r.image))}" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
        return `
        <tr data-id="${r.id}">
          <td style="min-width:225px; max-width:340px;">
            <div class="ord-item-row">
              ${thumb}
              <div class="ord-item-body">
                <a class="ord-item-title" href="${esc(r.dropbuy_url)}" target="_blank" rel="noopener">${esc(r.name)}</a>
                <div class="ord-item-meta">
                  <span>${esc(r.sku)}</span>
                  ${r.category_name ? `<span>· ${esc(r.category_name)}</span>` : ''}
                  ${r.is_flash_sale ? '<span style="padding:0 6px; border-radius:4px; background:#fff7ed; border:1px solid #fed7aa; color:#ea580c; font-weight:600;">⚡ Flash Sale</span>' : ''}
                  ${r.in_stock ? '' : '<span style="color:#dc2626; font-weight:600;">· Hết hàng</span>'}
                </div>
              </div>
            </div>
          </td>
          <td class="num" style="white-space:nowrap; color:#475569;">${formatPrice(r.public_price)}</td>
          <td class="num" style="white-space:nowrap;">${r.wholesale_price ? `<strong style="color:#0f172a;">${formatPrice(r.wholesale_price)}</strong>` : '<span style="color:#94a3b8; font-size:12px;">Chưa có</span>'}</td>
          <td class="num" style="white-space:nowrap;"><strong style="color:#ea580c; font-size:13.5px;">${formatPrice(r.price)}</strong><div style="font-size:11px; color:#64748b; margin-top:2px;">${esc(r.rule || '')}</div></td>
          <td class="num" style="white-space:nowrap; color:${r.profit < 0 ? '#dc2626' : '#059669'}; font-weight:600;">${r.profit > 0 ? '+' : ''}${formatPrice(r.profit)}</td>
          <td style="white-space:nowrap;">
            <div class="pr-override-bar">
              <select class="pr-ov-type">
                <option value="percent" ${r.override?.type === 'percent' ? 'selected' : ''}>% lãi</option>
                <option value="fixed" ${r.override?.type === 'fixed' ? 'selected' : ''}>Giá cố định</option>
              </select>
              <input class="pr-ov-value" type="number" min="0" value="${r.override ? r.override.value : ''}" placeholder="Mặc định">
              <button type="button" class="btn-check-paid pr-ov-save">Lưu</button>
              ${r.override ? '<button type="button" class="btn-ghost pr-ov-clear">Bỏ</button>' : ''}
            </div>
          </td>
        </tr>`;
      }).join('');
    }
    const pag = document.getElementById('pricingPagination');
    pag.innerHTML = json.totalPages > 1 ? `
      <button type="button" class="pag-btn" ${json.page <= 1 ? 'disabled' : ''} data-page="${json.page - 1}">‹ Trước</button>
      <span>Trang ${json.page}/${json.totalPages} · ${json.total.toLocaleString('vi-VN')} SP</span>
      <button type="button" class="pag-btn" ${json.page >= json.totalPages ? 'disabled' : ''} data-page="${json.page + 1}">Sau ›</button>` : `<span>${json.total.toLocaleString('vi-VN')} SP</span>`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#dc2626;">Lỗi: ${esc(e.message)}</td></tr>`;
  }
}

document.getElementById('pricingPagination').addEventListener('click', e => {
  const b = e.target.closest('[data-page]');
  if (!b || b.disabled) return;
  pricingState.page = Number(b.dataset.page);
  loadPricingTable();
});

let prSearchTimer = null;
document.getElementById('prSearch').addEventListener('input', e => {
  clearTimeout(prSearchTimer);
  prSearchTimer = setTimeout(() => {
    pricingState.search = e.target.value.trim();
    pricingState.page = 1;
    loadPricingTable();
  }, 300);
});
document.getElementById('prFilter').addEventListener('change', e => {
  pricingState.filter = e.target.value;
  pricingState.page = 1;
  loadPricingTable();
});

document.getElementById('pricingTableBody').addEventListener('click', async e => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const clear = e.target.closest('.pr-ov-clear');
  if (!clear && !e.target.closest('.pr-ov-save')) return;
  const body = {
    product_id: Number(row.dataset.id),
    type: row.querySelector('.pr-ov-type').value,
    value: clear ? null : row.querySelector('.pr-ov-value').value
  };
  try {
    const json = await (await adminFetch('/api/admin/pricing/override', { method: 'POST', body: JSON.stringify(body) })).json();
    if (!json.success) throw new Error(json.error);
    loadPricingTable();
    loadPricing();
  } catch (err) {
    uiAlert('Lỗi: ' + err.message);
  }
});

// ============================ KIỂM TRA KẾT NỐI DROPBUY ============================
document.getElementById('healthCheckBtn').addEventListener('click', async () => {
  const btn = document.getElementById('healthCheckBtn');
  const out = document.getElementById('healthResult');
  btn.disabled = true;
  out.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang kiểm tra các API DropBuy...';
  try {
    const json = await (await adminFetch('/api/admin/dropbuy-health')).json();
    if (!json.success) throw new Error(json.error);
    const r = json.data;
    out.innerHTML = `
      <div style="margin-bottom:8px;"><strong style="color:${r.ok ? '#10b981' : '#ef4444'};">${r.ok ? '✅ Các API bắt buộc hoạt động bình thường' : '❌ Có API bắt buộc đang lỗi'}</strong> · ${new Date(r.checked_at).toLocaleTimeString('vi-VN')}</div>
      <table class="orders-table"><tbody>${r.checks.map(c => `
        <tr><td>${c.ok ? '✅' : c.required ? '❌' : '⚠️'} ${esc(c.name)}</td><td>${c.ms} ms</td><td>${esc(c.detail)}</td></tr>`).join('')}
      </tbody></table>`;
  } catch (e) {
    out.innerText = 'Lỗi: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

socket.on('PRODUCTS_UPDATED', () => {
  clearTimeout(window.__prReload);
  window.__prReload = setTimeout(() => { loadPricing(); loadPricingTable(); }, 1500);
});

loadPricing();
loadPricingTable();


// ============================ PHÍ VẬN CHUYỂN & HẠN THANH TOÁN ============================
const SH_FIELDS = { shNorth: ['fees', 'north'], shCentral: ['fees', 'central'], shSouth: ['fees', 'south'], shIncluded: ['includedWeightGram'], shPerKg: ['perExtraKg'], shFree: ['freeShipThreshold'], shDefaultWeight: ['defaultWeightGram'] };

async function loadShippingSettings() {
  try {
    const json = await (await adminFetch('/api/admin/shipping')).json();
    if (!json.success) throw new Error(json.error);
    const { shipping, orders } = json.data;
    document.getElementById('shEnabled').checked = shipping.enabled;
    document.getElementById('shMode').value = shipping.mode || 'live';
    document.getElementById('shLiveExtra').value = shipping.liveExtra || 0;
    for (const [id, path] of Object.entries(SH_FIELDS)) document.getElementById(id).value = path.reduce((o, k) => o[k], shipping);
    document.getElementById('odTimeout').value = orders.paymentTimeoutMinutes;
    document.getElementById('odAlert').value = orders.reportedAlertHours;
  } catch (e) {
    document.getElementById('shippingSaveMsg').innerText = 'Lỗi tải cấu hình: ' + e.message;
  }
}

document.getElementById('shippingForm').addEventListener('submit', async e => {
  e.preventDefault();
  const val = id => Number(document.getElementById(id).value);
  const body = {
    shipping: {
      enabled: document.getElementById('shEnabled').checked,
      fees: { north: val('shNorth'), central: val('shCentral'), south: val('shSouth') },
      includedWeightGram: val('shIncluded'),
      perExtraKg: val('shPerKg'),
      freeShipThreshold: val('shFree'),
      defaultWeightGram: val('shDefaultWeight'),
      mode: document.getElementById('shMode').value,
      liveExtra: val('shLiveExtra')
    },
    orders: { paymentTimeoutMinutes: val('odTimeout'), reportedAlertHours: val('odAlert') }
  };
  const msg = document.getElementById('shippingSaveMsg');
  try {
    const json = await (await adminFetch('/api/admin/shipping', { method: 'POST', body: JSON.stringify(body) })).json();
    if (!json.success) throw new Error(json.error);
    msg.innerText = json.message;
    loadShippingSettings();
  } catch (err) {
    msg.innerText = 'Lỗi: ' + err.message;
  }
});

loadShippingSettings();


// ============================ THANH TOÁN TỰ ĐỘNG ============================
const PAY_RESULT = {
  CONFIRMED: ['#10b981', 'Đã tự xác nhận'],
  CONFIRMED_MULTI: ['#10b981', 'Đủ tiền sau nhiều lần CK'],
  UNDERPAID: ['#f59e0b', 'Thiếu tiền'],
  ALREADY_PAID: ['#f59e0b', 'Đơn đã thanh toán trước đó'],
  ORDER_CANCELLED: ['#ef4444', 'Đơn đã huỷ – cần xử lý'],
  UNMATCHED: ['#ef4444', 'Không khớp đơn']
};

async function loadPayments() {
  document.getElementById('sepayUrl').innerText = `${location.origin}/api/webhooks/sepay`;
  document.getElementById('cassoUrl').innerText = `${location.origin}/api/webhooks/casso`;
  try {
    const json = await (await adminFetch('/api/admin/payments')).json();
    if (!json.success) throw new Error(json.error);
    const c = json.configured;
    const pill = (on, name) => `<span class="auth-badge ${on ? 'badge-connected' : 'badge-disconnected'}" style="margin-left:6px;">${on ? '✓' : '✗'} ${name}</span>`;
    document.getElementById('paymentsConfigured').innerHTML = pill(c.sepay, 'SePay') + pill(c.casso, 'Casso') + pill(c.telegram, 'Telegram');
    const tbody = document.getElementById('paymentsTableBody');
    if (!json.data.length) return;
    tbody.innerHTML = json.data.map(t => {
      const [color, label] = PAY_RESULT[t.result] || ['#94a3b8', t.result];
      return `<tr>
        <td><small>${new Date(t.received_at).toLocaleString('vi-VN')}</small></td>
        <td>${esc(t.provider)}${t.bank ? `<br><small>${esc(t.bank)}</small>` : ''}</td>
        <td><strong>${formatPrice(t.amount)}</strong></td>
        <td style="max-width:260px;"><small>${esc(t.content)}</small></td>
        <td>${t.order_id ? `<code>${esc(t.order_id)}</code>` : '—'}</td>
        <td><span style="color:${color}; font-weight:700;">${label}</span>${t.note ? `<br><small style="color:#94a3b8;">${esc(t.note)}</small>` : ''}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    document.getElementById('paymentsConfigured').innerText = 'Lỗi: ' + e.message;
  }
}

socket.on('ADMIN_ORDER_CHANGED', () => loadPayments());
loadPayments();


// ============================ DOANH THU & LÃI ============================
async function loadReport() {
  try {
    const json = await (await adminFetch('/api/admin/report?days=30')).json();
    if (!json.success) throw new Error(json.error);
    const r = json.data;
    const card = (label, b) => `<div class="report-box">
      <div class="report-label">${label}</div>
      <div class="report-value">${formatPrice(b.revenue)}</div>
      <div class="report-sub">${b.orders} đơn · ${b.items} SP</div>
      <div class="report-sub">Lãi gộp: <strong style="color:${b.profit >= 0 ? '#10b981' : '#ef4444'};">${formatPrice(b.profit)}</strong></div>
      <div class="report-sub">Ship thu khách: ${formatPrice(b.shipping)}</div>
    </div>`;
    document.getElementById('reportTotals').innerHTML =
      card('Hôm nay', r.totals.today) + card('7 ngày', r.totals.last7) + card('30 ngày', r.totals.last30) + card('Tất cả', r.totals.all);
    const p = r.pipeline;
    document.getElementById('reportPipeline').innerHTML =
      `Đang chờ: <strong>${p.PENDING_PAYMENT}</strong> chờ CK · <strong style="color:#f59e0b;">${p.PAYMENT_REPORTED}</strong> khách báo đã CK · ` +
      `<strong style="color:#10b981;">${p.PAID}</strong> đã nhận tiền chưa đặt kho · <strong>${p.PROCESSING}</strong> đang giao · ${p.COMPLETED} xong · ${p.CANCELLED} huỷ`;
    const max = Math.max(1, ...r.daily.map(d => d.revenue));
    document.getElementById('reportChart').innerHTML = r.daily.map(d =>
      `<div class="report-bar" style="height:${Math.max(2, Math.round(d.revenue / max * 100))}%;" title="${d.day}: ${formatPrice(d.revenue)} · ${d.orders} đơn · lãi ${formatPrice(d.profit)}"></div>`).join('');
    const t = r.totals.last30;
    const notes = ['Tính theo ngày nhận tiền: chuyển khoản đã nhận tiền, COD đã giao xong. Lãi gộp = tiền khách trả − số DropBuy trừ quỹ (hàng + ship thật); đơn chưa đặt kho tạm tính bằng tiền hàng − giá vốn.'];
    if (t.cost_unknown_orders) notes.push(`⚠ ${t.cost_unknown_orders} đơn thiếu giá vốn (${formatPrice(t.cost_unknown_revenue)}) – không tính vào lãi.`);
    if (r.test_orders) notes.push(`Đã loại ${r.test_orders} đơn thử khỏi báo cáo.`);
    if (t.cost_public_orders) notes.push(`⚠ ${t.cost_public_orders} đơn tính vốn theo giá công khai (lúc đặt chưa đăng nhập DropBuy) – lãi thật có thể cao hơn.`);
    document.getElementById('reportNote').innerText = notes.join(' ');
    document.getElementById('reportTop').innerHTML = r.top_products.length
      ? `<table class="orders-table"><thead><tr><th>Sản phẩm</th><th>SL</th><th>Doanh thu</th><th>Lãi</th></tr></thead><tbody>${r.top_products.map(x =>
          `<tr><td>${esc(x.name)}${x.variant_name ? `<br><small>${esc(x.variant_name)}</small>` : ''}</td><td>${x.quantity}</td><td>${formatPrice(x.revenue)}</td><td>${formatPrice(x.profit)}</td></tr>`).join('')}</tbody></table>`
      : '<small style="color:#94a3b8;">Chưa có đơn đã thanh toán.</small>';
  } catch (e) {
    document.getElementById('reportTotals').innerText = 'Lỗi tải báo cáo: ' + e.message;
  }
}

async function loadBackupInfo() {
  try {
    const json = await (await adminFetch('/api/admin/backups')).json();
    const last = json.data?.[0];
    document.getElementById('backupInfo').innerText = last ? `Bản sao lưu gần nhất: ${last.day} (${json.data.length} bản)` : 'Chưa có bản sao lưu';
  } catch (e) {}
}

document.getElementById('backupNowBtn').addEventListener('click', async () => {
  const json = await (await adminFetch('/api/admin/backups', { method: 'POST' })).json();
  uiAlert(json.success ? `Đã sao lưu: ${json.data.files.join(', ')} → data/backups/${json.data.day}` : 'Lỗi: ' + json.error);
  loadBackupInfo();
});

socket.on('ADMIN_ORDER_CHANGED', () => loadReport());
loadReport();
loadBackupInfo();


// ============================ TỰ ĐẶT ĐƠN DROPBUY ============================
async function loadAutoOrder() {
  try {
    const json = await (await adminFetch('/api/admin/auto-order')).json();
    if (!json.success) throw new Error(json.error);
    const d = json.data;
    const a = d.autoOrder;
    document.getElementById('aoEnabled').checked = a.enabled;
    document.getElementById('aoMaxOrder').value = a.maxOrderSpend;
    document.getElementById('aoMaxDaily').value = a.maxDailySpend;
    document.getElementById('aoMinBalance').value = a.minBalance;
    document.getElementById('aoShipping').value = a.shippingMethod;
    document.getElementById('aoRequireProfit').checked = a.requireProfit;
    document.getElementById('aoLowBalance').value = a.lowBalanceAlert;
    const w = d.watchdog || {};
    const alerts = [...(w.alerts || [])];
    if (w.waiting) alerts.push(`${w.waiting} đơn đang chờ đặt sang DropBuy (sẽ tự đặt khi phiên còn hiệu lực).`);
    const box = document.getElementById('autoOrderAlerts');
    box.style.display = alerts.length ? 'block' : 'none';
    box.innerHTML = alerts.map(x => `<div><i class="fa-solid fa-triangle-exclamation"></i> ${esc(x)}</div>`).join('');
    const saved = d.paymentsSaved || {};
    document.getElementById('payCod').checked = saved.cod?.enabled !== false;
    document.getElementById('payCodMax').value = d.payments.cod.maxTotal;
    document.getElementById('payBank').checked = saved.bank?.enabled !== false;
    document.getElementById('payBankNote').innerText = d.bankReady ? '' : 'Chưa có số tài khoản – khách sẽ không thấy lựa chọn này.';
    const st = document.getElementById('autoOrderStatus');
    if (d.session) {
      const exp = new Date(d.session.expiresAt);
      const hours = Math.round((exp - Date.now()) / 3600e3);
      st.innerHTML = `<span class="auth-badge badge-connected">✓ ${esc(d.session.username || d.session.name || 'DropBuy')}</span>
        Quỹ khả dụng: <strong style="color:#10b981;">${d.balance?.available != null ? formatPrice(d.balance.available) : '?'}</strong>
        · Hôm nay đã đặt: <strong>${formatPrice(d.spentToday)}</strong>
        · Phiên hết hạn ${exp.toLocaleString('vi-VN')}${hours < 12 ? ' <span style="color:#ef4444;">(sắp hết – đăng nhập lại)</span>' : ''}`;
    } else {
      st.innerHTML = `<span class="auth-badge badge-disconnected">✗ Chưa đăng nhập DropBuy</span> <small style="color:#ef4444;">${esc(d.sessionError || 'Đăng nhập ở mục DropBuy phía trên để tự đặt đơn.')}</small>`;
    }
  } catch (e) {
    document.getElementById('autoOrderStatus').innerText = 'Lỗi: ' + e.message;
  }
}

document.getElementById('saveAutoOrderBtn').addEventListener('click', async () => {
  const enabled = document.getElementById('aoEnabled').checked;
  if (enabled && !await uiConfirm('Bật tự đặt đơn: mỗi đơn hợp lệ sẽ tự trừ quỹ DropBuy của bạn. Tiếp tục?')) return;
  const body = {
    autoOrder: {
      enabled,
      maxOrderSpend: Number(document.getElementById('aoMaxOrder').value),
      maxDailySpend: Number(document.getElementById('aoMaxDaily').value),
      minBalance: Number(document.getElementById('aoMinBalance').value),
      shippingMethod: document.getElementById('aoShipping').value,
      requireProfit: document.getElementById('aoRequireProfit').checked,
      lowBalanceAlert: Number(document.getElementById('aoLowBalance').value)
    },
    payments: {
      cod: { enabled: document.getElementById('payCod').checked, maxTotal: Number(document.getElementById('payCodMax').value) },
      bank: { enabled: document.getElementById('payBank').checked }
    }
  };
  const msg = document.getElementById('autoOrderMsg');
  try {
    const json = await (await adminFetch('/api/admin/auto-order', { method: 'POST', body: JSON.stringify(body) })).json();
    if (!json.success) throw new Error(json.error);
    msg.style.color = '#10b981';
    msg.innerText = `Đã lưu. Tự đặt đơn: ${json.data.autoOrder.enabled ? 'BẬT' : 'tắt'}.`;
    loadAutoOrder();
  } catch (e) {
    msg.style.color = '#ef4444';
    msg.innerText = 'Lỗi: ' + e.message;
  }
});

socket.on('ADMIN_ORDER_CHANGED', () => loadAutoOrder());
loadAutoOrder();


// ==========================================
// KHO TECHMALL.VN & BẢNG GIÁ RIÊNG
// ==========================================
let tmCurrentPage = 1;
let tmSearchTerm = '';

async function loadTechmallStatus() {
  try {
    const res = await (await adminFetch('/api/admin/techmall/status')).json();
    if (!res.success) return;
    const s = res.data || {};
    const badge = document.getElementById('tmDaemonBadge');
    const text = document.getElementById('tmDaemonText');
    const authBadge = document.getElementById('tmAuthBadge');
    const userInp = document.getElementById('tmLoginUser');
    const passInp = document.getElementById('tmLoginPass');
    const loginBtn = document.getElementById('btnTmLogin');
    const logoutBtn = document.getElementById('btnTmLogout');

    if (badge) {
      if (s.running) {
        badge.className = 'auth-badge badge-warning';
        badge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đồng bộ...';
      } else if (s.active) {
        badge.className = 'auth-badge badge-connected';
        badge.innerHTML = '<i class="fa-solid fa-bolt"></i> ' + (s.intervalMinutes || 10) + ' phút / lần';
      } else {
        badge.className = 'auth-badge badge-disconnected';
        badge.innerHTML = '<i class="fa-solid fa-pause"></i> Tạm dừng';
      }
    }

    if (text) {
      const lastOkStr = s.lastOk ? new Date(s.lastOk).toLocaleTimeString('vi-VN') : 'chưa có';
      const nextRunStr = s.nextRun ? new Date(s.nextRun).toLocaleTimeString('vi-VN') : '--:--';
      text.innerHTML = 'Lần đồng bộ gần nhất: <strong>' + lastOkStr + '</strong> (Đổi: <strong>' + (s.lastChanges || 0) + '</strong> SP). Lượt tiếp theo: <strong>' + nextRunStr + '</strong>. Tổng kho: <strong>' + (s.totalProducts || 0).toLocaleString('vi-VN') + '</strong> SP, <strong>' + (s.sellable || 0).toLocaleString('vi-VN') + '</strong> SP có ảnh đang lên kệ' +
        (s.imagesPending ? ', còn ' + s.imagesPending.toLocaleString('vi-VN') + ' SP đang đọc ảnh' : '') + (s.complete === false ? ' (lần quét trước thiếu trang – chưa gỡ SP nào)' : '') + '.' +
        (s.lastError ? ' <span style="color:#ef4444;">Lỗi: ' + esc(s.lastError) + '</span>' : '');
    }

    if (authBadge) {
      if (s.auth?.authenticated) {
        authBadge.className = 'auth-badge badge-connected';
        authBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Đã kết nối (' + esc(s.auth.username || 'Đại lý') + ')';
        if (userInp) userInp.value = s.auth.username || '';
        if (loginBtn) loginBtn.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'inline-flex';
      } else {
        authBadge.className = 'auth-badge badge-disconnected';
        authBadge.innerHTML = 'Chưa kết nối';
        if (loginBtn) loginBtn.style.display = 'inline-flex';
        if (logoutBtn) logoutBtn.style.display = 'none';
      }
    }
  } catch (err) {
    console.warn('[Admin] Lỗi load trạng thái TechMall:', err.message);
  }
}

async function loadTechmallPricing() {
  try {
    const res = await (await adminFetch('/api/admin/techmall/pricing')).json();
    if (!res.success) return;
    const { rules = {}, stats = {} } = res.data || {};

    const surchargeInp = document.getElementById('tmSurcharge');
    const markupInp = document.getElementById('tmMarkupPercent');
    const minProfitInp = document.getElementById('tmMinProfit');
    const roundToSel = document.getElementById('tmRoundTo');
    const capChk = document.getElementById('tmCapAtPublic');

    if (surchargeInp) surchargeInp.value = rules.surchargePercent ?? 10;
    if (markupInp) markupInp.value = rules.markupPercent ?? 25;
    if (minProfitInp) minProfitInp.value = rules.minProfit || 0;
    if (roundToSel) roundToSel.value = String(rules.roundTo || 1000);
    if (capChk) capChk.checked = !!rules.capAtPublic;

    const statTot = document.getElementById('tmStatTotal');
    const statSell = document.getElementById('tmStatSellable');
    const statAvg = document.getElementById('tmStatAvgProfit');
    const statWholesale = document.getElementById('tmStatWholesale');

    if (statTot) statTot.textContent = (stats.total || 0).toLocaleString('vi-VN');
    if (statSell) statSell.textContent = (stats.sellable || 0).toLocaleString('vi-VN');
    if (statAvg) statAvg.textContent = formatPrice(stats.avgProfit || 0) + ' / SP';
    if (statWholesale) statWholesale.textContent = (stats.wholesaleCount || 0).toLocaleString('vi-VN');
  } catch (err) {
    console.warn('[Admin] Lỗi load bảng giá TechMall:', err.message);
  }
}

async function loadTechmallProducts(page = 1, search = '') {
  tmCurrentPage = page;
  tmSearchTerm = search;
  const tbody = document.getElementById('tmProductsTableBody');
  const pageInfo = document.getElementById('tmPageInfo');
  const pagBtns = document.getElementById('tmPaginationBtns');
  if (!tbody) return;

  try {
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (search) params.set('search', search);

    const res = await (await adminFetch('/api/admin/techmall/products?' + params.toString())).json();
    if (!res.success || !Array.isArray(res.data)) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:24px; color:#ef4444;">Không thể tải danh sách sản phẩm TechMall</td></tr>';
      return;
    }

    if (res.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:32px; color:#94a3b8;"><i class="fa-solid fa-box-open" style="font-size:24px; margin-bottom:8px; display:block;"></i>Chưa có sản phẩm TechMall nào trong kho. Hãy bấm <strong>"Tải Toàn Bộ Kho TechMall"</strong> ở trên để bắt đầu nhập hàng.</td></tr>';
      if (pageInfo) pageInfo.textContent = '0 sản phẩm';
      if (pagBtns) pagBtns.innerHTML = '';
      return;
    }

    let rowsHtml = '';
    for (const p of res.data) {
      const cost = Number(p.cost || p.wholesale_price || 0);
      const price = Number(p.price || 0);
      const profit = price - cost;
      const profitColor = profit > 0 ? '#16a34a' : (profit < 0 ? '#dc2626' : '#64748b');
      const inStockBadge = p.in_stock !== false
        ? '<span class="status-pill status-ready">Còn hàng</span>'
        : '<span class="status-pill status-canceled">Hết hàng</span>';

      rowsHtml += '<tr>' +
        '<td><img src="' + esc(p.image || '/favicon.svg') + '" alt="" style="width:44px; height:44px; object-fit:contain; border-radius:6px; border:1px solid #e2e8f0; background:#f8fafc;" onerror="this.src=\'/favicon.svg\'"></td>' +
        '<td>' +
          '<div style="font-weight:600; color:#0f172a; max-width:320px; line-height:1.35; margin-bottom:2px;">' + esc(p.name) + '</div>' +
          '<div style="font-size:11.5px; color:#64748b;">SKU: <code>' + esc(p.sku || p.id) + '</code> | ID: ' + p.id + '</div>' +
        '</td>' +
        '<td style="font-size:12.5px; color:#475569;">' + esc(p.category_name || 'Phụ kiện') + '</td>' +
        '<td style="text-align:right; font-weight:600; color:#475569;">' + formatPrice(cost) + '</td>' +
        '<td style="text-align:right; font-weight:700; color:#0f172a;">' + formatPrice(price) + '</td>' +
        '<td style="text-align:right; font-weight:700; color:' + profitColor + ';">+' + formatPrice(profit) + '</td>' +
        '<td style="text-align:center;">' + inStockBadge + '</td>' +
      '</tr>';
    }
    tbody.innerHTML = rowsHtml;

    if (pageInfo) {
      pageInfo.textContent = 'Hiển thị ' + ((res.page - 1) * 20 + 1) + ' - ' + Math.min(res.page * 20, res.total) + ' trên tổng số ' + res.total.toLocaleString('vi-VN') + ' SP';
    }

    if (pagBtns) {
      let bHtml = '';
      if (res.page > 1) {
        bHtml += '<button type="button" class="btn btn-outline" style="padding:4px 10px; font-size:12px;" onclick="loadTechmallProducts(' + (res.page - 1) + ', tmSearchTerm)"><i class="fa-solid fa-chevron-left"></i> Trước</button>';
      }
      if (res.page < res.totalPages) {
        bHtml += '<button type="button" class="btn btn-outline" style="padding:4px 10px; font-size:12px;" onclick="loadTechmallProducts(' + (res.page + 1) + ', tmSearchTerm)">Sau <i class="fa-solid fa-chevron-right"></i></button>';
      }
      pagBtns.innerHTML = bHtml;
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:24px; color:#ef4444;">Lỗi: ' + esc(err.message) + '</td></tr>';
  }
}

function loadTechmallAll() {
  loadTechmallStatus();
  loadTechmallPricing();
  loadTechmallProducts(1, tmSearchTerm);
}

document.addEventListener('DOMContentLoaded', () => {
  const btnLogin = document.getElementById('btnTmLogin');
  const btnLogout = document.getElementById('btnTmLogout');
  const btnSavePricing = document.getElementById('btnSaveTmPricing');
  const btnSyncNow = document.getElementById('btnTechmallSyncNow');
  const btnCrawlAll = document.getElementById('btnTechmallCrawlAll');
  const btnSearch = document.getElementById('btnTmSearch');
  const searchInp = document.getElementById('tmSearchInput');

  if (btnLogin) {
    btnLogin.addEventListener('click', async () => {
      const u = (document.getElementById('tmLoginUser')?.value || '').trim();
      const p = document.getElementById('tmLoginPass')?.value || '';
      const rem = document.getElementById('tmRemember')?.checked ?? true;
      const msg = document.getElementById('tmAuthMsg');
      if (!u || !p) {
        await uiAlert('Vui lòng nhập tài khoản và mật khẩu TechMall');
        return;
      }
      btnLogin.disabled = true;
      btnLogin.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xác thực với TechMall.vn...';
      try {
        const res = await (await adminFetch('/api/admin/techmall/login', {
          method: 'POST',
          body: JSON.stringify({ username: u, password: p, remember: rem })
        })).json();
        if (!res.success) throw new Error(res.error);
        if (msg) {
          msg.style.display = 'block';
          msg.style.background = '#f0fdf4';
          msg.style.color = '#16a34a';
          msg.innerHTML = '<i class="fa-solid fa-circle-check"></i> ' + esc(res.message);
        }
        await uiAlert(res.message);
        loadTechmallAll();
      } catch (err) {
        if (msg) {
          msg.style.display = 'block';
          msg.style.background = '#fef2f2';
          msg.style.color = '#dc2626';
          msg.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> ' + esc(err.message);
        }
        await uiAlert('Đăng nhập TechMall thất bại: ' + err.message);
      } finally {
        btnLogin.disabled = false;
        btnLogin.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Đăng Nhập &amp; Kích Hoạt Giá Sỉ';
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      if (!await uiConfirm('Ngắt kết nối tài khoản TechMall? Sau khi đăng xuất, hệ thống sẽ chuyển sang dùng giá niêm yết bán lẻ.')) return;
      try {
        await adminFetch('/api/admin/techmall/logout', { method: 'POST' });
        await uiAlert('Đã đăng xuất tài khoản TechMall.');
        loadTechmallAll();
      } catch (err) {
        await uiAlert('Lỗi: ' + err.message);
      }
    });
  }

  if (btnSavePricing) {
    btnSavePricing.addEventListener('click', async () => {
      const surchargePercent = Number(document.getElementById('tmSurcharge')?.value || 0);
      const markupPercent = Number(document.getElementById('tmMarkupPercent')?.value || 25);
      const minProfit = Number(document.getElementById('tmMinProfit')?.value || 0);
      const roundTo = Number(document.getElementById('tmRoundTo')?.value || 1000);
      const capAtPublic = !!document.getElementById('tmCapAtPublic')?.checked;

      btnSavePricing.disabled = true;
      btnSavePricing.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang áp dụng giá mới cho toàn kho TechMall...';
      try {
        const res = await (await adminFetch('/api/admin/techmall/pricing', {
          method: 'POST',
          body: JSON.stringify({ surchargePercent, markupPercent, minProfit, roundTo, capAtPublic })
        })).json();
        if (!res.success) throw new Error(res.error);
        await uiAlert(res.message);
        loadTechmallPricing();
        loadTechmallProducts(tmCurrentPage, tmSearchTerm);
      } catch (err) {
        await uiAlert('Lỗi lưu bảng giá TechMall: ' + err.message);
      } finally {
        btnSavePricing.disabled = false;
        btnSavePricing.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Lưu &amp; Cập Nhật Giá TechMall Ngay';
      }
    });
  }

  if (btnSyncNow) {
    btnSyncNow.addEventListener('click', async () => {
      btnSyncNow.disabled = true;
      btnSyncNow.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang quét giá & kho 5 phút...';
      try {
        const res = await (await adminFetch('/api/admin/techmall/sync', { method: 'POST' })).json();
        await uiAlert(res.message || 'Đã kích hoạt quét đồng bộ TechMall!');
        setTimeout(() => loadTechmallAll(), 2500);
      } catch (err) {
        await uiAlert('Lỗi: ' + err.message);
      } finally {
        setTimeout(() => {
          btnSyncNow.disabled = false;
          btnSyncNow.innerHTML = '<i class="fa-solid fa-rotate"></i> Đồng Bộ Giá &amp; Tồn Kho Ngay';
        }, 1000);
      }
    });
  }

  if (btnCrawlAll) {
    btnCrawlAll.addEventListener('click', async () => {
      if (!await uiConfirm('Quét lại toàn bộ kho TechMall.vn (khoảng 10.000 sản phẩm)? Chạy nền trên máy chủ khoảng 1–3 phút; SP mới cần thêm vài phút để đọc ảnh.')) return;
      btnCrawlAll.disabled = true;
      btnCrawlAll.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang quét toàn kho...';
      try {
        const res = await (await adminFetch('/api/admin/techmall/fetch-all', {
          method: 'POST',
          body: JSON.stringify({ maxPages: 110 })
        })).json();
        await uiAlert(res.message || 'Đã bắt đầu quét toàn bộ kho TechMall trong nền!');
        setTimeout(() => loadTechmallAll(), 4000);
      } catch (err) {
        await uiAlert('Lỗi: ' + err.message);
      } finally {
        setTimeout(() => {
          btnCrawlAll.disabled = false;
          btnCrawlAll.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Tải Toàn Bộ Kho TechMall';
        }, 2000);
      }
    });
  }

  if (btnSearch && searchInp) {
    btnSearch.addEventListener('click', () => {
      loadTechmallProducts(1, searchInp.value.trim());
    });
    searchInp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadTechmallProducts(1, searchInp.value.trim());
      }
    });
  }
});

socket.on('ADMIN_TECHMALL_SYNC', () => {
  loadTechmallStatus();
  loadTechmallPricing();
});

loadTechmallStatus();
loadTechmallPricing();
