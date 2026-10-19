# HOANGMINH.COM x DROPBUY.VN REALTIME DROPSHIP RELAY SYSTEM

Hệ thống kết nối tự động hóa toàn diện giữa **hoangminh.com** và kho sỉ **DropBuy.vn**, hỗ trợ đồng bộ giá sỉ, tồn kho Realtime, thanh toán VietQR Napas 24/7 và chuyển đơn tự động.

## 🚀 Tính năng nổi bật

1. **Đồng bộ 100% Danh Mục Kho Tổng**: Tự động nạp 1.321+ sản phẩm kèm album ảnh HD, video thực tế và thông số kỹ thuật chi tiết.
2. **Daemon Đồng Bộ Realtime**: Quét liên tục 5 phút / lần toàn bộ giá và tồn kho; bắn thông báo biến động giá qua WebSocket tới khách hàng.
3. **Kích Hoạt Giá Sỉ Đại Lý F1**: Đăng nhập trực tiếp DropBuy API để lấy biểu giá sỉ ưu đãi nhất cho đại lý.
4. **Relay Đơn Hàng & Cấp VietQR 1.5s**: Khách đặt hàng nhận ngay mã VietQR chuẩn Napas 24/7, tự động cập nhật trạng thái khi thanh toán thành công.
5. **Giao Diện Dark Luxury Theme v2.0**: Thiết kế tông màu Deep Navy & Gold cao cấp, tối ưu tốc độ tải trang và trải nghiệm người dùng.

---

## 🤖 Dành Cho Nhà Phát Triển & AI Agent Tiếp Theo
👉 Xem chi tiết toàn bộ kiến trúc, luồng xử lý và quy tắc kỹ thuật tại file [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md).

## 📦 Cài đặt & Khởi chạy

```bash
# 1. Cài đặt thư viện
npm install

# 2. Khởi chạy máy chủ
npm start
# hoặc
node server.js
```

Truy cập:
- Cửa hàng Storefront: `http://localhost:3000`
- Bảng điều khiển quản trị: `http://localhost:3000/admin.html`
