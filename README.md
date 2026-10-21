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

## 🚀 Triển khai thật (khách ngoài Internet đặt được hàng)

Mô hình hiện tại: khách trả **COD**, hệ thống tự đặt đơn **dropship** trên DropBuy và trừ quỹ DropBuy của shop
(xem `AGENT_INSTRUCTIONS.md` mục 9). Không cần tài khoản ngân hàng hay webhook nếu chỉ bán COD.

### 0. Cấu hình (`copy .env.example .env`)
| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `ADMIN_PASSWORD` | **Có** khi lên mạng | Mật khẩu `/admin.html` – đặt chuỗi dài, khó đoán |
| `PUBLIC_BASE_URL` | Có | `https://ten-mien-cua-ban` – dùng cho link chia sẻ, sitemap, ảnh xem trước |
| `TRUST_PROXY=1` | **Có** khi chạy sau Cloudflare / nginx / Caddy | Để giới hạn tần suất & khoá admin tính theo IP thật của khách, không phải IP của proxy |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Nên có | Báo đơn mới, đơn chưa đặt được, phiên DropBuy, quỹ thấp |
| `DROPBUY_CRED_KEY` | Tuỳ chọn | Khoá mã hoá tài khoản DropBuy đã lưu (64 ký tự hex). Bỏ trống = tự sinh `data/cred.key` |
| `SEPAY_WEBHOOK_KEY` / `CASSO_SECURE_TOKEN` | Chỉ khi bật chuyển khoản | Tự xác nhận tiền về |

Trong admin: **Đăng nhập DropBuy** (tick *Ghi nhớ* để tự đăng nhập lại), kiểm tra **Tự Đặt Đơn** (hạn mức, quỹ),
**Thiết lập giá bán**, **Phí vận chuyển** (mặc định lấy phí thật của DropBuy).

### 1. Chạy trên máy Windows này
- `start.bat`: tự cài thư viện, chạy server, tự bật lại khi lỗi, ghi log `data/server.log`. Mở 2 lần cũng chỉ có 1 server.
- Tự chạy khi đăng nhập Windows: lối tắt `HoangMinhStore.cmd` trong thư mục Startup (`shell:startup`). Xoá file đó để tắt.
- Máy phải bật và không ngủ thì cửa hàng mới hoạt động (đặt Power Options → Sleep: Never).

### 2. Đưa lên tên miền bằng Cloudflare Tunnel (không cần mở port, có HTTPS)
Máy này đã có tunnel `14e73d28-…` (đang phục vụ lhmcrm.com). Thêm cửa hàng vào **cùng tunnel** đó:
1. Sửa `C:\Users\<bạn>\.cloudflared\config.yml`, thêm 1 dòng hostname **trước** dòng `http_status:404`:
   ```yaml
   ingress:
     - hostname: lhmcrm.com
       service: http://localhost:9876
     - hostname: app.lhmcrm.com
       service: http://localhost:9876
     - hostname: shop.ten-mien.com        # ← thêm
       service: http://localhost:3000     # ← thêm
     - service: http_status:404
   ```
2. Tạo DNS cho hostname (tên miền phải nằm trên Cloudflare):
   `cloudflared tunnel route dns 14e73d28-8efa-4769-acdf-c19cf12294b8 shop.ten-mien.com`
3. Khởi động lại tunnel (lối tắt `LHM-AutoStart-Server-Tunnel` hoặc dịch vụ cloudflared).
4. Đặt `.env`: `PUBLIC_BASE_URL=https://shop.ten-mien.com`, `TRUST_PROXY=1`, `ADMIN_PASSWORD=...` → chạy lại `start.bat`.
5. Kiểm tra: `https://shop.ten-mien.com/healthz`, đặt thử 1 đơn COD rồi huỷ trong admin.
Khuyên dùng: bật **Cloudflare Access** cho đường dẫn `/admin.html` và `/api/admin/*` (chỉ email của bạn vào được).

### 3. VPS Linux (máy chủ thuê, chạy 24/7)
```bash
npm ci --omit=dev
npm i -g pm2
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```
Hoặc `docker compose up -d --build` (dữ liệu ở `./data`). Đặt HTTPS bằng Caddy:
```
shop.ten-mien.com {
  reverse_proxy 127.0.0.1:3000
}
```
Chép cả thư mục `data/` (config, orders, cred.key, dropbuy-cred.json) sang VPS nếu chuyển máy.

Kiểm tra API DropBuy: `npm run test:dropbuy`. Kiểm thử: `npm test`.

### Quy trình 1 đơn hàng
1. Khách chọn SP + phân loại → nhập địa chỉ, tỉnh → nhận mã VietQR (tổng đã gồm phí ship).
2. Tiền về → SePay/Casso gọi webhook → đơn tự sang **Đã thanh toán** (+ báo Telegram). Không có webhook thì admin bấm **Xác Nhận Đã Nhận Tiền** sau khi đối soát.
3. Admin bấm **Đưa vào giỏ DropBuy** (tự thêm đúng phân loại & số lượng vào giỏ tài khoản DropBuy, đồng thời sao chép thông tin người nhận) → mở dropbuy.vn/gio-hang, đặt giao tới khách.
4. Bấm **Đã đặt bên DropBuy** → **Đã giao xong**. Khách theo dõi ở **Tra Cứu Đơn Hàng**.
5. Đơn không thanh toán quá hạn (mặc định 30 phút) tự huỷ.
