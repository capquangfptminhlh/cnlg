# Quy chuẩn phát triển HoangMinh Store

## 1. Tự động lưu & đẩy mã nguồn lên GitHub (Bắt buộc)
- Sau khi hoàn thành bất kỳ chỉnh sửa, sửa lỗi (bugfix) hoặc cập nhật tính năng nào, agent **bắt buộc phải tự động**:
  1. Chạy bộ kiểm thử để bảo đảm hệ thống không lỗi (`npm test` và `npm run test:ui`).
  2. Gom các file mã nguồn đã chỉnh sửa (chỉ `git add` các file code/css/html/js liên quan).
  3. Tạo commit với nội dung rõ ràng, chuẩn Conventional Commits.
  4. Đẩy thẳng lên GitHub (`git push origin main`) ngay lập tức, không đợi nhắc nhở.

## 2. Bảo mật & Quy tắc Commit
- **TUYỆT ĐỐI KHÔNG** commit các file dữ liệu runtime hoặc bí mật:
  - Thư mục `data/` (`data/products.json`, `data/techmall_products.json`, `data/orders.json`, `data/zalo-bot.json`, ...)
  - File môi trường `.env` hoặc các tệp cấu hình chứa API key / token bí mật.
- Luôn tuân thủ cơ chế chống lộ nguồn hàng (Anti-Leak):
  - Không lộ tên nhà cung cấp, URL nguồn sỉ ra frontend, robots.txt, CDN công khai.
  - Luôn đi qua proxy ảnh `/cdn` nội bộ của cửa hàng.
