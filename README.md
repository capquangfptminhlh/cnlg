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

## 📁 Cấu Trúc Mã Nguồn

```
├── public/                # Giao diện Storefront & Admin (Dark Luxury Theme v2.0)
├── services/              # Các dịch vụ: RealtimeSync 5m, NextAuth, VietQR, Puppeteer Relay
├── data/                  # Cache danh mục 1.321 SP, cấu hình ngân hàng & đơn hàng
├── server.js              # Express Storefront & WebSocket Relay Server (Port 3000)
└── dropbuy-api/           # Trọn bộ Fastify BFF API, Prisma Schema, SQLite dev.db của DropBuy
```

## 📦 Cài đặt & Khởi chạy

### 1. Storefront & Relay System
```bash
npm install
node server.js
```

### 2. DropBuy BFF API (Tùy chọn)
```bash
cd dropbuy-api
npm install
npm run dev
```

Truy cập:
- Cửa hàng Storefront: `http://localhost:3000`
- Bảng điều khiển quản trị: `http://localhost:3000/admin.html`

---

## 🚀 Triển khai thật (để khách đặt hàng & ngân hàng gọi webhook)

### 0. Cấu hình bắt buộc
1. `copy .env.example .env` rồi điền:
   - `ADMIN_PASSWORD` – mật khẩu vào `/admin.html`
   - `SEPAY_WEBHOOK_KEY` (hoặc `CASSO_SECURE_TOKEN`) – tự xác nhận tiền về
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` – nhận thông báo đơn (tuỳ chọn)
   - `TRUST_PROXY=1` nếu chạy sau nginx / Caddy / Cloudflare
2. Vào **Admin → Cấu hình VietQR**: nhập **đúng số tài khoản nhận tiền của bạn** (không để số mẫu).
3. Vào **Admin → Đăng nhập DropBuy** để lấy giá CTV; **Thiết lập giá bán**, **Phí vận chuyển** theo ý bạn.

### 1. Windows (máy bàn / máy chủ Windows)
Nhấp đúp `start.bat` – tự cài thư viện, chạy server, tự khởi động lại nếu bị dừng.

### 2. VPS Linux với PM2
```bash
npm ci --omit=dev
npm i -g pm2
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

### 3. Docker
```bash
docker compose up -d --build     # dữ liệu nằm ở ./data (gắn volume)
```

### 4. Có tên miền + HTTPS
- **Caddy** (tự cấp SSL): file `Caddyfile`
  ```
  hoangminh.com {
    reverse_proxy 127.0.0.1:3000
  }
  ```
- Hoặc **Cloudflare Tunnel** khi chạy trên máy ở nhà (không cần mở port):
  `cloudflared tunnel --url http://localhost:3000` (dùng tunnel có tên + DNS cho tên miền thật).

Sau khi có tên miền, đặt URL webhook ở SePay/Casso: `https://<tên-miền>/api/webhooks/sepay` (hoặc `/casso`).
Kiểm tra sống: `https://<tên-miền>/healthz`. Kiểm tra API DropBuy: `npm run test:dropbuy`. Kiểm thử: `npm test`.

### Quy trình 1 đơn hàng
1. Khách chọn SP + phân loại → nhập địa chỉ, tỉnh → nhận mã VietQR (tổng đã gồm phí ship).
2. Tiền về → SePay/Casso gọi webhook → đơn tự sang **Đã thanh toán** (+ báo Telegram). Không có webhook thì admin bấm **Xác Nhận Đã Nhận Tiền** sau khi đối soát.
3. Admin bấm **Đưa vào giỏ DropBuy** (tự thêm đúng phân loại & số lượng vào giỏ tài khoản DropBuy, đồng thời sao chép thông tin người nhận) → mở dropbuy.vn/gio-hang, đặt giao tới khách.
4. Bấm **Đã đặt bên DropBuy** → **Đã giao xong**. Khách theo dõi ở **Tra Cứu Đơn Hàng**.
5. Đơn không thanh toán quá hạn (mặc định 30 phút) tự huỷ.
