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

async function loadData() {
  // Load stats & config
  try {
    const [cfgRes, ordRes, prodRes] = await Promise.all([
      fetch('/api/admin/config').then(r => r.json()),
      fetch('/api/admin/orders').then(r => r.json()),
      fetch('/api/products?limit=1').then(r => r.json())
    ]);

    // Fill Config
    if (cfgRes.success && cfgRes.data) {
      const cfg = cfgRes.data;
      if (document.getElementById('dropbuyLoginUser')) {
        document.getElementById('dropbuyLoginUser').value = cfg.dropbuy?.username || '';
      }
      cfgSimulationMode.checked = cfg.dropbuy?.simulationMode !== false;
      cfgMarkup.value = cfg.pricing?.markupPercent || 15;
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
        .filter(o => o.status === 'PAID')
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
    ordersTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #9ca3af; padding: 20px;">Chưa có đơn hàng nào</td></tr>`;
    return;
  }

  ordersTableBody.innerHTML = orders.map(o => `
    <tr>
      <td><strong>#${o.id}</strong></td>
      <td><code>${o.dropbuy_sync?.order_id || 'Chưa sync'}</code></td>
      <td>
        <strong>${o.customer?.name || ''}</strong><br>
        <small style="color: #6b7280;">${o.customer?.phone || ''}</small>
      </td>
      <td><strong style="color: #e11d48;">${formatPrice(o.total_amount)}</strong></td>
      <td>
        <span class="status-pill ${o.status === 'PAID' ? 'paid' : 'pending'}">
          ${o.status === 'PAID' ? 'ĐÃ THANH TOÁN' : 'CHỜ THANH TOÁN'}
        </span>
      </td>
      <td>
        ${o.status !== 'PAID' ? `
          <button class="btn-check-paid" style="padding: 4px 8px; font-size: 11px;" onclick="confirmOrder('${o.id}')">
            Xác Nhận Đã Nhận Tiền
          </button>
        ` : `
          <span style="color: #10b981; font-size: 12px;"><i class="fa-solid fa-check"></i> Hoàn tất</span>
        `}
      </td>
    </tr>
  `).join('');
}

async function confirmOrder(orderId) {
  try {
    const res = await fetch(`/api/orders/${orderId}/confirm-payment`, { method: 'POST' });
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
      markupPercent: parseFloat(cfgMarkup.value) || 15
    },
    bank: {
      bankId: cfgBankId.value,
      bankName: cfgBankId.options[cfgBankId.selectedIndex].text.split('(')[0].trim(),
      accountNo: cfgAccountNo.value.trim(),
      accountName: cfgAccountName.value.trim()
    }
  };

  try {
    const res = await fetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newConfig)
    });
    const json = await res.json();
    if (json.success) {
      alert('Đã lưu cấu hình DropBuy & VietQR thành công!');
    }
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
    const res = await fetch('/api/admin/sync', { method: 'POST', body: JSON.stringify({ maxPages: 15 }) });
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
    if (!confirm('Bạn có muốn kích hoạt cào full chi tiết & tải toàn bộ album ảnh của 1.136 sản phẩm về lưu trữ trên ổ đĩa server không?')) return;

    downloadAllImagesBtn.disabled = true;
    downloadAllImagesBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải album ảnh ngầm...';

    try {
      const res = await fetch('/api/admin/download-all-images', { method: 'POST' });
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
      const lastStr = d.lastSyncTime ? new Date(d.lastSyncTime).toLocaleTimeString('vi-VN') : 'Vừa xong';
      const nextStr = d.nextSyncTime ? new Date(d.nextSyncTime).toLocaleTimeString('vi-VN') : '5 phút nữa';
      if (daemonStatusText) {
        daemonStatusText.innerHTML = `Đang đồng bộ liên tục <strong>1.316 SP</strong> (Giá & Tồn kho) mỗi <strong>5 phút</strong>. Quét gần nhất: <strong>${lastStr}</strong> ➔ Lần kế tiếp: <strong>${nextStr}</strong>`;
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
    const res = await fetch('/api/dropbuy/auth-status').then(r => r.json());
    if (res.success && res.data) {
      const d = res.data;
      if (d.authenticated) {
        dropbuyAuthBadge.className = 'auth-badge badge-connected';
        dropbuyAuthBadge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Đã kết nối: ${d.username || 'Đại lý'}`;
        btnDropbuyLogin.style.display = 'none';
        btnDropbuyLogout.style.display = 'inline-block';
        dropbuyLoginPass.value = '';
        dropbuyAuthMsg.style.display = 'block';
        dropbuyAuthMsg.style.background = 'rgba(16, 185, 129, 0.15)';
        dropbuyAuthMsg.style.color = '#10b981';
        dropbuyAuthMsg.style.border = '1px solid rgba(16, 185, 129, 0.3)';
        dropbuyAuthMsg.innerHTML = `<i class="fa-solid fa-bolt"></i> <strong>${d.message}</strong>`;
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
          dropbuyAuthMsg.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${d.message}`;
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
      const res = await fetch('/api/dropbuy/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      dropbuyAuthMsg.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Lỗi: ${err.message}`;
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
      await fetch('/api/dropbuy/logout', { method: 'POST' });
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
      const res = await fetch('/api/dropbuy/set-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
