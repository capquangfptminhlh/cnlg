// --- Storefront State ---
const state = {
  products: [],
  categories: [],
  currentCategory: 'all',
  currentBrand: 'all',
  brands: [],
  currentPage: 1,
  limit: 24,
  searchQuery: '',
  sort: 'default',
  minPrice: '',
  maxPrice: '',
  flashSaleOnly: false,
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

function formatCompactVnd(amount) {
  const n = Math.max(0, Math.round(Number(amount) || 0));
  if (n >= 1000000) return (n / 1000000).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + 'TR';
  if (n >= 1000) return Math.round(n / 1000).toLocaleString('vi-VN') + 'K';
  return n.toLocaleString('vi-VN') + 'đ';
}

/** Luôn escape dữ liệu sản phẩm trước khi chèn vào HTML */
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
    uiPrompt('Sao chép thủ công:', { value: text, readOnly: true });
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
  if (append && state.loadingMore) return;
  const reqId = (state.fetchSeq = (state.fetchSeq || 0) + 1);
  if (append) state.loadingMore = true;
  window.dispatchEvent(new Event('storefront:loading'));
  if (!append) {
    catalogCount.innerText = 'Đang tải danh mục sản phẩm...';
  }
  try {
    const params = new URLSearchParams({
      page: state.currentPage,
      limit: state.limit,
      category: state.currentCategory,
      search: state.searchQuery,
      brand: state.currentBrand !== 'all' ? state.currentBrand : '',
      sort: state.sort,
      minPrice: state.minPrice,
      maxPrice: state.maxPrice
    });

    if (state.flashSaleOnly) params.set('flashSale', '1');
    const res = await fetch(`/api/products?${params.toString()}`);
    const json = await res.json();

    if (reqId !== state.fetchSeq) return; // đã đổi danh mục / bộ lọc trong lúc chờ → bỏ kết quả cũ
    if (json.success) {
      rememberProducts(json.data);
      const prevLen = append ? state.products.length : 0;
      state.products = append ? [...state.products, ...json.data] : json.data;
      state.totalProducts = json.total;
      state.totalPages = json.totalPages;
      renderProducts(append ? prevLen : null);
      window.dispatchEvent(new CustomEvent('storefront:products', { detail: { products: state.products } }));
      renderPagination(json.page, json.totalPages);
      catalogCount.innerText = `Đang hiển thị ${state.products.length} / tổng ${json.total.toLocaleString('vi-VN')} SP`;
      if (heroTotalProd && state.currentCategory === 'all' && !state.searchQuery && !state.minPrice && !state.maxPrice && !state.flashSaleOnly) {
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
    catalogCount.innerText = 'Lỗi kết nối! Vui lòng thử lại.';
    window.dispatchEvent(new Event('storefront:error'));
  } finally {
    if (append) state.loadingMore = false;
  }
}

if (btnLoadMore) {
  btnLoadMore.addEventListener('click', () => {
    if (state.loadingMore) return; // đang tải trang trước → không nhảy cóc trang
    btnLoadMore.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải thêm sản phẩm...';
    state.currentPage++;
    fetchProducts(true);
  });
}

// --- Brand Filters ---
async function loadBrands() {
  const container = document.getElementById('brandPills');
  if (!container) return;
  try {
    const res = await fetch('/api/brands');
    const json = await res.json();
    if (json.success && Array.isArray(json.data) && json.data.length) {
      state.brands = json.data;
      renderBrandPills();
    }
  } catch (err) {
    console.error('Lỗi tải danh mục thương hiệu:', err);
  }
}

function renderBrandPills() {
  const container = document.getElementById('brandPills');
  if (!container) return;
  const list = state.brands || [];
  let html = `<button type="button" class="brand-pill ${state.currentBrand === 'all' ? 'active' : ''}" data-brand="all"><i class="fa-solid fa-border-all"></i> Tất cả</button>`;
  for (const b of list) {
    const isAct = state.currentBrand.toLowerCase() === b.name.toLowerCase();
    const displayName = b.name.toLowerCase() === 'ulanzi' ? 'Ulanzi' : b.name;
    html += `<button type="button" class="brand-pill ${isAct ? 'active' : ''}" data-brand="${esc(displayName)}" title="${esc(displayName)} (${b.count} SP)"><i class="fa-solid fa-gem"></i> ${esc(displayName)} <span class="brand-pill-count">${b.count}</span></button>`;
  }
  container.innerHTML = html;
  container.querySelectorAll('.brand-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const b = btn.getAttribute('data-brand');
      container.querySelectorAll('.brand-pill').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      state.currentBrand = b;
      state.currentPage = 1;
      state.searchQuery = '';
      if (typeof searchInput !== 'undefined' && searchInput) searchInput.value = '';
      if (b === 'all') {
        catalogTitle.innerText = state.currentCategory === 'all' ? 'Bảng Giá Sỉ Toàn Kho' : catalogTitle.innerText;
      } else {
        catalogTitle.innerText = `Thương hiệu ${b} chính hãng`;
      }
      fetchProducts();
    });
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

  // Chỉ hiện danh mục gốc còn sản phẩm (lọc danh mục cha đã bao gồm danh mục con ở server).
  // Danh mục nhạy cảm (người lớn) xếp cuối, không đứng giữa trang chủ.
  const sensitive = c => /người lớn|phòng the/i.test(c.name);
  const roots = state.categories
    .filter(c => !c.parent_id && (c.product_count ?? 1) > 0)
    .sort((a, b) => (sensitive(a) - sensitive(b)) || (b.product_count || 0) - (a.product_count || 0));

  roots.forEach(cat => {
    html += `<button class="cat-btn${sensitive(cat) ? ' cat-sensitive' : ''} ${state.currentCategory == cat.id ? 'active' : ''}" data-id="${cat.id}" title="${esc(cat.name)} (${cat.product_count || 0} SP)">
      <i class="fa-solid ${categoryIcon(cat.name)}"></i> <span class="cat-btn-name">${esc(cat.name)}</span><i class="fa-solid fa-chevron-right cat-btn-arrow" aria-hidden="true"></i>
    </button>`;
  });

  categoriesContainer.innerHTML = html + `<button type="button" class="cat-more" data-store-action="categories"><i class="fa-solid fa-ellipsis"></i> Xem thêm</button>`;

  categoriesContainer.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      categoriesContainer.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentCategory = btn.getAttribute('data-id');
      state.currentPage = 1;

      const catObj = state.categories.find(c => c.id == state.currentCategory);
      catalogTitle.innerText = catObj ? catObj.name : (state.flashSaleOnly ? '⚡ Đang Flash Sale Giá Sỉ' : 'Bảng Giá Sỉ Toàn Kho');
      fetchProducts();
    });
  });
}

// --- Render Products ---
// Nhãn góc ảnh (1 nhãn, như mẫu): Hết hàng > Giảm sâu > Mall. % giảm hiện cạnh giá gốc.
function productBadges(p) {
  if (p.in_stock === false) return `<span class="card-tag tag-out">Hết hàng</span>`;
  if (p.is_flash_sale) return `<span class="card-tag tag-flash"><i class="fa-solid fa-bolt"></i> FLASH SALE</span>`;
  if (p.discount_percent >= 35) return `<span class="card-tag tag-deal"><i class="fa-solid fa-fire"></i> GIÁ SỈ -${p.discount_percent}%</span>`;
  if (p.is_mall) return `<span class="card-tag tag-mall"><i class="fa-solid fa-circle-check"></i> Chính hãng</span>`;
  return `<span class="card-tag tag-si"><i class="fa-solid fa-tag"></i> GIÁ SỈ KHO</span>`;
}

function renderProducts(appendFrom = null) {
  if (state.products.length === 0) {
    productGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: #64748b;">
        <i class="fa-solid fa-box-open" style="font-size: 54px; color: #cbd5e1; margin-bottom: 14px;"></i>
        <h3 style="color: #2f3747; margin-bottom: 6px;">Không tìm thấy sản phẩm nào</h3>
        <p>Vui lòng thử tìm kiếm với từ khóa khác hoặc bỏ chọn bộ lọc giá.</p>
      </div>`;
    return;
  }

  // Tải thêm (cuộn vô hạn): chỉ chèn thẻ mới, không vẽ lại hàng nghìn thẻ đã có
  if (appendFrom != null && appendFrom > 0 && productGrid.children.length === appendFrom) {
    productGrid.insertAdjacentHTML('beforeend', state.products.slice(appendFrom).map(productCardHtml).join(''));
    return;
  }
  productGrid.innerHTML = state.products.map(productCardHtml).join('');
}

function productCardHtml(p) {
    const soldOut = p.in_stock === false;
    return `
    <div class="luxury-card${soldOut ? ' is-sold-out' : (p.is_flash_sale ? ' is-flash-card' : '')}" data-id="${p.id}">
      <div class="card-media">
        ${productBadges(p)}
        ${!soldOut && p.discount_percent >= 20 ? `<span class="card-corner-off"><b>-${p.discount_percent}%</b><small>GIẢM</small></span>` : ''}
        <button type="button" class="card-heart" data-favorite-id="${p.id}" aria-label="Lưu sản phẩm" aria-pressed="false"><i class="fa-regular fa-heart"></i></button>
        <img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'400\\' height=\\'400\\' viewBox=\\'0 0 400 400\\'><rect fill=\\'%23111422\\' width=\\'400\\' height=\\'400\\'/><text fill=\\'%238b92b3\\' font-size=\\'18\\' font-family=\\'sans-serif\\' x=\\'50%\\' y=\\'50%\\' text-anchor=\\'middle\\'>Hoang Minh Store</text></svg>'">

        <div class="card-quick-overlay">
          <button class="btn-quick-view" onclick="openProductDetail(${p.id})">
            <i class="fa-solid fa-eye"></i> Xem Chi Tiết
          </button>
        </div>
      </div>

      <div class="card-details">
        ${p.brand ? `<div class="card-brand-tag"><i class="fa-solid fa-gem"></i> ${esc(p.brand.toLowerCase() === 'ulanzi' ? 'Ulanzi' : p.brand)}</div>` : ''}
        <h3 class="card-title" title="${esc(p.name)}" onclick="openProductDetail(${p.id})">${esc(p.name)}</h3>

        <div class="card-pricing">
          <span class="price-highlight">${formatPrice(p.price)}</span>
          ${p.original_price > p.price ? `<span class="price-old-row"><span class="price-strike">${formatPrice(p.original_price)}</span>${p.discount_percent > 0 ? `<span class="price-off">-${p.discount_percent}%</span>` : ''}</span>` : ''}
          ${!soldOut ? (p.original_price > p.price && (p.original_price - p.price) >= 3000 ? `<span class="si-save-chip"><i class="fa-solid fa-fire-flame-curved"></i> Rẻ hơn ${formatCompactVnd(p.original_price - p.price)} · Giá sỉ</span>` : `<span class="si-save-chip is-base"><i class="fa-solid fa-check-double"></i> Mua 1 món cũng giá sỉ</span>`) : ''}
        </div>

        <div class="card-meta">
          <span><i class="fa-solid fa-shield-halved"></i> ${esc(p.warranty || 'Không bảo hành')}</span>
        </div>

        <div class="card-actions-row">
          <button class="btn-add-mini" title="Thêm vào giỏ" aria-label="Thêm vào giỏ" onclick="addToCart(${p.id})" ${soldOut ? 'disabled' : ''}>
            <i class="fa-solid fa-cart-plus"></i>
          </button>
          <button class="btn-buy-instant" onclick="buyNowInstant(${p.id})" ${soldOut ? 'disabled' : ''}>
            ${soldOut ? 'Hết hàng' : 'Mua ngay'}
          </button>
        </div>
      </div>
    </div>`;
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

// --- FULL PRODUCT DETAIL MODAL (Gallery + Video + Specs + Phân loại) ---
let detailRequestVersion = 0;
async function openProductDetail(productId) {
  const requestVersion = ++detailRequestVersion;
  searchDropdown.classList.add('hidden');
  productDetailModal.classList.add('open');
  modalQty = 1;

  // Hiển thị tức thì (0ms) từ bộ nhớ đệm nếu sản phẩm vừa được bấm từ danh sách
  const numId = Number(productId);
  const initial = (typeof productCache !== 'undefined' && productCache.get(numId)) ||
                  (state.products && state.products.find(p => p.id === numId));
  if (initial) {
    state.activeDetailProduct = initial;
    setProductHash(initial);
    state.selectedGalleryIndex = 0;
    const vs = initial.variants || [];
    const def = vs.find(v => v.is_default && v.in_stock) || vs.find(v => v.id === initial.variation_id && v.in_stock) || vs.find(v => v.in_stock) || null;
    state.selectedVariantId = vs.length === 1 ? vs[0].id : vs.length > 1 ? (def ? def.id : null) : null;
    renderDetailModal(initial);
  } else {
    detailModalBody.innerHTML = `
      <div style="text-align: center; padding: 60px;">
        <i class="fa-solid fa-spinner fa-spin" style="font-size: 40px; color: var(--gold);"></i>
        <p style="margin-top: 14px; font-weight: 700; color: #94a3b8;">Đang tải thông số kỹ thuật, phân loại & album ảnh...</p>
      </div>`;
  }

  try {
    const res = await fetch(`/api/products/${productId}`);
    const json = await res.json();
    if (requestVersion !== detailRequestVersion || !productDetailModal.classList.contains('open')) return;
    if (!json.success || !json.data) {
      if (!initial) {
        detailModalBody.innerHTML = `<p style="text-align: center; color: #ef4444;">Không thể tải chi tiết sản phẩm.</p>`;
      }
      return;
    }

    const prod = json.data;
    rememberProducts([{ ...prod, variants: undefined }]);
    state.activeDetailProduct = prod;
    setProductHash(prod);
    const vs = prod.variants || [];
    const curV = vs.find(v => String(v.id) === String(state.selectedVariantId));
    if (!curV) {
      const def = vs.find(v => v.is_default && v.in_stock) || vs.find(v => v.id === prod.variation_id && v.in_stock) || vs.find(v => v.in_stock) || null;
      state.selectedVariantId = vs.length === 1 ? vs[0].id : vs.length > 1 ? (def ? def.id : null) : null;
    }
    renderDetailModal(prod);
  } catch (err) {
    if (requestVersion !== detailRequestVersion || !productDetailModal.classList.contains('open')) return;
    if (!initial) {
      detailModalBody.innerHTML = `<p style="text-align: center; color: #ef4444;">Lỗi kết nối máy chủ.</p>`;
    }
  }
}

function selectedVariant(prod = state.activeDetailProduct) {
  return (prod?.variants || []).find(v => String(v.id) === String(state.selectedVariantId)) || null;
}

/** Tách tên phân loại "Màu đen, XL" theo nhóm lựa chọn (Màu sắc / Size) nếu khớp */
function variantGroups(prod) {
  const groups = prod.variation_options || [];
  const vs = prod.variants || [];
  if (groups.length < 2 || vs.length < 2) return null;
  const parts = vs.map(v => v.name.split(',').map(x => x.trim()));
  if (!parts.every(p => p.length === groups.length)) return null;
  return groups.map((g, i) => ({ display: g.display, options: [...new Set(parts.map(p => p[i]))] }));
}

function renderVariantPicker(prod) {
  const vs = prod.variants || [];
  if (vs.length <= 1) return '';
  const sel = selectedVariant(prod);
  const groups = variantGroups(prod);
  if (groups) {
    const chosen = sel ? sel.name.split(',').map(x => x.trim()) : [];
    return groups.map((g, gi) => `
      <div class="variant-group">
        <div class="variant-group-label">${esc(g.display)}:</div>
        <div class="variant-chips">
          ${g.options.map((opt, oi) => {
            // Có biến thể còn hàng khớp lựa chọn này + các nhóm khác đang chọn?
            const ok = vs.some(v => {
              const p = v.name.split(',').map(x => x.trim());
              return v.in_stock && p[gi] === opt && p.every((x, i) => i === gi || !chosen[i] || x === chosen[i]);
            });
            return `<button type="button" class="variant-chip ${chosen[gi] === opt ? 'active' : ''} ${ok ? '' : 'disabled'}" aria-pressed="${chosen[gi] === opt}" ${ok ? `onclick="pickVariantOption(${gi}, ${oi})"` : 'disabled'}>${esc(opt)}</button>`;
          }).join('')}
        </div>
      </div>`).join('');
  }
  return `
    <div class="variant-group">
      <div class="variant-group-label">Phân loại:</div>
      <div class="variant-chips">
        ${vs.map(v => `<button type="button" class="variant-chip ${String(sel?.id) === String(v.id) ? 'active' : ''} ${v.in_stock ? '' : 'disabled'}" aria-pressed="${String(sel?.id) === String(v.id)}" ${v.in_stock ? `onclick="pickVariant('${v.id}')"` : 'disabled'} title="${v.in_stock ? '' : 'Hết hàng'}">${esc(v.name)}</button>`).join('')}
      </div>
    </div>`;
}

function pickVariant(id) {
  state.selectedVariantId = id;
  const v = selectedVariant();
  if (v?.image) state.selectedGalleryIndex = -1;
  renderDetailModal(state.activeDetailProduct);
}

function pickVariantOption(groupIndex, optionIndex) {
  const prod = state.activeDetailProduct;
  const option = variantGroups(prod)?.[groupIndex]?.options[optionIndex];
  if (option == null) return;
  const sel = selectedVariant(prod);
  const chosen = sel ? sel.name.split(',').map(x => x.trim()) : [];
  chosen[groupIndex] = option;
  const vs = prod.variants || [];
  const match = vs.find(v => v.name.split(',').map(x => x.trim()).every((x, i) => !chosen[i] || x === chosen[i]) && v.in_stock)
    || vs.find(v => v.name.split(',').map(x => x.trim())[groupIndex] === option && v.in_stock);
  if (match) pickVariant(match.id);
}

function urgencyStatsFor(prod, v) {
  const seed = ((Number(prod?.id) || 1) * 37 + (Number(String(v?.id || 0).replace(/\D/g, '').slice(-4)) || 11)) >>> 0;
  const left = 2 + (seed % 7);
  const pct = Math.min(96, 98 - left * 2);
  const viewers = 9 + (seed % 21);
  return { left, pct, viewers };
}

function renderDetailModal(prod) {
  const gallery = prod.gallery && prod.gallery.length > 0 ? prod.gallery : [{ url: prod.image_hd || prod.image, thumb: prod.image }];
  const v = selectedVariant(prod);
  const needsChoice = (prod.variants || []).length > 1;
  const activeMedia = state.selectedGalleryIndex === -1 && v?.image ? { url: v.image } : gallery[Math.max(0, state.selectedGalleryIndex)] || gallery[0];
  const price = v ? v.price : prod.price;
  const original = v ? v.original_price : prod.original_price;
  const discount = v ? v.discount_percent : prod.discount_percent;
  const soldOut = prod.in_stock === false || (needsChoice ? (prod.variants || []).every(x => !x.in_stock) : v ? !v.in_stock : false);
  const canBuy = !soldOut && (!needsChoice || (v && v.in_stock));
  const activeWarranty = (v && v.warranty) || prod.warranty || 'Không bảo hành';
  const urg = urgencyStatsFor(prod, v);

  detailModalBody.innerHTML = `
    <div class="product-detail-grid">
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
            <button type="button" class="thumb-item ${idx === state.selectedGalleryIndex ? 'active' : ''}" aria-label="Xem ${item.is_video ? 'video' : 'ảnh'} ${idx + 1}" aria-pressed="${idx === state.selectedGalleryIndex}" onclick="switchDetailMedia(${idx})">
              <img src="${esc(item.thumb || item.url)}" alt="Ảnh ${idx + 1}">
              ${item.is_video ? `<div class="thumb-video-badge"><i class="fa-solid fa-play"></i></div>` : ''}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="detail-info">
        <div class="detail-head-row">
          <div class="detail-brand-badge">
            ${prod.brand ? `<i class="fa-solid fa-gem"></i> Thương hiệu: <strong>${esc(prod.brand.toLowerCase() === 'ulanzi' ? 'Ulanzi' : prod.brand)}</strong>` : `<i class="fa-solid fa-store"></i> Hoàng Minh Store`}${prod.is_mall ? ' · Sản phẩm Mall' : ''}
          </div>
          <button type="button" class="detail-copy-link" onclick="copyProductLink()"><i class="fa-solid fa-link"></i> Sao chép link</button>
        </div>
        <h2 class="detail-title">${esc(prod.name)}</h2>

        <div class="detail-meta-row">
          <span>Mã SKU: <strong>${esc(v ? v.sku : prod.sku)}</strong></span>
          <span>•</span>
          ${soldOut
            ? `<span class="stock-status-pill" style="background: rgba(239,68,68,.15); color: #ef4444;"><i class="fa-solid fa-xmark"></i> Tạm hết hàng</span>`
            : needsChoice && v && !v.in_stock
              ? `<span class="stock-status-pill" style="background: rgba(239,68,68,.15); color: #ef4444;"><i class="fa-solid fa-xmark"></i> Phân loại này hết hàng</span>`
              : `<span class="stock-status-pill"><i class="fa-solid fa-check"></i> Còn hàng</span>`}
        </div>

        ${!soldOut ? `<div class="detail-si-banner${prod.is_flash_sale ? ' is-flash' : ''}"><div class="detail-si-left"><i class="fa-solid ${prod.is_flash_sale ? 'fa-bolt' : 'fa-tags'}"></i> <strong>${prod.is_flash_sale ? 'FLASH SALE GIÁ SỈ TẬN KHO' : 'CAM KẾT GIÁ SỈ TỪ 1 SẢN PHẨM'}</strong></div>${original && original > price ? `<span class="detail-si-save">Rẻ hơn lẻ ${formatPrice(original - price)}</span>` : `<span class="detail-si-save">Lẻ = Giá buôn</span>`}</div>` : ''}
        <div class="detail-pricing-box">
          <span class="detail-price-main">${formatPrice(price)}</span>
          ${original ? `<span class="detail-price-sub">${formatPrice(original)}</span>` : ''}
          ${discount > 0 ? `<span class="saving-tag">Tiết kiệm ${discount}%</span>` : ''}
        </div>

        <div class="detail-warranty-badge">
          <i class="fa-solid fa-shield-halved"></i> <span>Chính sách bảo hành: <strong>${esc(activeWarranty)}</strong></span>
          <small>${/^Không/i.test(activeWarranty) ? '• Đồng kiểm khi nhận' : '• Chính hãng NSX'}</small>
        </div>
        ${!soldOut ? `<div class="detail-urgency-box"><div class="detail-urgency-top"><span class="detail-urgency-flame"><i class="fa-solid fa-fire-flame-curved"></i> SẮP HẾT HÀNG! Chỉ còn <b id="detailUrgentLeft">${urg.left}</b> suất giá sỉ cuối</span><span class="detail-urgency-viewers"><span class="live-viewer-dot"></span> <b id="detailViewerCount">${urg.viewers}</b> khách đang xem</span></div><div class="detail-urgency-bar"><span class="detail-urgency-fill" style="width:${urg.pct}%"></span><span class="detail-urgency-bar-label"><i class="fa-solid fa-bolt"></i> Đã săn ${urg.pct}% — Tranh thủ chốt đơn!</span></div></div>` : ''}


        ${renderVariantPicker(prod)}
        ${needsChoice && !v ? '<div class="variant-hint"><i class="fa-solid fa-hand-pointer"></i> Vui lòng chọn phân loại</div>' : ''}

        <div class="detail-features-list">
          <div><i class="fa-solid fa-shield-halved"></i> Chính sách bảo hành: <strong>${esc(activeWarranty.replace(/^Bảo hành\s+/i, ''))}</strong>${/^Không/i.test(activeWarranty) ? ' (Đồng kiểm khi nhận hàng)' : ' (Chính hãng theo tiêu chuẩn NSX)'}</div>
          <div><i class="fa-solid fa-truck-fast"></i> Giao hàng toàn quốc, được đồng kiểm khi nhận${v?.weight_gram ? ` · ${(v.weight_gram / 1000).toLocaleString('vi-VN')} kg` : ''}</div>
          <div><i class="fa-solid fa-hand-holding-dollar"></i> ${typeof payOptions !== 'undefined' && payOptions.bank?.enabled ? 'Thanh toán khi nhận hàng (COD) hoặc chuyển khoản' : 'Thanh toán khi nhận hàng (COD) – kiểm tra hàng rồi mới trả tiền'}</div>
        </div>

        <div class="detail-qty-row">
          <span style="font-weight: 700; color: #cbd5e1;">Số lượng mua:</span>
          <div class="qty-stepper">
            <button type="button" aria-label="Giảm số lượng" onclick="changeModalQty(-1)" ${modalQty <= 1 ? 'disabled' : ''}>−</button>
            <span id="modalQtyDisplay">${modalQty}</span>
            <button type="button" aria-label="Tăng số lượng" onclick="changeModalQty(1)" ${modalQty >= 50 ? 'disabled' : ''}>+</button>
          </div>
        </div>


        <div class="detail-actions-row">
          <button class="btn-order-now-large${soldOut ? '' : ' is-urgent-buy'}" onclick="buyFromModalNow()" ${canBuy ? '' : 'disabled'}>
            ${soldOut ? '<i class="fa-solid fa-ban"></i> Tạm hết hàng' : '<span class="urgent-buy-main"><i class="fa-solid fa-bolt"></i> MUA NGAY GIÁ SỈ — CHỐT KẺO HẾT!</span><small class="urgent-buy-sub">🔥 Sắp cháy kho • Giữ suất ưu đãi ngay</small>'}
          </button>
          <button class="btn-add-cart-large" onclick="addFromModalToCart()" ${canBuy ? '' : 'disabled'}>
            <i class="fa-solid fa-cart-plus"></i> Thêm vào giỏ
          </button>
        </div>
      </div>
    </div>

    <div class="detail-tabs-section">
      <div class="detail-tabs-header">
        <button class="tab-btn active" id="tabDescBtn">Mô tả sản phẩm & thông số kỹ thuật</button>
      </div>
      <div class="detail-desc-body">
        ${prod.description || 'Chưa có thông số chi tiết.'}
      </div>
    </div>
  `;
  window.dispatchEvent(new CustomEvent('storefront:detail-open', { detail: { id: prod.id } }));
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
  const buttons = el?.parentElement?.querySelectorAll('button');
  if (buttons?.length === 2) {
    buttons[0].disabled = modalQty <= 1;
    buttons[1].disabled = modalQty >= 50;
  }
}

function modalLine() {
  const p = state.activeDetailProduct;
  if (!p || p.in_stock === false) return null;
  const vs = p.variants || [];
  const v = selectedVariant(p);
  if (vs.length > 1 && (!v || !v.in_stock)) {
    showToast('Vui lòng chọn phân loại còn hàng');
    return null;
  }
  return cartLine(p, modalQty, vs.length > 1 ? v : null);
}

function addFromModalToCart() {
  const line = modalLine();
  if (!line) return;
  addLineToCart(line);
  showToast(`Đã thêm <strong>${modalQty}</strong> sản phẩm vào giỏ hàng!`);
  productDetailModal.classList.remove('open');
  clearProductHash();
  modalQty = 1;
  openCartDrawer();
}

function buyFromModalNow() {
  const line = modalLine();
  if (!line) return;
  state.cart = [line];
  updateCartUI();
  productDetailModal.classList.remove('open');
  clearProductHash();
  modalQty = 1;
  openCheckoutModal();
}

closeDetailModalBtn.addEventListener('click', () => {
  detailRequestVersion++;
  productDetailModal.classList.remove('open');
  clearProductHash();
});

// --- Link sản phẩm thật: /sp/<id>-<slug> (server trả sẵn tiêu đề, ảnh xem trước, dữ liệu cho Google) ---
const HOME_TITLE = 'Hoàng Minh Store | Tổng Kho Giá Sỉ • Flash Sale Phụ Kiện, Công Nghệ & Gia Dụng';
function setProductHash(prod) {
  const url = `/sp/${prod.id}-${String(prod.slug || '').slice(0, 80)}`;
  if (location.pathname !== url) history.pushState({ productId: prod.id }, '', url);
  document.title = `${prod.name} | Hoàng Minh Store`;
}
function clearProductHash() {
  if (location.pathname.startsWith('/sp/') || location.hash.startsWith('#/sp/')) history.pushState(null, '', '/');
  document.title = HOME_TITLE;
}
function openFromHash() {
  // Hỗ trợ cả link cũ dạng /#/sp/<id>
  const m = location.pathname.match(/^\/sp\/(\d+)/) || location.hash.match(/^#\/sp\/(\d+)/);
  if (m && state.activeDetailProduct?.id !== Number(m[1])) openProductDetail(Number(m[1]));
  else if (!m && productDetailModal.classList.contains('open')) {
    productDetailModal.classList.remove('open');
    state.activeDetailProduct = null;
    document.title = HOME_TITLE;
  }
}
window.addEventListener('popstate', openFromHash);
window.addEventListener('hashchange', openFromHash);
function copyProductLink() {
  const url = location.href;
  navigator.clipboard.writeText(url).then(() => showToast('Đã sao chép link sản phẩm')).catch(() => uiPrompt('Sao chép link:', { value: url, readOnly: true }));
}

// --- Cart Operations (mỗi dòng = sản phẩm + phân loại) ---
const lineKey = (id, variationId) => `${id}:${variationId || ''}`;

function cartLine(p, quantity, variant = null) {
  return {
    key: lineKey(p.id, variant?.id),
    id: p.id,
    variation_id: variant?.id || null,
    variant_name: variant?.name || null,
    name: p.name,
    price: variant ? variant.price : p.price,
    image: variant?.image || p.image,
    quantity
  };
}

function addLineToCart(line) {
  const existing = state.cart.find(i => i.key === line.key);
  if (existing) {
    existing.quantity = Math.min(50, existing.quantity + line.quantity);
    existing.price = line.price;
  } else {
    state.cart.push(line);
  }
  updateCartUI();
  window.dispatchEvent(new CustomEvent('storefront:cart-add', { detail: { id:line.id, quantity:line.quantity } }));
}

function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch (e) {}
}

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    state.cart = Array.isArray(raw)
      ? raw.filter(i => i && Number.isInteger(i.id) && i.quantity > 0).map(i => ({ ...i, key: lineKey(i.id, i.variation_id) }))
      : [];
  } catch (e) {
    state.cart = [];
  }
}

/** Cập nhật giá/tồn kho trong giỏ theo dữ liệu hiện tại của cửa hàng (kể cả theo phân loại). */
async function refreshCartPrices() {
  if (state.cart.length === 0) return;
  const removed = [];
  const ids = [...new Set(state.cart.map(i => i.id))];
  await Promise.all(ids.map(async id => {
    try {
      const res = await fetch(`/api/products/${id}`);
      const lines = state.cart.filter(i => i.id === id);
      if (res.status === 404) { lines.forEach(l => { l.quantity = 0; removed.push(l.name); }); return; }
      const json = await res.json();
      if (!json.success) return;
      const p = json.data;
      rememberProducts([{ ...p, variants: undefined }]);
      for (const l of lines) {
        const v = l.variation_id ? (p.variants || []).find(x => x.id === l.variation_id) : null;
        if (p.in_stock === false || (l.variation_id && (!v || !v.in_stock))) { l.quantity = 0; removed.push(l.name); continue; }
        l.price = v ? v.price : p.price;
        l.name = p.name;
      }
    } catch (e) {}
  }));
  state.cart = state.cart.filter(i => i.quantity > 0);
  updateCartUI();
  if (removed.length) showToast(`Đã bỏ khỏi giỏ sản phẩm hết hàng: ${esc(removed.join(', ').slice(0, 80))}`);
}

function buyNowInstant(productId) {
  const product = productCache.get(productId);
  if (!product || product.in_stock === false) return;
  if (product.variant_count !== 1) {
    showToast('Vui lòng chọn phân loại (màu/size...) trước khi mua');
    openProductDetail(productId);
    return;
  }
  state.cart = [cartLine(product, 1)];
  updateCartUI();
  openCheckoutModal();
}

function addToCart(productId, notify = true, qty = 1) {
  const product = productCache.get(productId);
  if (!product || product.in_stock === false) return;
  if (product.variant_count !== 1) {
    showToast('Vui lòng chọn phân loại (màu/size...) trước khi mua');
    openProductDetail(productId);
    return;
  }
  addLineToCart(cartLine(product, qty));
  if (notify) openCartDrawer(); // giỏ tự mở và hiện món vừa thêm → không cần thông báo đè lên giỏ
}

function removeCartLine(key) {
  state.cart = state.cart.filter(i => i.key !== key);
  updateCartUI();
}

function updateCartQty(key, delta) {
  const item = state.cart.find(i => i.key === key);
  if (!item) return;
  item.quantity = Math.min(50, item.quantity + delta);
  if (item.quantity <= 0) state.cart = state.cart.filter(i => i.key !== key);
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
      <div class="cart-empty">
        <span class="cart-empty-icon"><i class="fa-solid fa-basket-shopping"></i></span>
        <h4>Giỏ hàng của bạn đang trống</h4>
        <p>Hãy khám phá các sản phẩm giá tốt nhé!</p>
        <button type="button" class="cart-empty-btn" onclick="closeCartDrawer(); document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth' })">Mua sắm ngay</button>
      </div>`;
    return;
  }

  cartItemsContainer.innerHTML = state.cart.map(item => `
    <div class="cart-drawer-item">
      <img src="${esc(item.image)}" alt="${esc(item.name)}" onclick="closeCartDrawer(); openProductDetail(${Number(item.id)})">
      <div class="cart-drawer-item-info">
        <div class="cart-line-top">
          <div class="drawer-item-title" onclick="closeCartDrawer(); openProductDetail(${Number(item.id)})">${esc(item.name)}</div>
          <button type="button" class="cart-line-remove" aria-label="Xoá khỏi giỏ" title="Xoá khỏi giỏ" onclick="removeCartLine('${item.key}')"><i class="fa-regular fa-trash-can"></i></button>
        </div>
        ${item.variant_name ? `<div class="drawer-item-variant">Phân loại: ${esc(item.variant_name)}</div>` : ''}
        <div class="drawer-item-price">${formatPrice(item.price)}</div>
        <div class="cart-line-bottom">
          <div class="qty-stepper cart-qty">
            <button type="button" aria-label="Giảm" onclick="updateCartQty('${item.key}', -1)">−</button>
            <span>${item.quantity}</span>
            <button type="button" aria-label="Tăng" onclick="updateCartQty('${item.key}', 1)" ${item.quantity >= 50 ? 'disabled' : ''}>+</button>
          </div>
          <span class="cart-line-total">${formatPrice(item.price * item.quantity)}</span>
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
const provinceSelect = document.getElementById('custProvince');
const summarySubtotal = document.getElementById('summarySubtotal');
const summaryShipping = document.getElementById('summaryShipping');
const summaryShippingNote = document.getElementById('summaryShippingNote');
const PROVINCE_KEY = 'hm_province';
const wardSelect = document.getElementById('custWard');
const submitOrderBtn = document.getElementById('submitOrderBtn');
let payOptions = { cod: { enabled: true, maxTotal: 5000000 }, bank: { enabled: false } };

async function loadWards(province, keep) {
  if (!province) {
    wardSelect.innerHTML = '<option value="">-- Chọn Tỉnh / Thành phố trước --</option>';
    wardSelect.disabled = true;
    return;
  }
  wardSelect.disabled = true;
  wardSelect.innerHTML = '<option value="">Đang tải phường/xã...</option>';
  try {
    const json = await (await fetch(`/api/address/wards?province=${encodeURIComponent(province)}`)).json();
    if (!json.success) throw new Error(json.error);
    if (provinceSelect.value !== province) return;
    wardSelect.innerHTML = '<option value="">-- Chọn Phường / Xã --</option>' + json.data.wards.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
    wardSelect.disabled = false;
    if (keep) wardSelect.value = keep;
  } catch (e) {
    wardSelect.innerHTML = '<option value="">Không tải được phường/xã – thử lại</option>';
  }
}

async function loadPayOptions() {
  try {
    const json = await (await fetch('/api/checkout/options')).json();
    if (json.success) payOptions = json.data;
  } catch (e) {}
  document.getElementById('payOptCod').style.display = payOptions.cod.enabled ? '' : 'none';
  document.getElementById('payOptBank').style.display = payOptions.bank.enabled ? '' : 'none';
  const current = document.querySelector('input[name="payMethod"]:checked')?.value;
  const pick = (current === 'BANK' && payOptions.bank.enabled) || !payOptions.cod.enabled ? 'BANK' : 'COD';
  const radio = document.querySelector(`input[name="payMethod"][value="${pick}"]`);
  if (radio) radio.checked = true;
  updatePayButton();
}

function selectedPayMethod() {
  return document.querySelector('input[name="payMethod"]:checked')?.value || 'COD';
}

function updatePayButton() {
  const cod = selectedPayMethod() === 'COD';
  submitOrderBtn.innerHTML = cod ? '<i class="fa-solid fa-check"></i> Đặt hàng – trả tiền khi nhận' : '<i class="fa-solid fa-qrcode"></i> Đặt hàng & nhận mã QR';
  document.getElementById('payMethodNote').innerText = cod && payOptions.cod.maxTotal ? `COD áp dụng cho đơn đến ${formatPrice(payOptions.cod.maxTotal)}.` : '';
}
document.querySelectorAll('input[name="payMethod"]').forEach(r => r.addEventListener('change', updatePayButton));

async function loadProvinces() {
  try {
    const json = await (await fetch('/api/shipping/provinces')).json();
    if (!json.success) return;
    const byRegion = {};
    for (const p of json.data) (byRegion[p.region_label] ||= []).push(p.name);
    provinceSelect.innerHTML = '<option value="">-- Chọn Tỉnh / Thành phố --</option>' +
      Object.entries(byRegion).map(([label, names]) => `<optgroup label="${esc(label)}">${names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</optgroup>`).join('');
    try { provinceSelect.value = localStorage.getItem(PROVINCE_KEY) || ''; } catch (e) {}
  } catch (e) {}
}

let quoteSeq = 0;
async function updateCheckoutSummary() {
  const totalCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = state.cart.reduce((sum, item) => sum + item.quantity * item.price, 0);
  summaryCount.innerText = totalCount + ' sản phẩm';
  const summaryItems = document.getElementById('summaryItems');
  if (summaryItems) summaryItems.innerHTML = state.cart.map(i => `
    <div class="summary-item">
      <img src="${esc(i.image)}" alt="">
      <div class="summary-item-name">${esc(i.name)}${i.variant_name ? `<small>${esc(i.variant_name)}</small>` : ''}</div>
      <div class="summary-item-qty">x${i.quantity}</div>
      <div class="summary-item-price">${formatPrice(i.price * i.quantity)}</div>
    </div>`).join('');
  summarySubtotal.innerText = formatPrice(subtotal);
  const province = provinceSelect.value;
  const seq = ++quoteSeq;
  if (state.cart.length === 0) {
    summaryShipping.innerText = '0 đ';
    summaryShippingNote.innerText = '';
    summaryTotal.innerText = '0 đ';
    return;
  }
  if (!province) {
    summaryShipping.innerText = 'Chọn tỉnh/thành để tính';
    summaryShippingNote.innerText = '';
    summaryTotal.innerText = formatPrice(subtotal);
    return;
  }
  summaryShipping.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang hỏi phí ship từ kho...';
  try {
    const json = await (await fetch('/api/shipping/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ province, ward_id: Number(wardSelect.value) || null, items: state.cart.map(i => ({ id: i.id, variation_id: i.variation_id, quantity: i.quantity })) })
    })).json();
    if (seq !== quoteSeq) return;
    if (!json.success) throw new Error(json.error);
    const q = json.data;
    summaryShipping.innerText = q.fee === 0 ? 'Miễn phí' : formatPrice(q.fee);
    summaryShippingNote.innerText = q.source === 'live' ? `Phí vận chuyển tiêu chuẩn: ${q.detail}` : q.detail;
    summaryTotal.innerText = formatPrice(subtotal + q.fee);
  } catch (e) {
    if (seq !== quoteSeq) return;
    summaryShipping.innerText = 'Không tính được';
    summaryShippingNote.innerText = e.message;
    summaryTotal.innerText = formatPrice(subtotal);
  }
}

provinceSelect.addEventListener('change', () => {
  try { localStorage.setItem(PROVINCE_KEY, provinceSelect.value); } catch (e) {}
  loadWards(provinceSelect.value);
  updateCheckoutSummary();
});
wardSelect.addEventListener('change', updateCheckoutSummary);

function openCheckoutModal() {
  closeCartDrawer();
  checkoutModal.classList.add('open');
  if (provinceSelect.value && wardSelect.disabled) loadWards(provinceSelect.value);
  loadPayOptions();
  updateCheckoutSummary();
}

closeCheckoutBtn.addEventListener('click', () => checkoutModal.classList.remove('open'));
cancelCheckoutBtn.addEventListener('click', () => checkoutModal.classList.remove('open'));

checkoutForm.addEventListener('submit', async e => {
  e.preventDefault();

  const customer = {
    name: document.getElementById('custName').value.trim(),
    phone: document.getElementById('custPhone').value.trim(),
    province: provinceSelect.value,
    ward_id: Number(wardSelect.value) || null,
    address: document.getElementById('custAddress').value.trim(),
    note: document.getElementById('custNote').value.trim()
  };
  const submitBtn = checkoutForm.querySelector('[type="submit"]');
  const prevBtnHtml = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang kiểm tra giá & tồn kho...';
  }

  try {
    // Gửi mã SP + phân loại + số lượng (+ giá đang thấy để server phát hiện giá vừa đổi); tổng tiền do server tính
    const res = await fetch('/api/orders/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer, payment_method: selectedPayMethod(), items: state.cart.map(i => ({ id: i.id, variation_id: i.variation_id, quantity: i.quantity, price: i.price })) })
    });
    const json = await res.json();
    if (res.status === 409 && Array.isArray(json.lines)) {
      // Giá / tồn kho vừa thay đổi tại kho: cập nhật giỏ rồi để khách xác nhận lại tổng tiền
      for (const l of json.lines) {
        const line = state.cart.find(i => i.key === lineKey(l.id, l.variation_id));
        if (!line) continue;
        if (!l.in_stock) line.quantity = 0;
        else if (l.price != null) line.price = l.price;
      }
      state.cart = state.cart.filter(i => i.quantity > 0);
      updateCartUI();
      updateCheckoutSummary();
      uiAlert(json.error + '\n\nGiỏ hàng đã được cập nhật theo dữ liệu mới nhất, vui lòng kiểm tra lại tổng tiền và bấm đặt hàng lần nữa.');
      if (state.cart.length === 0) checkoutModal.classList.remove('open');
      return;
    }
    if (!json.success) {
      uiAlert('Không tạo được đơn: ' + json.error);
      return;
    }

    checkoutModal.classList.remove('open');
    rememberOrder(json.orderId, customer.phone);
    if (json.payment_method === 'COD') {
      state.cart = [];
      updateCartUI();
      openTrackModal({ id: json.orderId, phone: customer.phone });
      await trackOrder(json.orderId, customer.phone);
      trackResult.insertAdjacentHTML('afterbegin', `<div class="cod-success"><i class="fa-solid fa-circle-check"></i><div><strong>Đặt hàng thành công!</strong><br>Bạn thanh toán <strong>${formatPrice(json.total_amount)}</strong> khi nhận hàng. Lưu mã đơn <strong>${esc(json.orderId)}</strong> để tra cứu.</div></div>`);
      return;
    }
    openRealtimeQrModal();
    state.activeOrder = json.orderId;
    socket.emit('join-order', json.orderId);
    // Đề phòng QR được tạo trước khi socket kịp vào phòng: hỏi lại trạng thái đơn
    setTimeout(() => pollOrderOnce(json.orderId), 2500);
  } catch (err) {
    uiAlert('Không thể kết nối máy chủ: ' + err.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      if (prevBtnHtml) submitBtn.innerHTML = prevBtnHtml;
      updatePayButton();
    }
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

socket.on('ORDER_EXPIRED', data => {
  if (data.orderId !== state.activeOrder) return;
  if (state.countdownInterval) clearInterval(state.countdownInterval);
  const timerEl = document.getElementById('countdownTimer');
  if (timerEl) timerEl.innerText = 'Đơn đã huỷ';
  reportPaidBtn.disabled = true;
  reportPaidBtn.innerHTML = '<i class="fa-solid fa-ban"></i> Đơn đã huỷ do quá hạn';
  const alertText = document.getElementById('qrAlertText');
  if (alertText) alertText.innerHTML = `<span style="color:#ef4444;">${esc(data.message)}</span> <strong>Vui lòng KHÔNG chuyển khoản cho đơn này.</strong>`;
});

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

/**
 * Cập nhật tại chỗ khi kho đổi giá / tồn kho (server đẩy qua socket `PRODUCTS_UPDATED`):
 * lưới sản phẩm, giỏ hàng và cửa sổ chi tiết đang mở – không tải lại cả trang.
 */
function applyProductPatches(patches) {
  if (!Array.isArray(patches) || patches.length === 0) return;
  let gridDirty = false;
  const cartNotes = [];
  for (const patch of patches) {
    const cached = productCache.get(patch.id);
    if (cached) Object.assign(cached, patch);
    const inGrid = state.products.find(p => p.id === patch.id);
    if (inGrid) {
      Object.assign(inGrid, patch);
      gridDirty = true;
    }
    for (const line of state.cart.filter(i => i.id === patch.id)) {
      if (patch.in_stock === false) {
        line.quantity = 0;
        cartNotes.push(`"${patch.name}" vừa hết hàng`);
      } else if (!line.variation_id && patch.price !== line.price) {
        cartNotes.push(`"${patch.name}" đổi giá ${formatPrice(line.price)} → ${formatPrice(patch.price)}`);
        line.price = patch.price;
      }
    }
    if (state.activeDetailProduct?.id === patch.id && productDetailModal.classList.contains('open')) {
      // Giá theo phân loại có thể đã đổi → tải lại chi tiết để lấy giá mới của từng phân loại
      const keepVariant = state.selectedVariantId;
      fetch(`/api/products/${patch.id}`).then(r => r.json()).then(j => {
        if (!j.success || state.activeDetailProduct?.id !== patch.id) return;
        state.activeDetailProduct = j.data;
        state.selectedVariantId = keepVariant;
        renderDetailModal(j.data);
      }).catch(() => {});
    }
  }
  state.cart = state.cart.filter(i => i.quantity > 0);
  if (gridDirty) {
    renderProducts();
    window.dispatchEvent(new CustomEvent('storefront:products', { detail: { products: state.products } }));
  }
  if (cartNotes.length) {
    updateCartUI();
    showToast(esc(cartNotes.join(' · ').slice(0, 160)));
  }
}

socket.on('PRODUCTS_UPDATED', data => {
  applyProductPatches(data.items);
  setLiveStamp(data.at);
});

socket.on('REALTIME_HEARTBEAT', data => setLiveStamp(data?.stock?.lastOk || data?.lastSyncTime));

function setLiveStamp(at) {
  if (!at) return;
  let el = document.getElementById('liveSyncStamp');
  if (!el) {
    el = document.createElement('span');
    el.id = 'liveSyncStamp';
    el.className = 'catalog-badge live-sync-badge';
    catalogCount.insertAdjacentElement('afterend', el);
  }
  el.innerHTML = `<span class="live-dot"></span> Tồn kho & giá cập nhật lúc ${new Date(at).toLocaleTimeString('vi-VN')}`;
}

fetch('/api/realtime/status').then(r => r.json()).then(j => j.success && setLiveStamp(j.data.stock?.lastOk || j.data.lastSyncTime)).catch(() => {});

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
    uiAlert('Lỗi: ' + e.message);
    reportPaidBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Tôi Đã Chuyển Khoản';
    reportPaidBtn.disabled = false;
  }
});

finishOrderBtn.addEventListener('click', () => {
  closeRealtimeQrModal();
  state.activeOrder = null;
});

// --- Accessible search suggestions; no stale async results ---
let searchDebounceTimer = null;
let searchRequestSeq = 0;
searchDropdown.setAttribute('role', 'listbox');
searchDropdown.setAttribute('aria-label', 'Gợi ý sản phẩm');
searchInput.setAttribute('aria-controls', 'searchDropdown');
searchInput.setAttribute('aria-expanded', 'false');
searchInput.setAttribute('aria-autocomplete', 'list');
searchClearBtn.setAttribute('aria-label', 'Xóa tìm kiếm');

function hideSearchSuggestions(){
  searchDropdown.classList.add('hidden');
  searchInput.setAttribute('aria-expanded', 'false');
}
function showSearchSuggestions(){
  searchDropdown.classList.remove('hidden');
  searchInput.setAttribute('aria-expanded', 'true');
}
searchInput.addEventListener('input',e=>{
  const q=e.target.value.trim();
  searchClearBtn.classList.toggle('hidden',q.length===0);
  const seq=++searchRequestSeq;
  clearTimeout(searchDebounceTimer);
  if(q.length<2){hideSearchSuggestions();return;}
  searchDebounceTimer=setTimeout(async()=>{
    try{
      const res=await fetch('/api/products?search='+encodeURIComponent(q)+'&limit=6');
      const json=await res.json();
      if(seq!==searchRequestSeq || searchInput.value.trim()!==q)return;
      if(json.success&&Array.isArray(json.data)&&json.data.length){
        rememberProducts(json.data);
        searchDropdown.innerHTML=json.data.map(item=>{
          const id=Number(item.id);
          if(!Number.isSafeInteger(id)||id<1)return '';
          return '<button type="button" role="option" class="search-item-preview" data-preview-id="'+id+
            '" aria-label="Xem '+esc(item.name)+'"><img src="'+esc(item.image)+'" alt="" loading="lazy">'+
            '<span class="search-item-info"><span class="search-item-title">'+esc(item.name)+
            '</span><span class="search-item-price">'+formatPrice(item.price)+(item.in_stock===false?' · Hết hàng':'')+
            '</span></span><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></button>';
        }).join('');
      }else{
        searchDropdown.innerHTML='<div class="search-empty-state">Không tìm thấy sản phẩm phù hợp</div>';
      }
      showSearchSuggestions();
    }catch(_){if(seq===searchRequestSeq)hideSearchSuggestions();}
  },250);
});
searchDropdown.addEventListener('click',e=>{
  const btn=e.target.closest('[data-preview-id]');
  const id=Number(btn?.dataset.previewId);
  if(!Number.isSafeInteger(id)||id<1)return;
  searchRequestSeq++;
  hideSearchSuggestions();
  openProductDetail(id);
});
searchInput.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'&&!searchDropdown.classList.contains('hidden')){
    const btn=searchDropdown.querySelector('[data-preview-id]');
    if(btn){e.preventDefault();btn.focus();}
  }
  if(e.key==='Escape'){e.preventDefault();hideSearchSuggestions();}
});
searchDropdown.addEventListener('keydown',e=>{
  const focused=e.target.closest('[data-preview-id]');
  if(!focused)return;
  const items=[...searchDropdown.querySelectorAll('[data-preview-id]')];
  const at=items.indexOf(focused);
  if(e.key==='Escape'){
    e.preventDefault();hideSearchSuggestions();searchInput.focus();
  }else if(e.key==='ArrowDown'){
    e.preventDefault();items[Math.min(at+1,items.length-1)]?.focus();
  }else if(e.key==='ArrowUp'){
    e.preventDefault();
    if(at<=0)searchInput.focus(); else items[at-1]?.focus();
  }
});
searchClearBtn.addEventListener('click',()=>{
  searchRequestSeq++;
  clearTimeout(searchDebounceTimer);
  searchInput.value='';
  searchClearBtn.classList.add('hidden');
  hideSearchSuggestions();
  state.searchQuery='';
  state.currentPage=1;
  catalogTitle.innerText='Tất Cả Sản Phẩm';
  fetchProducts();
  searchInput.focus();
});
document.addEventListener('click',e=>{
  if(!e.target.closest('.search-wrapper'))hideSearchSuggestions();
});
function runSearch(){
  searchRequestSeq++;
  clearTimeout(searchDebounceTimer);
  hideSearchSuggestions();
  state.searchQuery=searchInput.value.trim();
  state.currentPage=1;
  state.currentBrand='all';
  const brandPills = document.getElementById('brandPills');
  if (brandPills) {
    brandPills.querySelectorAll('.brand-pill').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-brand') === 'all');
    });
  }
  catalogTitle.innerText=state.searchQuery?'Kết quả cho "'+state.searchQuery+'"':'Tất Cả Sản Phẩm';
  fetchProducts();
}
searchBtn.addEventListener('click',runSearch);
searchInput.addEventListener('keyup',e=>{
  if(e.key==='Enter')runSearch();
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
    state.flashSaleOnly = pill.getAttribute('data-flash') === '1';
    if (state.currentCategory === 'all' && !state.searchQuery) {
      catalogTitle.innerText = state.flashSaleOnly ? '⚡ Đang Flash Sale Giá Sỉ' : (state.maxPrice === '99000' ? '🔥 Xả Kho Đồng Giá Dưới 99K' : 'Bảng Giá Sỉ Toàn Kho');
    }
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
loadProvinces();
loadCart();
updateCartUI();
fetchCategories();
loadBrands();
fetchProducts();
refreshCartPrices();
openFromHash();


// ============================ TRA CỨU ĐƠN HÀNG ============================
const ORDERS_KEY = 'hm_my_orders';
const trackModal = document.getElementById('trackModal');
const trackResult = document.getElementById('trackResult');

function myOrders() {
  try { return JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]'); } catch (e) { return []; }
}
function rememberOrder(id, phone) {
  try {
    const list = [{ id, phone, at: new Date().toISOString() }, ...myOrders().filter(o => o.id !== id)].slice(0, 10);
    localStorage.setItem(ORDERS_KEY, JSON.stringify(list));
  } catch (e) {}
}

const STATUS_VI = {
  PENDING_PAYMENT: ['Chờ thanh toán', '#f59e0b'],
  CONFIRMED: ['Đã xác nhận – thanh toán khi nhận hàng', '#10b981'],
  PAYMENT_REPORTED: ['Đã báo chuyển khoản – chờ cửa hàng xác nhận', '#f59e0b'],
  PAID: ['Đã thanh toán – chờ xuất kho', '#10b981'],
  PROCESSING: ['Đang xử lý tại kho', '#38bdf8'],
  COMPLETED: ['Hoàn tất', '#10b981'],
  CANCELLED: ['Đã huỷ', '#ef4444']
};

function openTrackModal(prefill) {
  const recent = myOrders();
  document.getElementById('trackRecent').innerHTML = recent.length
    ? `<div style="font-size:12px; color:#94a3b8; margin-bottom:6px;">Đơn bạn đã đặt trên máy này:</div>${recent.map(o => `<button type="button" class="variant-chip" onclick="trackOrder('${esc(o.id)}', '${esc(o.phone)}')">${esc(o.id)}</button>`).join(' ')}`
    : '';
  trackResult.innerHTML = '';
  if (prefill) {
    document.getElementById('trackOrderId').value = prefill.id;
    document.getElementById('trackPhone').value = prefill.phone;
  }
  trackModal.classList.add('open');
}

async function trackOrder(id, phone) {
  document.getElementById('trackOrderId').value = id;
  document.getElementById('trackPhone').value = phone;
  trackResult.innerHTML = '<p style="text-align:center; color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Đang tra cứu...</p>';
  try {
    const json = await (await fetch(`/api/orders/${encodeURIComponent(id.trim().toUpperCase())}/track?phone=${encodeURIComponent(phone)}`)).json();
    if (!json.success) throw new Error(json.error);
    const o = json.data;
    const [label, color] = STATUS_VI[o.status] || [o.status, '#94a3b8'];
    trackResult.innerHTML = `
      <div class="track-card">
        <div class="flex-between"><strong>Đơn #${esc(o.id)}</strong><span style="color:${color}; font-weight:700;">${esc(label)}</span></div>
        <div class="track-timeline">${o.timeline.map(t => `<div><span>${new Date(t.at).toLocaleString('vi-VN')}</span> ${esc(t.label)}</div>`).join('')}</div>
        <div class="track-items">${o.items.map(i => `<div class="flex-between"><span>${esc(i.name)}${i.variant_name ? ` <em>[${esc(i.variant_name)}]</em>` : ''} × ${i.quantity}</span><span>${formatPrice(i.price * i.quantity)}</span></div>`).join('')}</div>
        <div class="flex-between"><span>Tạm tính</span><span>${formatPrice(o.subtotal)}</span></div>
        <div class="flex-between"><span>Phí vận chuyển</span><span>${o.shipping_fee ? formatPrice(o.shipping_fee) : 'Miễn phí'}</span></div>
        <div class="flex-between" style="font-size:16px;"><strong>Tổng</strong><strong class="price-highlight">${formatPrice(o.total_amount)}</strong></div>
        <div style="font-size:12px; color:#94a3b8; margin-top:6px;">Giao tới: ${esc(o.address || '')}${o.customer?.ward_name ? `, ${esc(o.customer.ward_name)}` : ''}${o.customer?.province ? `, ${esc(o.customer.province)}` : ''}</div>
        <div style="font-size:12px; color:#94a3b8;">Thanh toán: ${o.payment_method === 'COD' ? 'khi nhận hàng (COD)' : 'chuyển khoản'}</div>
        ${o.shipping_ref_code ? shipmentBlock(o) : ''}
        <div style="margin-top:10px; padding-top:10px; border-top:1px dashed rgba(148,163,184,0.2); display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;"><span style="font-size:12px; color:#94a3b8;">Nhận mã vận đơn & hành trình tự động qua Zalo:</span><button type="button" class="btn-ghost" style="font-size:12px; padding:6px 10px; color:#38bdf8; border-color:rgba(56,189,248,0.35);" onclick="openZaloBotForOrder('${esc(o.id)}')"><i class="fa-solid fa-bell"></i> Kết nối Zalo Bot (#${esc(o.id)})</button></div>
        ${o.status === 'PENDING_PAYMENT' && o.payment ? `<button type="button" class="btn-primary-block" style="margin-top:12px;" onclick="resumePayment('${esc(o.id)}')"><i class="fa-solid fa-qrcode"></i> Mở Mã QR Để Thanh Toán</button>` : ''}
      </div>`;
    state.trackedOrder = o;
  } catch (e) {
    trackResult.innerHTML = `<p style="text-align:center; color:#ef4444;">${esc(e.message)}</p>`;
  }
}

// Hãng vận chuyển: không hãng nào cho mở thẳng kết quả theo mã (Viettel Post có captcha) → sao chép mã + mở trang tra cứu
const CARRIERS = {
  S: { name: 'SPX Express', url: 'https://spx.vn/' },
  V: { name: 'Viettel Post', url: 'https://viettelpost.com.vn/tra-cuu-hanh-trinh-don/' }
};
function shipmentBlock(o) {
  const c = CARRIERS[o.shipping_carrier] || (/^SPX/i.test(o.shipping_ref_code) ? CARRIERS.S : null);
  const code = String(o.shipping_ref_code).split(',')[0].trim();
  return `<div class="shipment-box">
    <div><i class="fa-solid fa-truck-fast"></i> ${c ? esc(c.name) : 'Đơn vị vận chuyển'} · Mã vận đơn <strong>${esc(o.shipping_ref_code)}</strong></div>
    <div class="shipment-actions">
      <button type="button" class="btn-ghost" onclick="copyShipCode('${esc(code)}')"><i class="fa-regular fa-copy"></i> Sao chép mã</button>
      ${c ? `<a class="btn-ghost" href="${c.url}" target="_blank" rel="noopener" onclick="copyShipCode('${esc(code)}', true)"><i class="fa-solid fa-arrow-up-right-from-square"></i> Tra cứu trên ${esc(c.name)}</a>` : ''}
    </div>
    ${c ? `<small>Mở trang tra cứu rồi dán mã vận đơn (đã tự sao chép).</small>` : ''}
  </div>`;
}
function copyShipCode(code, silent) {
  navigator.clipboard?.writeText(code).then(() => { if (!silent) showToast('Đã sao chép mã vận đơn'); }).catch(() => { if (!silent) uiPrompt('Mã vận đơn:', { value: code, readOnly: true }); });
}

function resumePayment(orderId) {
  const o = state.trackedOrder;
  if (!o || o.id !== orderId) return;
  trackModal.classList.remove('open');
  openRealtimeQrModal();
  state.activeOrder = orderId;
  socket.emit('join-order', orderId);
  const remaining = Math.max(60, Math.round((new Date(o.created_at).getTime() + (o.payment.expires_in_seconds || 1800) * 1000 - Date.now()) / 1000));
  showQr({ orderId, qr: { ...o.payment, expires_in_seconds: remaining } });
}

document.getElementById('openTrackBtn').addEventListener('click', e => {
  e.preventDefault();
  openTrackModal();
});
document.getElementById('closeTrackBtn').addEventListener('click', () => trackModal.classList.remove('open'));
document.getElementById('trackForm').addEventListener('submit', e => {
  e.preventDefault();
  trackOrder(document.getElementById('trackOrderId').value, document.getElementById('trackPhone').value);
});
// Link tra cứu shop gửi khách: /?tra-cuu=HMxxxxxxxx → mở sẵn ô tra cứu, khách chỉ cần nhập SĐT
document.addEventListener('DOMContentLoaded', () => {
  const code = new URLSearchParams(location.search).get('tra-cuu');
  if (!code || !/^HM[0-9A-F]{8}$/i.test(code)) return;
  const saved = myOrders().find(o => o.id === code.toUpperCase());
  openTrackModal({ id: code.toUpperCase(), phone: saved?.phone || '' });
  if (saved?.phone) trackOrder(code.toUpperCase(), saved.phone);
  else setTimeout(() => document.getElementById('trackPhone')?.focus(), 50);
});

function openZaloBotForOrder(orderId) {
  navigator.clipboard?.writeText(orderId).catch(() => {});
  showToast('Đã sao chép mã <strong>' + esc(orderId) + '</strong> – hãy dán gửi vào Zalo Bot!');
  window.open('https://zalo.me/bot.JiCLwQrK', '_blank', 'noopener');
}
