'use strict';
/**
 * Nguồn TechMall (techmall.vn – TechMall Distribution / GEEKTEK JSC), nhà phân phối sỉ phụ kiện công nghệ chạy WooCommerce.
 * Giá vàng trên web = giá đại lý (prices.price), "Giá lẻ đề xuất" màu xanh = giá lẻ.
 * Đơn đại lý dưới 1.000.000 đ bị cộng 5–10% → mặc định cộng 10% vào giá vốn (surchargePercent).
 * Ship theo chính sách khách lẻ của họ: HCM miễn phí từ 200k (dưới: 20k), tỉnh khác miễn phí từ 400k (dưới: 30k).
 */
const { createWooSource } = require('./woo');

module.exports = createWooSource({
  key: 'techmall',
  label: 'TechMall',
  baseUrl: 'https://techmall.vn',
  accountPath: '/tai-khoan/',
  idOffset: 10_000_000,
  rootCategoryName: 'Phụ kiện chính hãng',
  // Ảnh trong API của TechMall là đường dẫn hỏng (404); ảnh thật nằm trên CDN Haravan, đọc từ trang SP
  resolvePageImages: true,
  // Nhãn nội bộ của TechMall, không phải danh mục cho khách
  ignoreCategories: /^(order\b|trading|ngưng sản xuất|sản phẩm bán chạy|hot selling)/i,
  intervalMinutes: 10,
  pricingDefaults: { markupPercent: 25, minProfit: 10000, roundTo: 1000, capAtPublic: true, surchargePercent: 10 },
  shippingDefaults: { hcmFreeFrom: 200000, hcmFee: 20000, otherFreeFrom: 400000, otherFee: 30000 }
});
