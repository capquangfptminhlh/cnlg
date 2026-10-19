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

// Mọi sản phẩm đã tải (lưới, tìm kiếm, chi tiết) – để thêm giỏ được cả khi SP không nằm trong trang hiện tại
const productCache = new Map();
const CART_KEY = 'hm_cart_v1';

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
const reportPaidBtn = document.getElementById('simulatePaidBtn');
const finishOrderBtn = document.getElementById('finishOrderBtn');

// --- Helper Functions ---
function formatPrice(number) {
  return (number || 0).toLocaleString('vi-VN') + ' đ';
}

/** Dữ liệu sản phẩm lấy từ DropBuy → luôn escape trước khi chèn vào HTML */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
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
    showToast(`Đã sao chép: <strong>${esc(text)}</strong>`);
  }).catch(() => {
    prompt('Sao chép thủ công:', text);
  });
}

function rememberProducts(list) {
  for (const p of list || []) productCache.set(p.id, { ...(productCache.get(p.id) || {}), ...p });
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
      rememberProducts(json.data);
      state.products = append ? [...state.products, ...json.data] : json.data;
      renderProducts();
      renderPagination(json.page, json.totalPages);
      catalogCount.innerText = `Đang hiển thị ${state.products.length} / tổng ${json.total.toLocaleString('vi-VN')} SP`;
      if (heroTotalProd && state.currentCategory === 'all' && !state.searchQuery && !state.minPrice && !state.maxPrice) {
        heroTotalProd.innerText = json.total.toLocaleString('vi-VN');
      }

      if (btnLoadMore) {
        if (json.page >= json.totalPages) {
          btnLoadMore.style.display = 'none';
        } else {
          btnLoadMore.style.display = 'inline-flex';
          btnLoadMore.innerHTML = `<i class="fa-solid fa-angles-down"></i> Tải Thêm Sản Phẩm (còn ${json.total - state.products.length} SP)`;
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
    btnLoadMore.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải thêm sản phẩm...';
    state.currentPage++;
    fetchProducts(true);
  });
}

// --- Render Categories ---
// Icon theo tên danh mục (trước đây gán theo thứ tự nên "Máy tính bảng" ra icon ô tô, "Đồng hồ" ra tay cầm game)
const CATEGORY_ICONS = [
  [/điện thoại/i, 'fa-mobile-screen'], [/gia dụng|điện máy/i, 'fa-plug'], [/âm thanh|loa|tai nghe/i, 'fa-headphones'],
  [/nhà cửa|đời sống/i, 'fa-house'], [/ô tô|xe máy|xe đạp/i, 'fa-car'], [/máy tính|laptop/i, 'fa-laptop'],
  [/thời trang|quần áo/i, 'fa-shirt'], [/camping|phượt|cắm trại/i, 'fa-campground'], [/người lớn|phòng the/i, 'fa-heart'],
  [/dịch vụ|phần mềm/i, 'fa-cloud'], [/văn phòng/i, 'fa-pen-ruler'], [/mẹ và bé|mẹ & bé/i, 'fa-baby'],
  [/phong thuỷ|phong thủy|tâm linh/i, 'fa-yin-yang'], [/mạng/i, 'fa-wifi'], [/đồng hồ/i, 'fa-clock'],
  [/sức khỏe|sức khoẻ|làm đẹp/i, 'fa-heart-pulse'], [/đồ chơi/i, 'fa-puzzle-piece'], [/thú cưng/i, 'fa-paw']
];
function categoryIcon(name) {
  const hit = CATEGORY_ICONS.find(([re]) => re.test(name));
  return hit ? hit[1] : 'fa-tag';
}

function renderCategories() {
  let html = `<button class="cat-btn ${state.currentCategory === 'all' ? 'active' : ''}" data-id="all">
    <i class="fa-solid fa-border-all"></i> Tất Cả Sản Phẩm
  </button>`;

  // Chỉ hiện danh mục gốc còn sản phẩm (lọc danh mục cha đã bao gồm danh mục con ở server)
  const roots = state.categories
    .filter(c => !c.parent_id && (c.product_count ?? 1) > 0)
    .sort((a, b) => (b.product_count || 0) - (a.product_count || 0));

  roots.forEach(cat => {
    html += `<button class="cat-btn ${state.currentCategory == cat.id ? 'active' : ''}" data-id="${cat.id}" title="${esc(cat.name)} (${cat.product_count || 0} SP)">
      <i class="fa-solid ${categoryIcon(cat.name)}"></i> ${esc(cat.name)}
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
function productBadges(p) {
  let html = '';
  if (p.is_mall) html += `<span class="badge-official"><i class="fa-solid fa-circle-check" style="color: #38bdf8;"></i> DropBuy Mall</span>`;
  if (p.in_stock === false) html += `<span class="badge-discount">HẾT HÀNG</span>`;
  else if (p.discount_percent > 0) html += `<span class="badge-discount">-${p.discount_percent}%</span>`;
  return html;
}

function renderProducts() {
  if (state.products.length === 0) {
    productGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: #64748b;">
        <i class="fa-solid fa-box-open" style="font-size: 54px; color: #cbd5e1; margin-bottom: 14px;"></i>
        <h3 style="color: #e2e8f0; margin-bottom: 6px;">Không tìm thấy sản phẩm nào</h3>
        <p>Vui lòng thử tìm kiếm với từ khóa khác hoặc bỏ chọn bộ lọc giá.</p>
      </div>`;
    return;
  }

  productGrid.innerHTML = state.products.map(p => {
    const soldOut = p.in_stock === false;
    return `
    <div class="luxury-card${soldOut ? ' is-sold-out' : ''}" data-id="${p.id}">
      <div class="card-media">
        ${productBadges(p)}
        <img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" onerror="this.src='https://dropbuy.vn/d/logo.png'">

        <div class="card-quick-overlay">
          <button class="btn-quick-view" onclick="openProductDetail(${p.id})">
            <i class="fa-solid fa-eye"></i> Xem Chi Tiết
          </button>
        </div>
      </div>

      <div class="card-details">
        <div class="card-category">${esc(p.category_name || 'DropBuy')}</div>
        <h3 class="card-title" title="${esc(p.name)}" onclick="openProductDetail(${p.id})">${esc(p.name)}</h3>

        <div class="card-meta">
          <span><i class="fa-solid fa-shield-halved"></i> ${esc(p.warranty || 'Bảo hành chính hãng')}</span>
        </div>

        <div class="card-pricing">
          <span class="price-highlight">${formatPrice(p.price)}</span>
          ${p.original_price ? `<span class="price-strike">${formatPrice(p.original_price)}</span>` : ''}
        </div>

        <div class="card-actions-row">
          <button class="btn-buy-instant" onclick="buyNowInstant(${p.id})" ${soldOut ? 'disabled' : ''}>
            <i class="fa-solid fa-bolt"></i> ${soldOut ? 'Hết Hàng' : 'Mua Ngay'}
          </button>
          <button class="btn-add-mini" title="Thêm vào giỏ" onclick="addToCart(${p.id})" ${soldOut ? 'disabled' : ''}>
            <i class="fa-solid fa-cart-plus"></i>
          </button>
        </div>
      </div>
    </div>`;
  }).join('');
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
  searchDropdown.classList.add('hidden');
  productDetailModal.classList.add('open');
  modalQty = 1;
  detailModalBody.innerHTML = `
    <div style="text-align: center; padding: 60px;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 40px; color: var(--gold);"></i>
      <p style="margin-top: 14px; font-weight: 700; color: #94a3b8;">Đang tải thông số kỹ thuật & album ảnh...</p>
    </div>`;

  try {
    const res = await fetch(`/api/products/${productId}`);
    const json = await res.json();
    if (!json.success || !json.data) {
      detailModalBody.innerHTML = `<p style="text-align: center; color: #ef4444;">Không thể tải chi tiết sản phẩm.</p>`;
      return;
    }

    const prod = json.data;
    rememberProducts([prod]);
    state.activeDetailProduct = prod;
    state.selectedGalleryIndex = 0;
    renderDetailModal(prod);
  } catch (err) {
    detailModalBody.innerHTML = `<p style="text-align: center; color: #ef4444;">Lỗi kết nối máy chủ.</p>`;
  }
}

function renderDetailModal(prod) {
  const gallery = prod.gallery && prod.gallery.length > 0 ? prod.gallery : [{ url: prod.image_hd || prod.image, thumb: prod.image }];
  const activeMedia = gallery[state.selectedGalleryIndex] || gallery[0];
  const soldOut = prod.in_stock === false;

  detailModalBody.innerHTML = `
    <div class="product-detail-grid">
      <!-- Left: Interactive Gallery -->
      <div class="detail-gallery">
        <div class="main-preview-box" id="mainMediaBox">
          ${activeMedia.is_video ? `
            <video src="${esc(activeMedia.url)}" controls autoplay muted loop playsinline></video>
          ` : `
            <img src="${esc(activeMedia.url)}" alt="${esc(prod.name)}" id="mainPreviewImg">
          `}
        </div>

        <div class="thumbs-strip">
          ${gallery.map((item, idx) => `
            <div class="thumb-item ${idx === state.selectedGalleryIndex ? 'active' : ''}" onclick="switchDetailMedia(${idx})">
              <img src="${esc(item.thumb || item.url)}" alt="Ảnh ${idx + 1}">
              ${item.is_video ? `<div class="thumb-video-badge"><i class="fa-solid fa-play"></i></div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Right: Detailed Information -->
      <div class="detail-info">
        <div class="detail-brand-badge">
          <i class="fa-solid fa-certificate"></i> Phân phối từ kho DropBuy.vn${prod.is_mall ? ' · DropBuy Mall' : ''}
        </div>
        <h2 class="detail-title">${esc(prod.name)}</h2>

        <div class="detail-meta-row">
          <span>Mã SKU: <strong>${esc(prod.sku)}</strong></span>
          <span>•</span>
          ${soldOut
            ? `<span class="stock-status-pill" style="background: rgba(239,68,68,.15); color: #ef4444;"><i class="fa-solid fa-xmark"></i> Tạm hết hàng</span>`
            : `<span class="stock-status-pill"><i class="fa-solid fa-check"></i> Còn hàng</span>`}
        </div>

        <div class="detail-pricing-box">
          <span class="detail-price-main">${formatPrice(prod.price)}</span>
          ${prod.original_price ? `<span class="detail-price-sub">${formatPrice(prod.original_price)}</span>` : ''}
          ${prod.discount_percent > 0 ? `<span class="saving-tag">Tiết kiệm ${prod.discount_percent}%</span>` : ''}
        </div>

        <div class="detail-features-list">
          <div><i class="fa-solid fa-shield-halved"></i> Bảo hành: ${esc(prod.warranty || 'Bảo hành chính hãng')}</div>
          <div><i class="fa-solid fa-truck-fast"></i> Giao hàng toàn quốc, được đồng kiểm khi nhận</div>
          <div><i class="fa-solid fa-qrcode"></i> Thanh toán chuyển khoản VietQR</div>
        </div>

        <div class="detail-qty-row">
          <span style="font-weight: 700; color: #cbd5e1;">Số lượng mua:</span>
          <div class="qty-stepper">
            <button onclick="changeModalQty(-1)">-</button>
            <span id="modalQtyDisplay">${modalQty}</span>
            <button onclick="changeModalQty(1)">+</button>
          </div>
        </div>

        <div class="detail-actions-row">
          <button class="btn-order-now-large" onclick="buyFromModalNow()" ${soldOut ? 'disabled' : ''}>
            <i class="fa-solid fa-bolt"></i> ${soldOut ? 'Tạm Hết Hàng' : 'Đặt Hàng & Nhận VietQR Ngay'}
          </button>
          <button class="btn-add-cart-large" onclick="addFromModalToCart()" ${soldOut ? 'disabled' : ''}>
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
  modalQty = Math.min(50, Math.max(1, modalQty + delta));
  const el = document.getElementById('modalQtyDisplay');
  if (el) el.innerText = modalQty;
}

function addFromModalToCart() {
  const p = state.activeDetailProduct;
  if (!p || p.in_stock === false) return;
  addToCart(p.id, false, modalQty);
  showToast(`Đã thêm <strong>${modalQty}</strong> sản phẩm vào giỏ hàng!`);
  productDetailModal.classList.remove('open');
  modalQty = 1;
  openCartDrawer();
}

function buyFromModalNow() {
  const p = state.activeDetailProduct;
  if (!p || p.in_stock === false) return;
  state.cart = [cartLine(p, modalQty)];
  updateCartUI();
  productDetailModal.classList.remove('open');
  modalQty = 1;
  openCheckoutModal();
}

closeDetailModalBtn.addEventListener('click', () => {
  productDetailModal.classList.remove('open');
});

// --- Cart Operations ---
function cartLine(p, quantity) {
  return { id: p.id, name: p.name, price: p.price, image: p.image, quantity };
}

function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch (e) {}
}

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    state.cart = Array.isArray(raw) ? raw.filter(i => i && Number.isInteger(i.id) && i.quantity > 0) : [];
  } catch (e) {
    state.cart = [];
  }
}

/** Cập nhật giá/tồn kho trong giỏ theo dữ liệu hiện tại của cửa hàng (giá có thể đổi sau mỗi lần đồng bộ). */
async function refreshCartPrices() {
  if (state.cart.length === 0) return;
  const removed = [];
  await Promise.all(state.cart.map(async item => {
    try {
      const res = await fetch(`/api/products/${item.id}`);
      if (res.status === 404) { item.quantity = 0; removed.push(item.name); return; }
      const json = await res.json();
      if (!json.success) return;
      rememberProducts([json.data]);
      item.price = json.data.price;
      item.name = json.data.name;
      if (json.data.in_stock === false) { item.quantity = 0; removed.push(item.name); }
    } catch (e) {}
  }));
  state.cart = state.cart.filter(i => i.quantity > 0);
  updateCartUI();
  if (removed.length) showToast(`Đã bỏ khỏi giỏ sản phẩm hết hàng: ${esc(removed.join(', ').slice(0, 80))}`);
}

function buyNowInstant(productId) {
  const product = productCache.get(productId);
  if (!product || product.in_stock === false) return;
  state.cart = [cartLine(product, 1)];
  updateCartUI();
  openCheckoutModal();
}

function addToCart(productId, notify = true, qty = 1) {
  const product = productCache.get(productId);
  if (!product || product.in_stock === false) return;

  const existing = state.cart.find(item => item.id === productId);
  if (existing) {
    existing.quantity = Math.min(50, existing.quantity + qty);
    existing.price = product.price;
  } else {
    state.cart.push(cartLine(product, qty));
  }

  updateCartUI();
  if (notify) {
    showToast(`Đã thêm <strong>${esc(product.name.slice(0, 30))}...</strong> vào giỏ!`);
    openCartDrawer();
  }
}

function updateCartQty(productId, delta) {
  const item = state.cart.find(i => i.id === productId);
  if (!item) return;

  item.quantity = Math.min(50, item.quantity + delta);
  if (item.quantity <= 0) {
    state.cart = state.cart.filter(i => i.id !== productId);
  }

  updateCartUI();
}

function updateCartUI() {
  const totalCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  const totalAmount = state.cart.reduce((sum, item) => sum + item.quantity * item.price, 0);
  saveCart();

  cartCount.innerText = totalCount;
  drawerCount.innerText = totalCount;
  headerCartTotal.innerText = formatPrice(totalAmount);
  drawerTotalAmount.innerText = formatPrice(totalAmount);
  checkoutBtn.disabled = state.cart.length === 0;

  if (state.cart.length === 0) {
    cartItemsContainer.innerHTML = `
      <div style="text-align: center; padding: 60px 20px; color: #94a3b8;">
        <i class="fa-solid fa-basket-shopping" style="font-size: 48px; color: #475569; margin-bottom: 12px;"></i>
        <h4 style="color: #e2e8f0; margin-bottom: 4px;">Giỏ hàng của bạn đang trống</h4>
        <p style="font-size: 13px;">Hãy khám phá các sản phẩm từ kho DropBuy nhé!</p>
      </div>`;
    return;
  }

  cartItemsContainer.innerHTML = state.cart.map(item => `
    <div class="cart-drawer-item">
      <img src="${esc(item.image)}" alt="${esc(item.name)}">
      <div class="cart-drawer-item-info">
        <div class="drawer-item-title">${esc(item.name)}</div>
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
  const submitBtn = checkoutForm.querySelector('[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    // Chỉ gửi mã SP + số lượng – giá do server tính
    const res = await fetch('/api/orders/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer, items: state.cart.map(i => ({ id: i.id, quantity: i.quantity })) })
    });
    const json = await res.json();
    if (!json.success) {
      alert('Không tạo được đơn: ' + json.error);
      if (/hết hàng|không còn/.test(json.error || '')) refreshCartPrices();
      return;
    }

    checkoutModal.classList.remove('open');
    openRealtimeQrModal();
    state.activeOrder = json.orderId;
    socket.emit('join-order', json.orderId);
    // Đề phòng QR được tạo trước khi socket kịp vào phòng: hỏi lại trạng thái đơn
    setTimeout(() => pollOrderOnce(json.orderId), 2500);
  } catch (err) {
    alert('Không thể kết nối máy chủ: ' + err.message);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

async function pollOrderOnce(orderId) {
  if (state.activeOrder !== orderId || !qrStageConnecting || qrStageConnecting.classList.contains('hidden')) return;
  try {
    const json = await (await fetch(`/api/orders/${orderId}`)).json();
    if (json.success && json.data.payment) showQr({ orderId, qr: json.data.payment });
    else setTimeout(() => pollOrderOnce(orderId), 2000);
  } catch (e) {}
}

// --- VietQR Realtime Modal ---
function openRealtimeQrModal() {
  qrStageConnecting.classList.remove('hidden');
  qrStageReady.classList.add('hidden');
  qrStageSuccess.classList.add('hidden');
  reportPaidBtn.disabled = false;
  reportPaidBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Tôi Đã Chuyển Khoản';
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

function showQr(data) {
  if (!data.qr || data.orderId !== state.activeOrder) return;
  qrStageConnecting.classList.add('hidden');
  qrStageReady.classList.remove('hidden');

  document.getElementById('qrHmCode').innerText = data.orderId;
  document.getElementById('qrDbCode').innerText = data.dropbuyOrderId || '—';

  const qr = data.qr;
  document.getElementById('qrImage').src = qr.qr_image_url;
  document.getElementById('qrBankName').innerText = qr.bank_name || '';
  document.getElementById('qrAccountNo').innerText = qr.account_number || '';
  document.getElementById('qrAccountName').innerText = qr.account_name || '';
  document.getElementById('qrAmount').innerText = formatPrice(qr.amount);
  document.getElementById('qrRawAmount').value = qr.amount;
  document.getElementById('qrMemo').innerText = qr.transfer_content;

  startCountdown(qr.expires_in_seconds || 900);
}

// --- Socket.IO Listeners ---
socket.on('ORDER_STATUS_UPDATE', data => {
  const statusEl = document.getElementById('connectingStatusText');
  if (statusEl && data.message) statusEl.innerText = data.message;
});

socket.on('ORDER_QR_READY', showQr);

socket.on('PAYMENT_CONFIRMED', data => {
  if (data.orderId !== state.activeOrder) return;
  qrStageReady.classList.add('hidden');
  qrStageSuccess.classList.remove('hidden');
  if (state.countdownInterval) clearInterval(state.countdownInterval);

  document.getElementById('successOrderId').innerText = data.orderId;
  document.getElementById('successDesc').innerText = data.message;

  state.cart = [];
  updateCartUI();
});

socket.on('REALTIME_CATALOG_SYNC', data => {
  showToast(esc(data.message || 'Kho DropBuy vừa cập nhật dữ liệu!'));
  fetchProducts();
  refreshCartPrices();
});

// Khách chỉ BÁO đã chuyển khoản; cửa hàng đối soát rồi mới xác nhận (trước đây nút này tự đánh dấu "đã thanh toán")
reportPaidBtn.addEventListener('click', async () => {
  if (!state.activeOrder) return;
  reportPaidBtn.disabled = true;
  reportPaidBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang gửi...';

  try {
    const res = await fetch(`/api/orders/${state.activeOrder}/report-paid`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    reportPaidBtn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> Đang chờ cửa hàng xác nhận';
    const alertText = document.getElementById('qrAlertText');
    if (alertText) alertText.innerHTML = `Đã ghi nhận thông báo chuyển khoản cho đơn <strong>${esc(state.activeOrder)}</strong>. Màn hình sẽ tự cập nhật khi cửa hàng xác nhận đã nhận tiền – bạn có thể đóng cửa sổ, đơn hàng vẫn được giữ.`;
    state.cart = [];
    updateCartUI();
  } catch (e) {
    alert('Lỗi: ' + e.message);
    reportPaidBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Tôi Đã Chuyển Khoản';
    reportPaidBtn.disabled = false;
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
        rememberProducts(json.data);
        searchDropdown.innerHTML = json.data.map(item => `
          <div class="search-item-preview" onclick="openProductDetail(${item.id})">
            <img src="${esc(item.image)}" alt="${esc(item.name)}">
            <div class="search-item-info">
              <div class="search-item-title">${esc(item.name)}</div>
              <div class="search-item-price">${formatPrice(item.price)}${item.in_stock === false ? ' · Hết hàng' : ''}</div>
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

function runSearch() {
  searchDropdown.classList.add('hidden');
  state.searchQuery = searchInput.value.trim();
  state.currentPage = 1;
  catalogTitle.innerText = state.searchQuery ? `Kết quả cho "${state.searchQuery}"` : 'Tất Cả Sản Phẩm';
  fetchProducts();
}

searchBtn.addEventListener('click', runSearch);
searchInput.addEventListener('keyup', e => {
  if (e.key === 'Enter') runSearch();
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
loadCart();
updateCartUI();
fetchCategories();
fetchProducts();
refreshCartPrices();
