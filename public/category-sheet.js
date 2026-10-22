/*
 * Bảng "Danh mục" đầy đủ (danh mục cha + con, kèm số SP).
 * Trước đây các nút/link "Danh mục" (thanh dưới điện thoại, lối tắt, tab) chỉ nhảy tới #categoryPanel – trên điện
 * thoại đó là hàng chip đang nằm ngay trên màn hình nên bấm như không có tác dụng. Giờ chúng mở bảng này;
 * chọn danh mục → lọc sản phẩm, đóng bảng, cuộn tới danh sách.
 */
(function () {
  const sheet = document.createElement('div');
  sheet.className = 'cat-sheet';
  sheet.id = 'categorySheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Danh mục sản phẩm');
  sheet.innerHTML = `
    <div class="cat-sheet-backdrop" data-cat-close></div>
    <div class="cat-sheet-panel">
      <div class="cat-sheet-head">
        <strong><i class="fa-solid fa-border-all"></i> Danh mục sản phẩm</strong>
        <button type="button" class="cat-sheet-close" data-cat-close aria-label="Đóng">&times;</button>
      </div>
      <input type="search" class="cat-sheet-search" placeholder="Tìm danh mục..." aria-label="Tìm danh mục">
      <div class="cat-sheet-list"></div>
    </div>`;
  document.body.appendChild(sheet);
  const list = sheet.querySelector('.cat-sheet-list');
  const search = sheet.querySelector('.cat-sheet-search');

  const cats = () => (typeof state !== 'undefined' && Array.isArray(state.categories) ? state.categories : []);
  const iconOf = name => (typeof categoryIcon === 'function' ? categoryIcon(name) : 'fa-tag');
  const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n || 0).toLocaleString('vi-VN');

  function render(filter = '') {
    const all = cats();
    const q = filter.trim().toLowerCase();
    const roots = all.filter(c => !c.parent_id && (c.product_count ?? 1) > 0).sort((a, b) => (b.product_count || 0) - (a.product_count || 0));
    const childrenOf = id => all.filter(c => c.parent_id === id && (c.product_count ?? 1) > 0).sort((a, b) => (b.product_count || 0) - (a.product_count || 0));
    const current = typeof state !== 'undefined' ? String(state.currentCategory) : 'all';
    let html = `<button type="button" class="cat-sheet-item ${current === 'all' ? 'active' : ''}" data-cat-id="all"><i class="fa-solid fa-border-all"></i><span>Tất cả sản phẩm</span></button>`;
    for (const r of roots) {
      const kids = childrenOf(r.id);
      const match = !q || r.name.toLowerCase().includes(q) || kids.some(k => k.name.toLowerCase().includes(q));
      if (!match) continue;
      const shownKids = q ? kids.filter(k => r.name.toLowerCase().includes(q) || k.name.toLowerCase().includes(q)) : kids;
      html += `<div class="cat-sheet-group${q && shownKids.length ? ' open' : ''}">
        <div class="cat-sheet-row">
          <button type="button" class="cat-sheet-item ${current === String(r.id) ? 'active' : ''}" data-cat-id="${r.id}"><i class="fa-solid ${iconOf(r.name)}"></i><span>${escH(r.name)}</span><small>${fmt(r.product_count)}</small></button>
          ${kids.length ? `<button type="button" class="cat-sheet-toggle" aria-label="Xem danh mục con của ${escH(r.name)}"><i class="fa-solid fa-chevron-down"></i></button>` : ''}
        </div>
        ${shownKids.length ? `<div class="cat-sheet-kids">${shownKids.map(k => `<button type="button" class="cat-sheet-kid ${current === String(k.id) ? 'active' : ''}" data-cat-id="${k.id}">${escH(k.name)} <small>${fmt(k.product_count)}</small></button>`).join('')}</div>` : ''}
      </div>`;
    }
    list.innerHTML = html;
  }

  function open() {
    render(search.value = '');
    sheet.classList.add('open');
    document.body.classList.add('cat-sheet-open');
    setTimeout(() => list.querySelector('.active')?.scrollIntoView({ block: 'center' }), 50);
  }
  function close() {
    sheet.classList.remove('open');
    document.body.classList.remove('cat-sheet-open');
  }

  // Cuộn tới danh sách SAU khi lưới sản phẩm vẽ xong (cuộn sớm bị việc vẽ lại lưới làm gián đoạn)
  function scrollToCatalogAfterRender() {
    const target = document.getElementById('catalog');
    if (!target) return;
    let done = false;
    const go = () => { if (done) return; done = true; target.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    window.addEventListener('storefront:products', () => setTimeout(go, 50), { once: true });
    setTimeout(go, 2500); // dự phòng khi mạng chậm / lỗi
  }

  function choose(id) {
    if (typeof state === 'undefined' || typeof fetchProducts !== 'function') return;
    if (typeof window.storeSelectCategory === 'function') {
      window.storeSelectCategory(id); // trang danh mục: có link riêng + nút Back
      close();
      scrollToCatalogAfterRender();
      return;
    }
    // Danh mục cha có sẵn chip/nút → bấm nút đó để giữ đúng trạng thái giao diện; danh mục con → lọc trực tiếp
    const btn = document.querySelector(`#categoriesContainer .cat-btn[data-id="${CSS.escape(String(id))}"]`);
    if (btn) btn.click();
    else {
      document.querySelectorAll('#categoriesContainer .cat-btn').forEach(b => b.classList.remove('active'));
      state.currentCategory = String(id);
      state.currentPage = 1;
      const cat = cats().find(c => String(c.id) === String(id));
      if (typeof catalogTitle !== 'undefined' && catalogTitle) catalogTitle.innerText = cat ? cat.name : 'Tất Cả Sản Phẩm';
      fetchProducts();
    }
    close();
    scrollToCatalogAfterRender();
  }

  sheet.addEventListener('click', e => {
    if (e.target.closest('[data-cat-close]')) return close();
    const toggle = e.target.closest('.cat-sheet-toggle');
    if (toggle) return toggle.closest('.cat-sheet-group').classList.toggle('open');
    const item = e.target.closest('[data-cat-id]');
    if (item) choose(item.dataset.catId);
  });
  search.addEventListener('input', () => render(search.value));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet.classList.contains('open')) close(); });

  // Mọi nút/link "Danh mục" → mở bảng (chạy trước các xử lý cuộn trang có sẵn)
  document.addEventListener('click', e => {
    const trigger = e.target.closest('a[href="#categoryPanel"], [data-store-action="categories"]');
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    open();
  }, true);

  document.addEventListener('click', e => {
    const home = e.target.closest('.mobile-bottom-nav a[href="/"], nav.market-links a[href="/"]');
    if (!home || location.pathname !== '/') return;
    e.preventDefault();
    close();
    if (location.hash) history.replaceState(null, '', '/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  document.addEventListener('click', e => {
    if (e.target.closest('#categoriesContainer .cat-btn')) scrollToCatalogAfterRender();
  });

  window.openCategorySheet = open;
})();
