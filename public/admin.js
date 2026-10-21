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
  const headers = { ...(opts.headers || {}), 'x-admin-key': key };
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
      statOrders.innerText = orders.length;

      const revenue = orders
        .filter(o => ['PAID', 'PROCESSING', 'COMPLETED'].includes(o.status))
        .reduce((sum, o) => sum + (o.total_amount || 0), 0);
      statRevenue.innerText = formatPrice(revenue);

      renderOrders(orders);
    }

  } catch (err) {
    console.error('Lỗi tải dữ liệu admin:', err);
  }
}

function renderOrders(orders) {
  lastOrders = orders;
  if (orders.length === 0) {
    ordersTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #9ca3af; padding: 20px;">Chưa có đơn hàng nào</td></tr>`;
    return;
  }

  ordersTableBody.innerHTML = orders.map(o => {
    const [cls, label] = STATUS_LABEL[o.status] || ['pending', o.status];
    const cost = (o.items || []).reduce((s, i) => s + (i.dropbuy_cost || 0) * i.quantity, 0);
    const canConfirm = o.payment_method !== 'COD' && ['PENDING_PAYMENT', 'PAYMENT_REPORTED'].includes(o.status);
    const ds = o.dropbuy_sync || {};
    const dbNote = ds.status === 'WAITING_DROPBUY_LOGIN' ? '<br><small style="color:#ef4444;">⚠ Chưa đăng nhập DropBuy</small>'
      : ds.status === 'FAILED' ? `<br><small style="color:#ef4444;">⚠ ${esc(ds.error || 'Lỗi DropBuy')}</small>`
      : ds.status === 'SUBMIT_UNKNOWN' ? `<br><small style="color:#ef4444;">⚠ ${esc(ds.error)}</small>`
      : ds.status === 'SUBMITTING' ? '<br><small style="color:#f59e0b;">Đang gửi sang DropBuy...</small>'
      : ds.status === 'IN_DROPBUY_CART' ? '<br><small style="color:#10b981;">✓ Đã nằm trong giỏ DropBuy</small>' : '';
    const readyForKho = (o.payment_method === 'COD' && o.status === 'CONFIRMED') || (o.payment_method !== 'COD' && o.status === 'PAID');
    const items = (o.items || []).map(i => {
      const name = i.dropbuy_url ? `<a href="${esc(i.dropbuy_url)}" target="_blank" rel="noopener" style="color:#c9a84c;">${esc(i.name)}</a>` : esc(i.name);
      return `${name}${i.variant_name ? ` <em style="color:#94a3b8;">[${esc(i.variant_name)}]</em>` : ''} × ${i.quantity}${i.sku ? ` <small style="color:#64748b;">${esc(i.sku)}</small>` : ''}${i.dropbuy_cost ? ` <span title="Giá vốn DropBuy">(${formatPrice(i.dropbuy_cost)})</span>` : ''}`;
    }).join('<br>');
    let actions;
    if (canConfirm) {
      actions = `<button class="btn-check-paid" style="padding: 4px 8px; font-size: 11px;" onclick="confirmOrder('${esc(o.id)}')">Xác Nhận Đã Nhận Tiền</button>
        <button class="btn-ghost" style="padding: 4px 8px; font-size: 11px; margin-top: 4px;" onclick="setOrderStatus('${esc(o.id)}', 'CANCELLED')">Huỷ đơn</button>`;
    } else if (readyForKho) {
      const locked = ['SUBMITTING', 'SUBMIT_UNKNOWN'].includes(ds.status);
      actions = `${locked ? '' : `<button class="btn-check-paid" style="padding: 4px 8px; font-size: 11px;" onclick="placeOnDropbuy('${esc(o.id)}')"><i class="fa-solid fa-bolt"></i> Đặt DropBuy ngay (trừ quỹ)</button><br>`}
        <button class="btn-ghost" style="padding: 4px 8px; font-size: 11px; margin-top: 4px;" onclick="pushToDropbuyCart('${esc(o.id)}')"><i class="fa-solid fa-cart-arrow-down"></i> Chỉ đưa vào giỏ</button>
        ${o.payment_method === 'COD' ? `<button class="btn-ghost" style="padding: 4px 8px; font-size: 11px; margin-top: 4px;" onclick="setOrderStatus('${esc(o.id)}', 'CANCELLED')">Huỷ đơn</button>` : ''}
        <button class="btn-ghost" style="padding: 4px 8px; font-size: 11px; margin-top: 4px;" onclick="copyReceiver('${esc(o.id)}')"><i class="fa-regular fa-copy"></i> Sao chép người nhận</button>
        <button class="btn-check-paid" style="padding: 4px 8px; font-size: 11px; margin-top: 4px;" onclick="attachDropbuyCode('${esc(o.id)}')">Đã đặt – nhập mã DropBuy</button>
        ${dbNote}`;
    } else if (o.status === 'PROCESSING') {
      actions = `${o.dropbuy_sync?.problem ? `<small style="color:#ef4444;">⚠ ${esc(o.dropbuy_sync.problem)}</small><br>` : ''}${(ds.orders || []).length || ds.order_id ? `<button class="btn-ghost" style="padding: 4px 8px; font-size: 11px; margin-bottom: 4px;" onclick="cancelOnDropbuy('${esc(o.id)}')">Huỷ trên DropBuy</button><br>` : ''}<button class="btn-check-paid" style="padding: 4px 8px; font-size: 11px;" onclick="setOrderStatus('${esc(o.id)}', 'COMPLETED')">Đã giao xong</button>`;
    } else {
      actions = `<span style="color: #10b981; font-size: 12px;"><i class="fa-solid fa-check"></i> ${label}</span>`;
    }
    return `
    <tr>
      <td><strong>#${esc(o.id)}</strong><br><small style="color:#6b7280;">${new Date(o.created_at).toLocaleString('vi-VN')}</small></td>
      <td><code>${esc((ds.orders || []).map(x => x.code).join(', ') || ds.order_code || 'Chưa đặt')}</code>${ds.spend ? `<br><small style="color:#94a3b8;">Trừ quỹ ${formatPrice(ds.spend)}</small>` : ''}${o.dropbuy_sync?.current_label ? `<br><small style="color:#10b981;">${esc(o.dropbuy_sync.current_label)}</small>` : ''}${o.dropbuy_sync?.shipping_ref_code ? `<br><small style="color:#6b7280;">VĐ: ${esc(o.dropbuy_sync.shipping_ref_code)}</small>` : ''}</td>
      <td>
        <strong>${esc(o.customer?.name)}</strong><br>
        <small style="color: #6b7280;">${esc(o.customer?.phone)}</small><br>
        <small style="color: #6b7280;">${esc(o.customer?.address)}${o.customer?.ward_name ? `, ${esc(o.customer.ward_name)}` : ""}${o.customer?.province ? `, ${esc(o.customer.province)}` : ''}</small>
        ${o.customer?.note ? `<br><small style="color:#f59e0b;">Ghi chú: ${esc(o.customer.note)}</small>` : ''}
      </td>
      <td class="order-items-cell">${items}${o.shipping_fee != null ? `<br>Ship: ${o.shipping_fee ? formatPrice(o.shipping_fee) : 'miễn phí'}${o.customer?.province ? ` (${esc(o.customer.province)})` : ''}` : ''}${cost ? `<br><strong>Lãi gộp hàng: ${formatPrice((o.subtotal ?? o.total_amount) - cost)}</strong>` : ''}</td>
      <td><strong style="color: #e11d48;">${formatPrice(o.total_amount)}</strong><br><small style="color:${o.payment_method === 'COD' ? '#38bdf8' : '#94a3b8'};">${o.payment_method === 'COD' ? 'COD – thu khi giao' : 'Chuyển khoản'}</small>${ds.spend ? `<br><small style="color:#10b981;">Lãi ${formatPrice(o.total_amount - ds.spend)}</small>` : ''}${o.payment_via ? `<br><small style="color:#10b981;">${o.payment_via === 'admin' ? 'xác nhận tay' : `tự động: ${esc(o.payment_via)}`}</small>` : ''}${o.late_payment ? `<br><small style="color:#ef4444;">Tiền về sau khi huỷ: ${formatPrice(o.late_payment.amount)}</small>` : ''}</td>
      <td><span class="status-pill ${cls}">${label}</span>${o.needs_attention && o.status === 'PAYMENT_REPORTED' ? '<br><small style="color:#ef4444;">⚠ Khách báo CK đã lâu – cần đối soát</small>' : ''}${o.cancel_reason ? `<br><small style="color:#94a3b8;">${esc(o.cancel_reason)}</small>` : ''}</td>
      <td>${actions}</td>
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

function copyReceiver(orderId, silent = false) {
  const o = lastOrders.find(x => x.id === orderId);
  if (!o) return;
  const text = `${o.customer?.name}\n${o.customer?.phone}\n${o.customer?.address}${o.customer?.ward_name ? `, ${o.customer.ward_name}` : ""}${o.customer?.province ? `, ${o.customer.province}` : ''}${o.customer?.note ? `\nGhi chú: ${o.customer.note}` : ''}`;
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
    const res = await fetch('/api/realtime/status').then(r => r.json());
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
        btnDropbuyLogin.style.display = 'inline-block';
        btnDropbuyLogin.innerHTML = `<i class="fa-solid fa-rotate"></i> ${d.remember?.saved ? 'Đăng nhập lại & gia hạn phiên' : 'Đăng nhập lại & ghi nhớ (tự gia hạn)'}`;
        btnDropbuyLogout.style.display = 'inline-block';
        dropbuyLoginPass.value = '';
        dropbuyAuthMsg.style.display = 'block';
        dropbuyAuthMsg.style.background = 'rgba(16, 185, 129, 0.15)';
        dropbuyAuthMsg.style.color = '#10b981';
        dropbuyAuthMsg.style.border = '1px solid rgba(16, 185, 129, 0.3)';
        dropbuyAuthMsg.innerHTML = `<i class="fa-solid fa-bolt"></i> <strong>${esc(d.message)}</strong>`;
      } else {
        dropbuyAuthBadge.className = 'auth-badge badge-disconnected';
        dropbuyAuthBadge.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Chưa kết nối`;
        btnDropbuyLogin.style.display = 'inline-block';
        btnDropbuyLogin.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Đăng Nhập & Kích Hoạt Giá Sỉ';
        btnDropbuyLogout.style.display = 'none';
        if (d.expired) {
          dropbuyAuthMsg.style.display = 'block';
          dropbuyAuthMsg.style.background = 'rgba(239, 68, 68, 0.15)';
          dropbuyAuthMsg.style.color = '#ef4444';
          dropbuyAuthMsg.style.border = '1px solid rgba(239, 68, 68, 0.3)';
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
    dropbuyAuthMsg.style.background = 'rgba(245, 158, 11, 0.15)';
    dropbuyAuthMsg.style.color = '#f59e0b';
    dropbuyAuthMsg.style.border = '1px solid rgba(245, 158, 11, 0.3)';
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
      dropbuyAuthMsg.style.background = 'rgba(239, 68, 68, 0.15)';
      dropbuyAuthMsg.style.color = '#ef4444';
      dropbuyAuthMsg.style.border = '1px solid rgba(239, 68, 68, 0.3)';
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
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#9ca3af; padding:16px;">Không có sản phẩm</td></tr>';
    } else {
      tbody.innerHTML = json.data.map(r => `
        <tr data-id="${r.id}">
          <td style="max-width:320px;">
            <a href="${esc(r.dropbuy_url)}" target="_blank" rel="noopener" style="color:#e2e8f0;">${esc(r.name)}</a><br>
            <small style="color:#64748b;">${esc(r.sku)} · ${esc(r.category_name || '')}${r.in_stock ? '' : ' · <span style="color:#ef4444;">hết hàng</span>'}</small>
          </td>
          <td>${formatPrice(r.public_price)}</td>
          <td>${r.wholesale_price ? `<strong>${formatPrice(r.wholesale_price)}</strong>` : '<small style="color:#64748b;">chưa có</small>'}</td>
          <td><strong style="color:#c9a84c;">${formatPrice(r.price)}</strong><br><small style="color:#64748b;">${esc(r.rule || '')}</small></td>
          <td style="color:${r.profit < 0 ? '#ef4444' : '#10b981'};"><strong>${formatPrice(r.profit)}</strong></td>
          <td style="white-space:nowrap;">
            <select class="pr-ov-type" style="width:auto;">
              <option value="percent" ${r.override?.type === 'percent' ? 'selected' : ''}>% lãi</option>
              <option value="fixed" ${r.override?.type === 'fixed' ? 'selected' : ''}>giá cố định</option>
            </select>
            <input class="pr-ov-value" type="number" min="0" style="width:110px;" value="${r.override ? r.override.value : ''}" placeholder="mặc định">
            <button type="button" class="btn-check-paid pr-ov-save" style="padding:4px 8px; font-size:11px;">Lưu</button>
            ${r.override ? '<button type="button" class="btn-ghost pr-ov-clear" style="padding:4px 8px; font-size:11px;">Bỏ</button>' : ''}
          </td>
        </tr>`).join('');
    }
    const pag = document.getElementById('pricingPagination');
    pag.innerHTML = json.totalPages > 1 ? `
      <button type="button" class="pag-btn" ${json.page <= 1 ? 'disabled' : ''} data-page="${json.page - 1}">‹ Trước</button>
      <span>Trang ${json.page}/${json.totalPages} · ${json.total.toLocaleString('vi-VN')} SP</span>
      <button type="button" class="pag-btn" ${json.page >= json.totalPages ? 'disabled' : ''} data-page="${json.page + 1}">Sau ›</button>` : `<span>${json.total.toLocaleString('vi-VN')} SP</span>`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#ef4444;">Lỗi: ${esc(e.message)}</td></tr>`;
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
    const notes = ['Tính theo ngày nhận tiền, chỉ đơn đã thanh toán. Lãi gộp = tiền hàng − giá vốn DropBuy lúc đặt, chưa trừ phí ship thật của kho.'];
    if (t.cost_public_orders) notes.push(`⚠ ${t.cost_public_orders} đơn tính vốn theo giá công khai (lúc đặt chưa đăng nhập DropBuy) – lãi thật có thể cao hơn.`);
    if (t.cost_unknown_orders) notes.push(`⚠ ${t.cost_unknown_orders} đơn thiếu giá vốn.`);
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
