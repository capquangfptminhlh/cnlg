// --- Storefront State ---
const state = {
  products: [],
  categories: [],
  currentCategory: 'all',
  currentPage: 1,
  limit: 24,
  searchQuery: '',
  sort: 'default',
  minPrice: '',
  maxPrice: '',
  cart: [],
  activeOrder: null,
  countdownInterval: null,
  activeDetailProduct: null,
  selectedGalleryIndex: 0
};

// Initialize Socket.io
const socket = io();

// --- DOM Elements ---
const categoriesContainer = document.getElementById('categoriesContainer');
const productGrid = document.getElementById('productGrid');
const pagination = document.getElementById('pagination');
const catalogTitle = document.getElementById('catalogTitle');
const catalogCount = document.getElementById('catalogCount');
const heroTotalProd = document.getElementById('heroTotalProd');
const btnLoadMore = document.getElementById('btnLoadMore');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const searchClearBtn = document.getElementById('searchClearBtn');
const searchDropdown = document.getElementById('searchDropdown');
const sortSelect = document.getElementById('sortSelect');
const pricePills = document.querySelectorAll('.price-pill');

// Cart & Drawer DOM
const openCartBtn = document.getElementById('openCartBtn');
const closeCartBtn = document.getElementById('closeCartBtn');
const cartDrawer = document.getElementById('cartDrawer');
const cartBackdrop = document.getElementById('cartBackdrop');
const cartItemsContainer = document.getElementById('cartItemsContainer');
const cartCount = document.getElementById('cartCount');
const drawerCount = document.getElementById('drawerCount');
const headerCartTotal = document.getElementById('headerCartTotal');
const drawerTotalAmount = document.getElementById('drawerTotalAmount');
const checkoutBtn = document.getElementById('checkoutBtn');

// Product Detail Modal DOM
const productDetailModal = document.getElementById('productDetailModal');
const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
const detailModalBody = document.getElementById('detailModalBody');

// Checkout Modal DOM
const checkoutModal = document.getElementById('checkoutModal');
const closeCheckoutBtn = document.getElementById('closeCheckoutBtn');
const cancelCheckoutBtn = document.getElementById('cancelCheckoutBtn');
const checkoutForm = document.getElementById('checkoutForm');
const summaryCount = document.getElementById('summaryCount');
const summaryTotal = document.getElementById('summaryTotal');

// VietQR Realtime Modal DOM
const qrModal = document.getElementById('qrModal');
const qrStageConnecting = document.getElementById('qrStageConnecting');
const qrStageReady = document.getElementById('qrStageReady');
const qrStageSuccess = document.getElementById('qrStageSuccess');
const closeQrModalBtn = document.getElementById('closeQrModalBtn');
const simulatePaidBtn = document.getElementById('simulatePaidBtn');
const finishOrderBtn = document.getElementById('finishOrderBtn');

// --- Helper Functions ---
function formatPrice(number) {
  return (number || 0).toLocaleString('vi-VN') + ' đ';
}

function showToast(message) {
  const toast = document.getElementById('toastNotification');
  toast.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${message}`;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2500);
}

function copyText(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const text = el.value !== undefined ? el.value : el.innerText;
  navigator.clipboard.writeText(text).then(() => {
    showToast(`Đã sao chép: <strong>${text}</strong>`);
  }).catch(() => {
    prompt('Sao chép thủ công:', text);
  });
}

// --- API Calls ---
async function fetchCategories() {
  try {
    const res = await fetch('/api/categories');
    const json = await res.json();
    if (json.success && json.data) {
      state.categories = json.data;
      renderCategories();
    }
  } catch (err) {
    console.error('Lỗi tải danh mục:', err);
  }
}

async function fetchProducts(append = false) {
  if (!append) {
    catalogCount.innerText = 'Đang tải từ kho DropBuy...';
  }
  try {
    const params = new URLSearchParams({
      page: state.currentPage,
      limit: state.limit,
      category: state.currentCategory,
      search: state.searchQuery,
      sort: state.sort,
      minPrice: state.minPrice,
      maxPrice: state.maxPrice
    });

    const res = await fetch(`/api/products?${params.toString()}`);
    const json = await res.json();

    if (json.success) {
      if (append) {
        state.products = [...state.products, ...json.data];
      } else {
        state.products = json.data;
      }
      renderProducts();
      renderPagination(json.page, json.totalPages);
      catalogCount.innerText = `Đang hiển thị ${state.products.length} / tổng ${json.total.toLocaleString('vi-VN')} SP`;
      if (heroTotalProd) heroTotalProd.innerText = json.total.toLocaleString('vi-VN') + '+';

      if (btnLoadMore) {
        if (json.page >= json.totalPages) {
          btnLoadMore.style.display = 'none';
        } else {
          btnLoadMore.style.display = 'inline-flex';
          btnLoadMore.innerHTML = `<i class="fa-solid fa-angles-down"></i> Tải Thêm Sản Phẩm Nữa (Xem thêm ${json.total - state.products.length} SP)`;
        }
      }
    }
  } catch (err) {
    console.error('Lỗi tải sản phẩm:', err);
    catalogCount.innerText = 'Lỗi kết nối!';
  }
}

if (btnLoadMore) {
  btnLoadMore.addEventListener('click', () => {
    btnLoadMore.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải thêm sản phẩm từ DropBuy...';
    state.currentPage++;
    fetchProducts(true);
  });
}

// --- Render Categories ---
function renderCategories() {
  let html = `<button class="cat-btn ${state.currentCategory === 'all' ? 'active' : ''}" data-id="all">
    <i class="fa-solid fa-border-all"></i> Tất Cả Sản Phẩm
  </button>`;

  const icons = [
    'fa-mobile-screen', 'fa-plug', 'fa-headphones', 'fa-house-laptop', 'fa-laptop',
    'fa-car', 'fa-gamepad', 'fa-heart-pulse', 'fa-shirt', 'fa-shoe-prints'
  ];

  state.categories.slice(0, 14).forEach((cat, idx) => {
    const icon = icons[idx % icons.length];
    html += `<button class="cat-btn ${state.currentCategory == cat.id ? 'active' : ''}" data-id="${cat.id}">
      <i class="fa-solid ${icon}"></i> ${cat.name}
    </button>`;
  });

  categoriesContainer.innerHTML = html;

  categoriesContainer.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      categoriesContainer.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentCategory = btn.getAttribute('data-id');
      state.currentPage = 1;
      
      const catObj = state.categories.find(c => c.id == state.currentCategory);
      catalogTitle.innerText = catObj ? catObj.name : 'Tất Cả Sản Phẩm';
      fetchProducts();
    });
  });
}

// --- Render Products ---
function renderProducts() {
  if (state.products.length === 0) {
    productGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: #64748b;">
        <i class="fa-solid fa-box-open" style="font-size: 54px; color: #cbd5e1; margin-bottom: 14px;"></i>
        <h3 style="color: #1e293b; margin-bottom: 6px;">Không tìm thấy sản phẩm nào</h3>
        <p>Vui lòng thử tìm kiếm với từ khóa khác hoặc bỏ chọn bộ lọc giá.</p>
      </div>`;
    return;
  }

  productGrid.innerHTML = state.products.map(p => `
    <div class="luxury-card" data-id="${p.id}">
      <div class="card-media">
        <span class="badge-official"><i class="fa-solid fa-circle-check" style="color: #38bdf8;"></i> DropBuy Mall</span>
        <span class="badge-discount">-20% GIÁ SỈ</span>
        <img src="${p.image}" alt="${p.name}" loading="lazy" onerror="this.src='https://dropbuy.vn/d/logo.png'">
        
        <div class="card-quick-overlay">
          <button class="btn-quick-view" onclick="openProductDetail(${p.id})">
            <i class="fa-solid fa-eye"></i> Xem Chi Tiết
          </button>
        </div>
      </div>

      <div class="card-details">
        <div class="card-category">${p.category_name || 'Phụ kiện DropBuy'}</div>
        <h3 class="card-title" title="${p.name}" onclick="openProductDetail(${p.id})">${p.name}</h3>

        <div class="card-meta">
          <span class="stars"><i class="fa-solid fa-star"></i> 5.0</span>
          <span>•</span>
          <span>Đã bán ${80 + (p.id % 200)}+</span>
        </div>

        <div class="card-pricing">
          <span class="price-highlight">${formatPrice(p.price)}</span>
          <span class="price-strike">${formatPrice(p.original_price)}</span>
        </div>

        <div class="card-actions-row">
          <button class="btn-buy-instant" onclick="buyNowInstant(${p.id})">
            <i class="fa-solid fa-bolt"></i> Mua Ngay
          </button>
          <button class="btn-add-mini" title="Thêm vào giỏ" onclick="addToCart(${p.id})">
            <i class="fa-solid fa-cart-plus"></i>
          </button>
        </div>
      </div>
    </div>
  `).join('');
}

// --- Pagination ---
function renderPagination(current, total) {
  if (total <= 1) {
    pagination.innerHTML = '';
    return;
  }

  let html = '';
  if (current > 1) {
    html += `<button class="pag-btn" onclick="changePage(${current - 1})"><i class="fa-solid fa-chevron-left"></i> Trước</button>`;
  }

  const maxBtns = 5;
  let start = Math.max(1, current - 2);
  let end = Math.min(total, start + maxBtns - 1);
  if (end - start < maxBtns - 1) {
    start = Math.max(1, end - maxBtns + 1);
  }

  for (let i = start; i <= end; i++) {
    html += `<button class="pag-btn ${i === current ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
  }

  if (current < total) {
    html += `<button class="pag-btn" onclick="changePage(${current + 1})">Sau <i class="fa-solid fa-chevron-right"></i></button>`;
  }

  pagination.innerHTML = html;
}

function changePage(page) {
  state.currentPage = page;
  fetchProducts();
  window.scrollTo({ top: 380, behavior: 'smooth' });
}

// --- FULL PRODUCT DETAIL MODAL (Gallery + Video + Specs) ---
async function openProductDetail(productId) {
  // Open modal with loading state
  productDetailModal.classList.add('open');
  detailModalBody.innerHTML = `
    <div style="text-align: center; padding: 60px;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 40px; color: var(--primary);"></i>
      <p style="margin-top: 14px; font-weight: 700; color: #475569;">Đang tải toàn bộ thông số kỹ thuật & album ảnh từ DropBuy...</p>
    </div>`;

  try {
    const res = await fetch(`/api/products/${productId}`);
    const json = await res.json();
    if (!json.success || !json.data) {
      detailModalBody.innerHTML = `<p style="text-align: center; color: red;">Không thể tải chi tiết sản phẩm.</p>`;
      return;
    }

    const prod = json.data;
    state.activeDetailProduct = prod;
    state.selectedGalleryIndex = 0;
    renderDetailModal(prod);

  } catch (err) {
    detailModalBody.innerHTML = `<p style="text-align: center; color: red;">Lỗi kết nối máy chủ.</p>`;
  }
}

function renderDetailModal(prod) {
  const gallery = prod.gallery && prod.gallery.length > 0 ? prod.gallery : [{ url: prod.image, thumb: prod.image }];
  const activeMedia = gallery[state.selectedGalleryIndex] || gallery[0];

  detailModalBody.innerHTML = `
    <div class="product-detail-grid">
      <!-- Left: Interactive Gallery -->
      <div class="detail-gallery">
        <div class="main-preview-box" id="mainMediaBox">
          ${activeMedia.is_video ? `
            <video src="${activeMedia.url}" controls autoplay muted loop playsinline></video>
          ` : `
            <img src="${activeMedia.url}" alt="${prod.name}" id="mainPreviewImg">
          `}
        </div>

        <div class="thumbs-strip">
          ${gallery.map((item, idx) => `
            <div class="thumb-item ${idx === state.selectedGalleryIndex ? 'active' : ''}" onclick="switchDetailMedia(${idx})">
              <img src="${item.thumb || item.url}" alt="Thumb ${idx + 1}">
              ${item.is_video ? `<div class="thumb-video-badge"><i class="fa-solid fa-play"></i></div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Right: Detailed Information -->
      <div class="detail-info">
        <div class="detail-brand-badge">
          <i class="fa-solid fa-certificate"></i> Phân Phối Chính Hãng Từ Kho DropBuy.vn
        </div>
        <h2 class="detail-title">${prod.name}</h2>

        <div class="detail-meta-row">
          <span class="stars"><i class="fa-solid fa-star"></i> 5.0 (100% Đánh giá 5 sao)</span>
          <span>•</span>
          <span>Mã SKU: <strong>${prod.sku}</strong></span>
          <span>•</span>
          <span class="stock-status-pill"><i class="fa-solid fa-check"></i> Sẵn sàng xuất kho</span>
        </div>

        <div class="detail-pricing-box">
          <span class="detail-price-main">${formatPrice(prod.price)}</span>
          <span class="detail-price-sub">${formatPrice(prod.original_price)}</span>
          <span class="saving-tag">Tiết kiệm 20%</span>
        </div>

        <div class="detail-features-list">
          <div><i class="fa-solid fa-circle-check"></i> Cam kết 100% hàng thật – Hoàn tiền 200% nếu phát hiện giả</div>
          <div><i class="fa-solid fa-shield-check"></i> Bảo hành: ${prod.warranty || '6 tháng chính hãng'}</div>
          <div><i class="fa-solid fa-truck-fast"></i> Miễn phí đóng gói bọc xốp chống sốc theo chuẩn DropBuy</div>
        </div>

        <div class="detail-qty-row">
          <span style="font-weight: 700; color: #334155;">Số lượng mua:</span>
          <div class="qty-stepper">
            <button onclick="changeModalQty(-1)">-</button>
            <span id="modalQtyDisplay">1</span>
            <button onclick="changeModalQty(1)">+</button>
          </div>
        </div>

        <div class="detail-actions-row">
          <button class="btn-order-now-large" onclick="buyFromModalNow()">
            <i class="fa-solid fa-bolt"></i> Đặt Hàng & Nhận VietQR Ngay
          </button>
          <button class="btn-add-cart-large" onclick="addFromModalToCart()">
            <i class="fa-solid fa-cart-plus"></i> Thêm Vào Giỏ
          </button>
        </div>
      </div>
    </div>

    <!-- Description & Specs Tabs -->
    <div class="detail-tabs-section">
      <div class="detail-tabs-header">
        <button class="tab-btn active" id="tabDescBtn">Mô Tả Sản Phẩm & Thông Số Kỹ Thuật</button>
      </div>
      <div class="detail-desc-body">
        ${prod.description || 'Chưa có thông số chi tiết.'}
      </div>
    </div>
  `;
}

function switchDetailMedia(index) {
  state.selectedGalleryIndex = index;
  renderDetailModal(state.activeDetailProduct);
}

let modalQty = 1;
function changeModalQty(delta) {
  modalQty = Math.max(1, modalQty + delta);
  const el = document.getElementById('modalQtyDisplay');
  if (el) el.innerText = modalQty;
}

function addFromModalToCart() {
  if (!state.activeDetailProduct) return;
  const p = state.activeDetailProduct;
  for (let i = 0; i < modalQty; i++) {
    addToCart(p.id, false);
  }
  showToast(`Đã thêm <strong>${modalQty}</strong> sản phẩm vào giỏ hàng!`);
  productDetailModal.classList.remove('open');
  modalQty = 1;
  openCartDrawer();
}

function buyFromModalNow() {
  if (!state.activeDetailProduct) return;
  const p = state.activeDetailProduct;
  state.cart = [{
    id: p.id,
    name: p.name,
    price: p.price,
    image: p.gallery && p.gallery.length > 0 ? p.gallery[0].thumb || p.gallery[0].url : p.image,
    dropbuy_url: p.dropbuy_url,
    quantity: modalQty
  }];
  updateCartUI();
  productDetailModal.classList.remove('open');
  modalQty = 1;
  openCheckoutModal();
}

closeDetailModalBtn.addEventListener('click', () => {
  productDetailModal.classList.remove('open');
});

// --- Instant Buy from Product Card ---
function buyNowInstant(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!product) return;
  state.cart = [{
    id: product.id,
    name: product.name,
    price: product.price,
    image: product.image,
    dropbuy_url: product.dropbuy_url,
    quantity: 1
  }];
  updateCartUI();
  openCheckoutModal();
}

// --- Cart Operations ---
function addToCart(productId, notify = true) {
  const product = state.products.find(p => p.id === productId);
  if (!product) return;

  const existing = state.cart.find(item => item.id === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    state.cart.push({
      id: product.id,
      name: product.name,
      price: product.price,
      image: product.image,
      dropbuy_url: product.dropbuy_url,
      quantity: 1
    });
  }

  updateCartUI();
  if (notify) {
    showToast(`Đã thêm <strong>${product.name.slice(0, 30)}...</strong> vào giỏ!`);
    openCartDrawer();
  }
}

function updateCartQty(productId, delta) {
  const item = state.cart.find(i => i.id === productId);
  if (!item) return;

  item.quantity += delta;
  if (item.quantity <= 0) {
    state.cart = state.cart.filter(i => i.id !== productId);
  }

  updateCartUI();
}

function updateCartUI() {
  const totalCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  const totalAmount = state.cart.reduce((sum, item) => sum + item.quantity * item.price, 0);

  cartCount.innerText = totalCount;
  drawerCount.innerText = totalCount;
  headerCartTotal.innerText = formatPrice(totalAmount);
  drawerTotalAmount.innerText = formatPrice(totalAmount);
  checkoutBtn.disabled = state.cart.length === 0;

  if (state.cart.length === 0) {
    cartItemsContainer.innerHTML = `
      <div style="text-align: center; padding: 60px 20px; color: #94a3b8;">
        <i class="fa-solid fa-basket-shopping" style="font-size: 48px; color: #e2e8f0; margin-bottom: 12px;"></i>
        <h4 style="color: #334155; margin-bottom: 4px;">Giỏ hàng của bạn đang trống</h4>
        <p style="font-size: 13px;">Hãy khám phá các sản phẩm giá sỉ từ DropBuy nhé!</p>
      </div>`;
    return;
  }

  cartItemsContainer.innerHTML = state.cart.map(item => `
    <div class="cart-drawer-item">
      <img src="${item.image}" alt="${item.name}">
      <div class="cart-drawer-item-info">
        <div class="drawer-item-title">${item.name}</div>
        <div class="drawer-item-price">${formatPrice(item.price)}</div>
        <div class="qty-stepper" style="display: inline-flex; height: 30px;">
          <button style="width: 28px; height: 28px;" onclick="updateCartQty(${item.id}, -1)">-</button>
          <span style="width: 32px; font-size: 13px;">${item.quantity}</span>
          <button style="width: 28px; height: 28px;" onclick="updateCartQty(${item.id}, 1)">+</button>
        </div>
      </div>
    </div>
  `).join('');
}

function openCartDrawer() {
  cartDrawer.classList.add('open');
  cartBackdrop.style.display = 'block';
}

function closeCartDrawer() {
  cartDrawer.classList.remove('open');
  cartBackdrop.style.display = 'none';
}

// --- Checkout Modal Flow ---
function openCheckoutModal() {
  closeCartDrawer();
  const totalCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  const totalAmount = state.cart.reduce((sum, item) => sum + item.quantity * item.price, 0);

  summaryCount.innerText = totalCount + ' sản phẩm';
  summaryTotal.innerText = formatPrice(totalAmount);

  checkoutModal.classList.add('open');
}

closeCheckoutBtn.addEventListener('click', () => checkoutModal.classList.remove('open'));
cancelCheckoutBtn.addEventListener('click', () => checkoutModal.classList.remove('open'));

checkoutForm.addEventListener('submit', async e => {
  e.preventDefault();

  const customer = {
    name: document.getElementById('custName').value.trim(),
    phone: document.getElementById('custPhone').value.trim(),
    address: document.getElementById('custAddress').value.trim(),
    note: document.getElementById('custNote').value.trim()
  };

  const totalAmount = state.cart.reduce((sum, item) => sum + item.quantity * item.price, 0);

  checkoutModal.classList.remove('open');
  openRealtimeQrModal();

  try {
    const res = await fetch('/api/orders/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer,
        items: state.cart,
        total_amount: totalAmount
      })
    });

    const json = await res.json();
    if (!json.success) {
      alert('Lỗi tạo đơn: ' + json.error);
      closeRealtimeQrModal();
      return;
    }

    state.activeOrder = json.orderId;
    console.log(`[Socket] Đã tạo đơn #${json.orderId}, lắng nghe phòng WebSocket...`);
    socket.emit('join-order', json.orderId);

  } catch (err) {
    alert('Không thể kết nối máy chủ: ' + err.message);
    closeRealtimeQrModal();
  }
});

// --- VietQR Realtime Modal ---
function openRealtimeQrModal() {
  qrStageConnecting.classList.remove('hidden');
  qrStageReady.classList.add('hidden');
  qrStageSuccess.classList.add('hidden');
  qrModal.classList.add('open');
}

function closeRealtimeQrModal() {
  qrModal.classList.remove('open');
  if (state.countdownInterval) clearInterval(state.countdownInterval);
}

closeQrModalBtn.addEventListener('click', closeRealtimeQrModal);

function startCountdown(durationSeconds = 900) {
  if (state.countdownInterval) clearInterval(state.countdownInterval);
  let remaining = durationSeconds;
  const timerEl = document.getElementById('countdownTimer');

  state.countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(state.countdownInterval);
      timerEl.innerText = 'Đã hết hạn!';
      return;
    }
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    timerEl.innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }, 1000);
}

// --- Socket.IO Listeners ---
socket.on('ORDER_STATUS_UPDATE', data => {
  const statusEl = document.getElementById('connectingStatusText');
  if (statusEl) statusEl.innerText = data.message;
});

socket.on('ORDER_QR_READY', data => {
  qrStageConnecting.classList.add('hidden');
  qrStageReady.classList.remove('hidden');

  document.getElementById('qrHmCode').innerText = data.orderId;
  document.getElementById('qrDbCode').innerText = data.dropbuyOrderId || 'DB-PENDING';

  const qr = data.qr;
  document.getElementById('qrImage').src = qr.qr_image_url;
  document.getElementById('qrBankName').innerText = qr.bank_name || 'MBBank';
  document.getElementById('qrAccountNo').innerText = qr.account_number;
  document.getElementById('qrAccountName').innerText = qr.account_name;
  document.getElementById('qrAmount').innerText = formatPrice(qr.amount);
  document.getElementById('qrRawAmount').value = qr.amount;
  document.getElementById('qrMemo').innerText = qr.transfer_content;

  startCountdown(qr.expires_in_seconds || 900);
});

socket.on('PAYMENT_CONFIRMED', data => {
  qrStageReady.classList.add('hidden');
  qrStageSuccess.classList.remove('hidden');

  document.getElementById('successOrderId').innerText = data.orderId;
  document.getElementById('successDropbuyId').innerText = 'DB-CONFIRMED-' + data.orderId;
  document.getElementById('successDesc').innerText = data.message;

  state.cart = [];
  updateCartUI();
});

socket.on('REALTIME_CATALOG_SYNC', data => {
  console.log('[Realtime] Nhận tín hiệu đồng bộ kho DropBuy:', data);
  showToast(data.message || '⚡ Kho DropBuy vừa cập nhật dữ liệu realtime!');
  fetchProducts();
});

simulatePaidBtn.addEventListener('click', async () => {
  if (!state.activeOrder) return;
  simulatePaidBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xác thực...';
  simulatePaidBtn.disabled = true;

  try {
    const res = await fetch(`/api/orders/${state.activeOrder}/confirm-payment`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) {
      alert('Lỗi: ' + json.error);
      simulatePaidBtn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Tôi Đã Chuyển Khoản Thành Công';
      simulatePaidBtn.disabled = false;
    }
  } catch (e) {
    alert('Lỗi: ' + e.message);
    simulatePaidBtn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Tôi Đã Chuyển Khoản Thành Công';
    simulatePaidBtn.disabled = false;
  }
});

finishOrderBtn.addEventListener('click', () => {
  closeRealtimeQrModal();
  state.activeOrder = null;
});

// --- Search Autocomplete Logic ---
let searchDebounceTimer = null;
searchInput.addEventListener('input', e => {
  const q = e.target.value.trim();
  searchClearBtn.classList.toggle('hidden', q.length === 0);

  clearTimeout(searchDebounceTimer);
  if (q.length < 2) {
    searchDropdown.classList.add('hidden');
    return;
  }

  searchDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/products?search=${encodeURIComponent(q)}&limit=6`);
      const json = await res.json();
      if (json.success && json.data.length > 0) {
        searchDropdown.innerHTML = json.data.map(item => `
          <div class="search-item-preview" onclick="openProductDetail(${item.id})">
            <img src="${item.image}" alt="${item.name}">
            <div class="search-item-info">
              <div class="search-item-title">${item.name}</div>
              <div class="search-item-price">${formatPrice(item.price)}</div>
            </div>
          </div>
        `).join('');
        searchDropdown.classList.remove('hidden');
      } else {
        searchDropdown.innerHTML = `<div style="padding: 14px; text-align: center; color: #94a3b8; font-size: 13px;">Không tìm thấy sản phẩm nào</div>`;
        searchDropdown.classList.remove('hidden');
      }
    } catch (e) {}
  }, 250);
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchClearBtn.classList.add('hidden');
  searchDropdown.classList.add('hidden');
  state.searchQuery = '';
  state.currentPage = 1;
  fetchProducts();
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrapper')) {
    searchDropdown.classList.add('hidden');
  }
});

searchBtn.addEventListener('click', () => {
  searchDropdown.classList.add('hidden');
  state.searchQuery = searchInput.value.trim();
  state.currentPage = 1;
  fetchProducts();
});

searchInput.addEventListener('keyup', e => {
  if (e.key === 'Enter') {
    searchDropdown.classList.add('hidden');
    state.searchQuery = searchInput.value.trim();
    state.currentPage = 1;
    fetchProducts();
  }
});

// --- Filter & Sorting Handlers ---
sortSelect.addEventListener('change', () => {
  state.sort = sortSelect.value;
  state.currentPage = 1;
  fetchProducts();
});

pricePills.forEach(pill => {
  pill.addEventListener('click', () => {
    pricePills.forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    state.minPrice = pill.getAttribute('data-min') || '';
    state.maxPrice = pill.getAttribute('data-max') || '';
    state.currentPage = 1;
    fetchProducts();
  });
});

// Cart Drawer Handlers
openCartBtn.addEventListener('click', openCartDrawer);
closeCartBtn.addEventListener('click', closeCartDrawer);
cartBackdrop.addEventListener('click', closeCartDrawer);
checkoutBtn.addEventListener('click', openCheckoutModal);

// Init
fetchCategories();
fetchProducts();
