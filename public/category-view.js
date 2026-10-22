/*
 * Trang danh mục: vào 1 danh mục là xem TOÀN BỘ sản phẩm của mục đó.
 *  - ẩn phần trang chủ (banner, lối tắt, gợi ý), hiện đường dẫn + danh mục con + tổng số SP
 *  - cuộn tới đâu tự tải tới đó cho tới hết mục (nút "Tải thêm" vẫn còn làm dự phòng)
 *  - link riêng /?danh-muc=<id>-<tên>, nút Back của trình duyệt quay về đúng chỗ
 *  - chuyển cảnh: lưới mờ dần khi đổi mục, khung chờ lấp lánh khi tải thêm, thẻ hiện dần theo nhịp
 */
(function () {
  if (typeof state === 'undefined' || typeof fetchProducts !== 'function') return;
  const catalog = document.getElementById('catalog');
  const grid = document.getElementById('productGrid');
  const loadMore = document.getElementById('btnLoadMore');
  if (!catalog || !grid) return;

  const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n || 0).toLocaleString('vi-VN');
  const cats = () => (Array.isArray(state.categories) ? state.categories : []);
  const catById = id => cats().find(c => String(c.id) === String(id));
  const iconOf = name => (typeof categoryIcon === 'function' ? categoryIcon(name) : 'fa-tag');
  const slugify = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

  // --- Khung đầu trang danh mục ---
  const head = document.createElement('div');
  head.className = 'cat-view-head';
  head.id = 'categoryViewHead';
  head.hidden = true;
  catalog.insertBefore(head, catalog.firstElementChild);

  // --- Khung chờ khi tải thêm + thông báo đã hết ---
  const more = document.createElement('div');
  more.className = 'cat-loading-more';
  more.hidden = true;
  more.innerHTML = Array.from({ length: 4 }, () => '<div class="cat-skeleton"><span></span><i></i><i></i></div>').join('');
  grid.after(more);
  const end = document.createElement('div');
  end.className = 'cat-list-end';
  end.hidden = true;
  more.after(end);

  function renderHead() {
    const cat = catById(state.currentCategory);
    if (!cat) { head.hidden = true; return; }
    const parent = cat.parent_id ? catById(cat.parent_id) : null;
    const root = parent || cat;
    const kids = cats().filter(c => c.parent_id === root.id && (c.product_count ?? 1) > 0).sort((a, b) => (b.product_count || 0) - (a.product_count || 0));
    const total = state.totalProducts ?? cat.product_count;
    head.innerHTML = `
      <nav class="cat-crumbs" aria-label="Đường dẫn">
        <a href="/" data-cat-go="all"><i class="fa-solid fa-house"></i> Trang chủ</a>
        <i class="fa-solid fa-chevron-right"></i>
        ${parent ? `<a href="?danh-muc=${parent.id}" data-cat-go="${parent.id}">${escH(parent.name)}</a><i class="fa-solid fa-chevron-right"></i>` : ''}
        <strong>${escH(cat.name)}</strong>
      </nav>
      <div class="cat-view-title">
        <span class="cat-view-icon"><i class="fa-solid ${iconOf(root.name)}"></i></span>
        <div><h1>${escH(cat.name)}</h1><p>${fmt(total)} sản phẩm${state.minPrice || state.maxPrice ? ' (đang lọc theo giá)' : ''}</p></div>
        <button type="button" class="cat-view-all" data-store-action="categories"><i class="fa-solid fa-border-all"></i> Tất cả danh mục</button>
      </div>
      ${kids.length ? `<div class="cat-subs" role="list">
        <button type="button" class="cat-sub ${String(root.id) === String(cat.id) ? 'active' : ''}" data-cat-go="${root.id}">Tất cả</button>
        ${kids.map(k => `<button type="button" class="cat-sub ${String(k.id) === String(cat.id) ? 'active' : ''}" data-cat-go="${k.id}">${escH(k.name)} <small>${fmt(k.product_count)}</small></button>`).join('')}
      </div>` : ''}`;
    head.hidden = false;
    head.querySelector('.cat-sub.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function syncView() {
    const id = String(state.currentCategory);
    const inView = id !== 'all' && !!catById(id) && !state.searchQuery;
    document.body.classList.toggle('is-category-view', inView);
    if (inView) renderHead(); else head.hidden = true;
    // Hết mục
    const loaded = state.products.length;
    const total = state.totalProducts ?? loaded;
    end.hidden = !(loaded > 0 && loaded >= total);
    end.innerHTML = inView
      ? `<i class="fa-solid fa-circle-check"></i> Đã hiển thị hết ${fmt(total)} sản phẩm của <strong>${escH(catById(id).name)}</strong>`
      : `<i class="fa-solid fa-circle-check"></i> Đã hiển thị hết ${fmt(total)} sản phẩm`;
    document.title = inView ? `${catById(id).name} | Hoàng Minh Store` : 'Hoàng Minh Store | Mua sắm công nghệ, phụ kiện và gia dụng';
  }

  // --- Chọn danh mục (dùng chung cho danh mục bên trái, chip, bảng Danh mục, đường dẫn, danh mục con) ---
  function select(id, { push = true } = {}) {
    id = String(id || 'all');
    const btn = document.querySelector(`#categoriesContainer .cat-btn[data-id="${CSS.escape(id)}"]`);
    if (btn) btn.click(); // nút có sẵn tự cập nhật trạng thái + tải SP
    else {
      document.querySelectorAll('#categoriesContainer .cat-btn').forEach(b => b.classList.remove('active'));
      state.currentCategory = id;
      state.currentPage = 1;
      const cat = catById(id);
      if (typeof catalogTitle !== 'undefined' && catalogTitle) catalogTitle.innerText = cat ? cat.name : 'Tất Cả Sản Phẩm';
      fetchProducts();
    }
    if (push) pushUrl(id);
  }
  window.storeSelectCategory = select;

  function urlFor(id) {
    if (String(id) === 'all') return location.pathname === '/' ? '/' : '/';
    const cat = catById(id);
    return `/?danh-muc=${id}${cat ? '-' + slugify(cat.name) : ''}`;
  }
  function pushUrl(id) {
    const url = urlFor(id);
    if (location.pathname + location.search !== url) history.pushState({ cat: String(id) }, '', url);
  }
  function catFromUrl() {
    const v = new URLSearchParams(location.search).get('danh-muc');
    const m = v && v.match(/^(\d+)/);
    return m ? m[1] : 'all';
  }

  // Bấm danh mục bên trái / hàng chip → ghi link riêng
  document.addEventListener('click', e => {
    const chip = e.target.closest('#categoriesContainer .cat-btn');
    if (chip && e.isTrusted) pushUrl(chip.getAttribute('data-id'));
    const go = e.target.closest('[data-cat-go]');
    if (go) {
      e.preventDefault();
      select(go.dataset.catGo);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  window.addEventListener('popstate', () => {
    if (location.pathname !== '/') return;
    const id = catFromUrl();
    if (String(state.currentCategory) !== id) select(id, { push: false });
  });

  // --- Cuộn vô hạn ---
  let autoLoad = null;
  function maybeLoadMore() {
    if (!loadMore || state.loadingMore) return;
    if (getComputedStyle(loadMore).display === 'none' || !loadMore.isConnected) return;
    if ((state.products.length || 0) >= (state.totalProducts ?? Infinity)) return;
    const r = loadMore.getBoundingClientRect();
    if (r.top < window.innerHeight + 900) loadMore.click();
  }
  if (loadMore && 'IntersectionObserver' in window) {
    autoLoad = new IntersectionObserver(entries => { if (entries.some(en => en.isIntersecting)) maybeLoadMore(); }, { rootMargin: '0px 0px 900px 0px' });
    autoLoad.observe(loadMore);
  }
  // Dự phòng: IntersectionObserver chỉ báo khi nút ĐI VÀO vùng nhìn – nếu nút đã nằm sẵn trong màn hình
  // (danh mục nhỏ, màn hình cao) thì không báo nữa → kiểm tra thêm theo cuộn / đổi cỡ, giới hạn 4 lần/giây
  let scrollTick = 0;
  const onScroll = () => {
    const now = Date.now();
    if (now - scrollTick < 250) return;
    scrollTick = now;
    maybeLoadMore();
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  // --- Chuyển cảnh ---
  window.addEventListener('storefront:loading', () => {
    if (state.loadingMore) more.hidden = false; // tải thêm: khung chờ ở cuối
    else grid.classList.add('is-switching');   // đổi mục / bộ lọc: lưới mờ dần
  });
  const done = () => {
    more.hidden = true;
    grid.classList.remove('is-switching');
    syncView();
    // Màn hình cao / tải nhanh: nút "Tải thêm" vẫn trong vùng nhìn → tải tiếp
    setTimeout(maybeLoadMore, 120);
  };
  window.addEventListener('storefront:products', done);
  window.addEventListener('storefront:error', () => { more.hidden = true; grid.classList.remove('is-switching'); });

  // --- Mở thẳng link /?danh-muc=... ---
  const initial = catFromUrl();
  if (initial !== 'all') {
    let tries = 0;
    const wait = setInterval(() => {
      if (catById(initial) || ++tries > 50) {
        clearInterval(wait);
        if (catById(initial)) select(initial, { push: false });
      }
    }, 200);
  }
})();
