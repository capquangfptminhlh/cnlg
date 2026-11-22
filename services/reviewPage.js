'use strict';
/**
 * Trang /danh-gia/<mã đơn>?k=<vé đơn>: khách chấm sao + viết nhận xét cho từng SP trong đơn đã giao.
 * Trang chỉ là khung; dữ liệu lấy qua /api/reviews/order/:id (cần đúng vé) bằng public/review.js.
 * noindex: trang riêng của từng đơn, không cho Google lập chỉ mục.
 */
const { esc } = require('./seoPages');

function renderReviewPage({ orderId, assetVersion = '' }) {
  const v = assetVersion ? `?${assetVersion}` : '';
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Đánh giá đơn hàng ${esc(orderId)} | BESI</title>
  <meta name="robots" content="noindex, nofollow">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link rel="stylesheet" href="/seo-ssr.css${v}">
  <script defer src="/review.js${v}"></script>
</head>
<body class="info-body">
  <header class="info-top">
    <div class="info-wrap">
      <a class="info-logo" href="/" aria-label="BESI – Trang chủ"><b>be</b><span>si.</span></a>
      <nav aria-label="Điều hướng"><a href="/">Mua sắm</a><a href="/?tra-cuu=1">Theo dõi đơn</a><a href="/lien-he">Liên hệ</a></nav>
    </div>
  </header>
  <main class="info-wrap info-main review-main">
    <article class="info-article" id="reviewApp" data-order="${esc(orderId)}">
      <h1>Đánh giá đơn hàng #${esc(orderId)}</h1>
      <p id="reviewIntro">Đang tải sản phẩm trong đơn…</p>
      <form id="reviewForm" hidden novalidate></form>
      <div id="reviewDone" class="info-lead" hidden></div>
    </article>
  </main>
</body>
</html>`;
}

module.exports = { renderReviewPage };
