/* Trang đánh giá đơn hàng (/danh-gia/<mã đơn>?k=<vé>): chấm sao + nhận xét từng SP, gửi một lần. */
(() => {
  'use strict';
  const app = document.getElementById('reviewApp');
  if (!app) return;
  const orderId = app.dataset.order;
  const key = new URLSearchParams(location.search).get('k') || '';
  const intro = document.getElementById('reviewIntro');
  const form = document.getElementById('reviewForm');
  const done = document.getElementById('reviewDone');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const headers = { 'X-Order-Key': key, 'Content-Type': 'application/json' };
  const WORDS = ['', 'Rất tệ', 'Chưa hài lòng', 'Bình thường', 'Hài lòng', 'Rất hài lòng'];

  function stars(pid) {
    return `<div class="rv-stars" role="radiogroup" aria-label="Số sao">${[1, 2, 3, 4, 5].map(n =>
      `<label title="${WORDS[n]}"><input type="radio" name="r${pid}" value="${n}"${n === 5 ? ' checked' : ''}><i class="fa-solid fa-star" aria-hidden="true"></i><span class="sr">${n} sao</span></label>`).join('')}
      <span class="rv-word" data-word="${pid}">${WORDS[5]}</span></div>`;
  }

  async function load() {
    try {
      const j = await fetch(`/api/reviews/order/${encodeURIComponent(orderId)}`, { headers }).then(r => r.json());
      if (!j.success) throw new Error(j.error || 'Không mở được đơn hàng.');
      const d = j.data;
      if (!d.can_review) { intro.textContent = 'Đơn này chưa giao xong nên chưa đánh giá được. Bạn quay lại sau khi nhận hàng nhé!'; return; }
      if (!d.items.length) { intro.textContent = 'Bạn đã đánh giá tất cả sản phẩm trong đơn này. Cảm ơn bạn!'; return; }
      intro.innerHTML = 'Chấm sao và viết vài dòng cho từng sản phẩm. Đánh giá được cửa hàng duyệt trước khi hiện trên web, tên bạn được che bớt.';
      form.innerHTML = d.items.map(i => `
        <section class="rv-item" data-pid="${i.product_id}">
          <div class="rv-head">${i.image ? `<img src="${esc(i.image)}" alt="" width="56" height="56">` : ''}<div><strong>${esc(i.name)}</strong>${i.variant_name ? `<small>${esc(i.variant_name)}</small>` : ''}</div></div>
          ${stars(i.product_id)}
          <textarea name="c${i.product_id}" rows="3" maxlength="500" placeholder="Sản phẩm dùng thế nào? Đóng gói, giao hàng ra sao? (không bắt buộc)"></textarea>
        </section>`).join('') + '<button type="submit" class="rv-submit">Gửi đánh giá</button><p class="rv-err" id="rvErr" hidden></p>';
      form.hidden = false;
      form.addEventListener('change', e => {
        const m = e.target.name && e.target.name.match(/^r(\d+)$/);
        if (m) form.querySelector(`[data-word="${m[1]}"]`).textContent = WORDS[Number(e.target.value)];
      });
    } catch (e) {
      intro.textContent = e.message === 'Không tìm thấy đơn hàng' ? 'Link đánh giá không đúng hoặc đã hết hạn. Bạn mở lại link shop gửi qua Zalo, hoặc tra cứu đơn bằng mã đơn + số điện thoại.' : e.message;
    }
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('.rv-submit');
    const err = document.getElementById('rvErr');
    const items = [...form.querySelectorAll('.rv-item')].map(s => {
      const pid = Number(s.dataset.pid);
      return { product_id: pid, rating: Number(form.querySelector(`input[name="r${pid}"]:checked`)?.value || 5), comment: form.querySelector(`[name="c${pid}"]`).value };
    });
    btn.disabled = true;
    btn.textContent = 'Đang gửi…';
    try {
      const j = await fetch(`/api/reviews/order/${encodeURIComponent(orderId)}`, { method: 'POST', headers, body: JSON.stringify({ items }) }).then(r => r.json());
      if (!j.success) throw new Error(j.error);
      form.hidden = true;
      intro.hidden = true;
      done.hidden = false;
      done.innerHTML = `<strong>Cảm ơn bạn đã đánh giá!</strong> Cửa hàng sẽ duyệt và hiện đánh giá trên trang sản phẩm. <a href="/">Tiếp tục mua sắm</a>`;
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'Chưa gửi được, bạn thử lại nhé.';
      btn.disabled = false;
      btn.textContent = 'Gửi đánh giá';
    }
  });

  load();
})();
