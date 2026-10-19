const socket = io();

const statProducts = document.getElementById('statProducts');
const statOrders = document.getElementById('statOrders');
const statRevenue = document.getElementById('statRevenue');
const syncNowBtn = document.getElementById('syncNowBtn');
const configForm = document.getElementById('configForm');
const ordersTableBody = document.getElementById('ordersTableBody');

// Form inputs
const cfgSimulationMode = document.getElementById('cfgSimulationMode');
const cfgMarkup = document.getElementById('cfgMarkup');
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
async function adminFetch(url, opts = {}, retry = true) {
  const key = sessionStorage.getItem(ADMIN_KEY_STORE) || '';
  const headers = { ...(opts.headers || {}), 'x-admin-key': key };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && retry) {
    const entered = prompt('Nhập mật khẩu quản trị (ADMIN_PASSWORD hoặc trong data/admin-secret.json):');
    if (!entered) throw new Error('Chưa đăng nhập quản trị');
    sessionStorage.setItem(ADMIN_KEY_STORE, entered.trim());
    return adminFetch(url, opts, false);
  }
  if (res.status === 401) {
    sessionStorage.removeItem(ADMIN_KEY_STORE);
    throw new Error('Sai mật khẩu quản trị');
  }
  return res;
}

const STATUS_LABEL = {
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
      cfgMarkup.value = cfg.pricing?.markupPercent ?? 15;
      cfgBankId.value = cfg.bank?.bankId || '970422';
      cfgAccountNo.value = cfg.bank?.accountNo || '0386888999';
      cfgAccountName.value = cfg.bank?.accountName || 'HOANG MINH STORE';
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
  if (orders.length === 0) {
    ordersTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #9ca3af; padding: 20px;">Chưa có đơn hàng nào</td></tr>`;
    return;
  }

  ordersTableBody.innerHTML = orders.map(o => {
    const [cls, label] = STATUS_LABEL[o.status] || ['pending', o.status];
    const cost = (o.items || []).reduce((s, i) => s + (i.dropbuy_cost || 0) * i.quantity, 0);
    const canConfirm = ['PENDING_PAYMENT', 'PAYMENT_REPORTED'].includes(o.status);
    const items = (o.items || []).map(i => {
      const name = i.dropbuy_url ? `<a href="${esc(i.dropbuy_url)}" target="_blank" rel="noopener" style="color:#c9a84c;">${esc(i.name)}</a>` : esc(i.name);
      return `${name} × ${i.quantity}${i.dropbuy_cost ? ` <span title="Giá vốn DropBuy">(${formatPrice(i.dropbuy_cost)})</span>` : ''}`;
    }).join('<br>');
    let actions;
    if (canConfirm) {
      actions = `<button class="btn-check-paid" style="padding: 4px 8px; font-size: 11px;" onclick="confirmOrder('${esc(o.id)}')">Xác Nhận Đã Nhận Tiền</button>
        <button class="btn-ghost" style="padding: 4px 8px; font-size: 11px; margin-top: 4px;" onclick="setOrderStatus('${esc(o.id)}', 'CANCELLED')">Huỷ đơn</button>`;
    } else if (o.status === 'PAID') {
      actions = `<button class="btn-check-paid" style="padding: 4px 8px; font-size: 11px;" onclick="setOrderStatus('${esc(o.id)}', 'PROCESSING')">Đã đặt bên DropBuy</button>`;
    } else if (o.status === 'PROCESSING') {
      actions = `<button class="btn-check-paid" style="padding: 4px 8px; font-size: 11px;" onclick="setOrderStatus('${esc(o.id)}', 'COMPLETED')">Đã giao xong</button>`;
    } else {
      actions = `<span style="color: #10b981; font-size: 12px;"><i class="fa-solid fa-check"></i> ${label}</span>`;
    }
    return `
    <tr>
      <td><strong>#${esc(o.id)}</strong><br><small style="color:#6b7280;">${new Date(o.created_at).toLocaleString('vi-VN')}</small></td>
      <td><code>${esc(o.dropbuy_sync?.order_id || 'Chưa đặt')}</code><br><small style="color:#6b7280;">${esc(o.dropbuy_sync?.relay_mode || '')}</small></td>
      <td>
        <strong>${esc(o.customer?.name)}</strong><br>
        <small style="color: #6b7280;">${esc(o.customer?.phone)}</small><br>
        <small style="color: #6b7280;">${esc(o.customer?.address)}</small>
        ${o.customer?.note ? `<br><small style="color:#f59e0b;">Ghi chú: ${esc(o.customer.note)}</small>` : ''}
      </td>
      <td class="order-items-cell">${items}${cost ? `<br><strong>Lãi gộp: ${formatPrice(o.total_amount - cost)}</strong>` : ''}</td>
      <td><strong style="color: #e11d48;">${formatPrice(o.total_amount)}</strong></td>
      <td><span class="status-pill ${cls}">${label}</span></td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

async function setOrderStatus(orderId, status) {
  if (status === 'CANCELLED' && !confirm(`Huỷ đơn #${orderId}?`)) return;
  try {
    const json = await (await adminFetch(`/api/admin/orders/${orderId}/status`, { method: 'POST', body: JSON.stringify({ status }) })).json();
    if (!json.success) throw new Error(json.error);
    loadData();
  } catch (e) {
    alert('Lỗi: ' + e.message);
  }
}

async function confirmOrder(orderId) {
  try {
    if (!confirm(`Xác nhận đã nhận đủ tiền cho đơn #${orderId}? (kiểm tra sao kê ngân hàng trước)`)) return;
    const res = await adminFetch(`/api/orders/${orderId}/confirm-payment`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      alert(`Đã xác nhận thanh toán đơn #${orderId}! Sự kiện realtime đã được bắn tới khách hàng.`);
      loadData();
    } else {
      alert('Lỗi: ' + json.error);
    }
  } catch (e) {
    alert('Lỗi: ' + e.message);
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
    pricing: {
      markupPercent: Number.isFinite(parseFloat(cfgMarkup.value)) ? parseFloat(cfgMarkup.value) : 15
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
    alert(json.success ? json.message : 'Lỗi: ' + json.error);
  } catch (err) {
    alert('Lỗi lưu cấu hình: ' + err.message);
  }
});

// Trigger full sync
syncNowBtn.addEventListener('click', async () => {
  if (!confirm('Bạn có muốn đồng bộ lại 100% toàn bộ kho hàng từ DropBuy.vn ngay bây giờ?')) return;

  syncNowBtn.disabled = true;
  syncNowBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đồng bộ từ DropBuy...';

  try {
    const res = await adminFetch('/api/admin/sync', { method: 'POST', body: JSON.stringify({ maxPages: 20 }) });
    const json = await res.json();
    alert(json.message);
  } catch (err) {
    alert('Lỗi khởi động đồng bộ: ' + err.message);
    syncNowBtn.disabled = false;
    syncNowBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Đồng Bộ Lại Toàn Bộ Kho DropBuy';
  }
});

// Trigger full image & details download
const downloadAllImagesBtn = document.getElementById('downloadAllImagesBtn');
if (downloadAllImagesBtn) {
  downloadAllImagesBtn.addEventListener('click', async () => {
    if (!confirm('Tải chi tiết & toàn bộ album ảnh của tất cả sản phẩm về ổ đĩa server? (chạy nền, mất nhiều thời gian)')) return;

    downloadAllImagesBtn.disabled = true;
    downloadAllImagesBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải album ảnh ngầm...';

    try {
      const res = await adminFetch('/api/admin/download-all-images', { method: 'POST' });
      const json = await res.json();
      alert(json.message);
    } catch (err) {
      alert('Lỗi: ' + err.message);
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
  alert(`Đã hoàn tất tải 100% album ảnh của toàn bộ ${data.total} sản phẩm về lưu trữ trên máy chủ!`);
  if (downloadAllImagesBtn) {
    downloadAllImagesBtn.disabled = false;
    downloadAllImagesBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Tải Full Album Ảnh Về Ổ Đĩa Server';
  }
});

// Realtime listeners
socket.on('CATALOG_SYNC_COMPLETED', data => {
  const msg = data.wholesale ? `Đã đồng bộ xong ${data.total} sản phẩm kèm GIÁ SỈ ĐẠI LÝ F1!` : `Đã đồng bộ xong toàn bộ ${data.total} sản phẩm từ kho DropBuy!`;
  alert(msg);
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
      if (daemonStatusText) {
        daemonStatusText.innerHTML = `Đang đồng bộ <strong>${(d.totalProducts || 0).toLocaleString('vi-VN')} SP</strong> (giá & tồn kho) mỗi <strong>${d.intervalMinutes} phút</strong>. Quét gần nhất: <strong>${lastStr}</strong> ➔ Lần kế tiếp: <strong>${nextStr}</strong>${d.lastError ? ` · <span style="color:#ef4444;">Lỗi lần trước: ${esc(d.lastError)}</span>` : ''}`;
      }
    }
  } catch (e) {}
}
setInterval(updateDaemonStatusUI, 15000);

socket.on('REALTIME_HEARTBEAT', data => {
  updateDaemonStatusUI();
});

async function updateAuthStatusUI() {
  updateDaemonStatusUI();
  try {
    const res = await adminFetch('/api/dropbuy/auth-status').then(r => r.json());
    if (res.success && res.data) {
      const d = res.data;
      if (d.authenticated) {
        dropbuyAuthBadge.className = 'auth-badge badge-connected';
        dropbuyAuthBadge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Đã kết nối: ${esc(d.username || 'Đại lý')}`;
        btnDropbuyLogin.style.display = 'none';
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
      alert('Vui lòng nhập đầy đủ tài khoản và mật khẩu DropBuy!');
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
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Đăng nhập DropBuy thất bại');
      }

      alert('Đăng nhập DropBuy thành công! Hệ thống đang tự động đồng bộ lại 100% kho hàng theo GIÁ SỈ ĐẠI LÝ F1.');
      updateAuthStatusUI();
      loadData();
    } catch (err) {
      alert('Lỗi: ' + err.message);
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
    if (!confirm('Bạn có chắc muốn đăng xuất DropBuy? Hệ thống sẽ quay về giá bán lẻ công khai.')) return;
    try {
      await adminFetch('/api/dropbuy/logout', { method: 'POST' });
      alert('Đã đăng xuất tài khoản DropBuy.');
      updateAuthStatusUI();
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  });
}

if (btnSaveCookie) {
  btnSaveCookie.addEventListener('click', async () => {
    const cookie = dropbuyManualCookie.value.trim();
    if (!cookie) {
      alert('Vui lòng dán chuỗi cookie!');
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
      alert('Lưu cookie thành công! Đã kích hoạt giá sỉ đại lý.');
      dropbuyManualCookie.value = '';
      updateAuthStatusUI();
      loadData();
    } catch (err) {
      alert('Lỗi: ' + err.message);
    } finally {
      btnSaveCookie.disabled = false;
      btnSaveCookie.innerText = 'Lưu Cookie';
    }
  });
}

loadData();
updateAuthStatusUI();
