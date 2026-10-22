# 🤖 HƯỚNG DẪN KỸ THUẬT DÀNH CHO AI AGENT (AGENT HANDBOOK)

> **Dự án**: `hoangminh.com` — Dropship Storefront & Realtime Relay System kết nối `DropBuy.vn`  
> **Repository GitHub**: [https://github.com/capquangfptminhlh/cnlg](https://github.com/capquangfptminhlh/cnlg)  
> **Thư mục làm việc**: `C:\Users\nskka\.gemini\antigravity\scratch\hoangminh-dropbuy-relay`  
> **Backend DropBuy API Clone (Tham chiếu)**: `D:\dropbuy-api`

---

## 🎯 1. BẢN CHẤT DỰ ÁN (WEBSITE NÀY ĐỂ LÀM GÌ?)

Website **`hoangminh.com`** là một sàn thương mại điện tử Dropship tự động hóa 100% theo mô hình **Relay Dropship Thực Tế**:
1. **Không cần ôm hàng**: Toàn bộ 1.321+ sản phẩm trên `hoangminh.com` được đồng bộ trực tiếp từ kho tổng **DropBuy.vn**.
2. **Giá sỉ đại lý F1**: Kết nối tài khoản DropBuy của đại lý Hoàng Minh để lấy giá nhập tốt nhất, sau đó markup % lợi nhuận (mặc định 15%) để niêm yết cho khách lẻ.
3. **Đồng bộ Realtime 5 phút / lần**: Hệ thống daemon tự động quét giá và tồn kho toàn bộ 1.321 SP, phát hiện tăng/giảm giá hoặc hết hàng thì cập nhật tức thì qua WebSocket tới người dùng.
4. **Relay Đơn Hàng & Cấp VietQR 1.5s**:
   - Khi khách hàng đặt đơn trên `hoangminh.com` -> Hệ thống tự động đẩy đơn sang `DropBuy.vn`.
   - Bắt mã **VietQR** thật từ DropBuy (hoặc sinh mã MBBank Napas tương ứng) để khách quét chuyển khoản.
   - Khi nhận tiền -> Kho DropBuy tự động đóng gói, in vận đơn và giao thẳng đến tay khách hàng.

---

## 🏗️ 2. KIẾN TRÚC HỆ THỐNG & CÁC THÀNH PHẦN CỐT LÕI

```
[ Khách hàng trên hoangminh.com ]
             │
     (HTTP & WebSocket)
             ▼
[ Express Server :3000 (server.js) ]
     ├── services/realtimeSync.js       ──(Quét mỗi 5 phút)──> [ DropBuy BFF API ]
     ├── services/dropbuyAuth.js        ──(Login NextAuth)───> [ DropBuy Auth API ]
     ├── services/dropbuyRelay.js       ──(Tự động đặt hàng)─> [ DropBuy Checkout ]
     ├── services/vietqrHelper.js       ──(Sinh mã Napas 24/7)
     └── services/dropbuyDetailScraper  ──(Cào ảnh HD & video)
             │
      (Lưu trữ cục bộ)
             ▼
     data/products.json (1.321 SP) + data/config.json + data/orders.json
```

---

## 📂 3. BẢN ĐỒ CÁC FILE QUAN TRỌNG

| Tệp / Thư mục | Chức năng chính | Agent cần lưu ý |
|---|---|---|
| `server.js` | Điểm khởi chạy Express server (Port 3000) & Socket.IO server. Cung cấp API catalog, cart, orders, admin. | Khi sửa nhớ kiểm tra port và restart an toàn. |
| `services/realtimeSync.js` | Daemon chạy ngầm mỗi 5 phút quét toàn bộ 1.321 SP, so sánh giá/tồn kho, phát event WebSocket `REALTIME_CATALOG_SYNC`. | Đã xử lý `in_stock_mode: 'ALL'` để không sót sản phẩm. |
| `services/dropbuyAuth.js` | Xử lý đăng nhập tài khoản đại lý vào DropBuy qua NextAuth direct POST API (`/api/auth/callback/password-login`), fallback Puppeteer. | Lưu session cookie vào `data/config.json`. |
| `services/dropbuyRelay.js` | Bot Puppeteer tự động đặt hàng trên DropBuy khi khách checkout, lấy mã QR thanh toán. | Hỗ trợ Sandbox Mode khi chưa có tài khoản DropBuy thật. |
| `services/vietqrHelper.js` | Trình tạo mã VietQR chuẩn ngân hàng MBBank/Vietcombank theo chuẩn Napas. | Nội dung CK: `HM{orderId}`. |
| `public/index.html` | Giao diện Storefront chính (Luxury Dark Theme: Deep Navy `#07080f` + Gold `#c9a84c`). | Chứa Hero banner, smart search autocomplete, modal xem nhanh, giỏ hàng drawer, modal VietQR 3 giai đoạn. |
| `public/app.js` | Logic xử lý phía Client storefront: load sản phẩm, phân trang, giỏ hàng, đặt hàng, lắng nghe Socket.IO phòng đơn hàng. | Class thẻ sản phẩm là `.luxury-card`. |
| `public/styles.css` | Toàn bộ CSS Luxury Dark Theme v2.0 cho cả Storefront và Admin Panel. | Tuân thủ biến màu `--bg-base`, `--gold`, `--border-gold`. |
| `public/admin.html` & `admin.js` | Bảng điều khiển quản trị: Đăng nhập tài khoản DropBuy kích hoạt giá sỉ, chỉnh markup %, xem danh sách đơn hàng, kích hoạt quét thủ công. | Đường dẫn: `http://localhost:3000/admin.html`. |
| `data/products.json` | Bộ nhớ đệm danh mục 1.321 sản phẩm DropBuy. | Tuyệt đối không xóa trắng file này. |

---

## ⚡ 4. CÁC QUY TRÌNH KỸ THUẬT CHUẨN KHI LÀM TIẾP

### A. Khởi động server
```bash
# Kiểm tra process node cũ và chạy server
node server.js
```
Server chạy mặc định tại cổng `3000` (URL: `http://localhost:3000`).

### B. Kiểm tra trạng thái đồng bộ
- API kiểm tra daemon: `GET http://localhost:3000/api/realtime/status`
- API danh mục: `GET http://localhost:3000/api/products?limit=24&page=1`
- Trạng thái Auth DropBuy: `GET http://localhost:3000/api/dropbuy/auth-status`

### C. Khi người dùng cung cấp tài khoản DropBuy thật
1. Vào `http://localhost:3000/admin.html`
2. Nhập số điện thoại và mật khẩu DropBuy ở thẻ **"Đăng Nhập DropBuy (Kích Hoạt Giá Sỉ)"**
3. Bấm **"Đăng Nhập & Kích Hoạt Giá Sỉ"** -> Hệ thống sẽ tự lưu token và tự động quét cập nhật 1.321 SP theo giá F1.

---

## ⚠️ 5. CÁC ĐIỀU CẤM KỴ (DÀNH CHO AGENT TIẾP THEO)
1. **CẤM** đổi cấu trúc class CSS nếu chưa kiểm tra `public/app.js` và `public/admin.js` (các element JS render động phụ thuộc vào `.luxury-card`, `.pag-btn`, v.v.).
2. **CẤM** tự ý xóa file `data/products.json` vì đây là cache 1.321 sản phẩm đã được đồng bộ chuẩn từ DropBuy.
3. **CẤM** hardcode mật khẩu, token thật vào mã nguồn (luôn lưu qua `data/config.json` hoặc biến môi trường).
4. Giữ vững phong cách thiết kế **Luxury Dark Theme** (tông nền tối sâu `#07080f` kết hợp viền kim loại vàng `#c9a84c`).

---

## 🔒 6. QUY TẮC BẢO MẬT & THANH TOÁN (cập nhật 19/10/2026 – KHÔNG ĐƯỢC HOÀN TÁC)

1. **API quản trị cần mật khẩu**: `/api/admin/*`, `/api/dropbuy/*`, `/api/realtime/sync-now`, `/api/orders/:id/confirm-payment` đều qua `requireAdmin` (header `x-admin-key`). Mật khẩu = `ADMIN_PASSWORD` trong `.env`, nếu trống server tự sinh và lưu ở `data/admin-secret.json`. `admin.js` dùng `adminFetch()`.
2. **Khách KHÔNG được tự xác nhận thanh toán**: nút "Tôi Đã Chuyển Khoản" gọi `POST /api/orders/:id/report-paid` → trạng thái `PAYMENT_REPORTED`. Chỉ admin xác nhận (`PAID`) sau khi đối soát sao kê. Luồng: `PENDING_PAYMENT → PAYMENT_REPORTED → PAID → PROCESSING → COMPLETED` (hoặc `CANCELLED`).
3. **Giá do server tính**: checkout chỉ nhận `{ id, quantity }`; tên/giá/tổng tiền lấy từ `data/products.json`. Không gửi/tin `price`, `total_amount` từ client.
4. **Không trả giá vốn ra ngoài**: `dropbuy_cost`, `profit_margin`, `public_price` bị lọc bởi `publicProduct()` trong `server.js`.
5. **Không commit dữ liệu vận hành**: `data/config.json` (cookie DropBuy), `data/orders.json` (thông tin khách), `data/admin-secret.json` đã nằm trong `.gitignore`. Cấu hình mẫu: `data/config.example.json`.
6. **Giá sỉ F1**: API `variations/search` của DropBuy chỉ trả `price_public`. Giá đại lý lấy qua `variations/get-price` với `{ variation_id: item.unique_id, product_id }` và cookie đăng nhập (`fetchWholesalePrices` trong `dropbuyScraper.js`). Chưa đăng nhập → giá vốn = giá công khai.
7. **Không bịa số liệu trên giao diện**: không hiển thị "đã bán", sao đánh giá, % giảm giá cố định. Giá gạch ngang chỉ khi giá niêm yết DropBuy cao hơn giá bán; nhãn Mall theo `is_mall`; hết hàng theo `in_stock`.
8. **Bot đặt hàng LIVE trên DropBuy mặc định tắt** (`RELAY_LIVE_BOT=true` mới bật). Form DropBuy cần Tỉnh/Huyện/Xã có cấu trúc trong khi form hoangminh chỉ có địa chỉ dạng chữ, và bot chưa được kiểm thử đầu-cuối (đặt hàng bằng tiền thật). Mặc định: khách trả tiền vào TK của shop, admin đặt đơn trên DropBuy rồi bấm "Đã đặt bên DropBuy".

## ⚡ 7. ĐỒNG BỘ REALTIME & THIẾT LẬP GIÁ (cập nhật 19/10/2026)

- `services/realtimeSync.js` chạy 2 vòng: **tồn kho** mỗi `STOCK_SYNC_SECONDS` (mặc định 30s, 1 lần gọi `variations/in-stock` cho mọi SP ~1,6s) và **giá & catalog** mỗi `PRICE_SYNC_SECONDS` (mặc định 120s, quét `variations/search` + `get-price` khi đã đăng nhập). Lỗi → giãn nhịp lũy thừa tới 10 phút.
- Thay đổi được đẩy qua socket `PRODUCTS_UPDATED` (chỉ các SP đổi); `public/app.js` cập nhật tại chỗ lưới, giỏ hàng, cửa sổ chi tiết. Không tải lại cả trang.
- Đặt hàng: `liveCheck()` tra lại từng SP trên DropBuy theo SKU + in-stock. Giá lệch với giá khách thấy hoặc hết hàng → HTTP 409 kèm dữ liệu mới, frontend cập nhật giỏ và yêu cầu khách xác nhận lại.
- Giá bán = `services/pricing.js` (`computePrice`): giá gốc (CTV/F1 nếu đã đăng nhập, ngược lại giá niêm yết) + % lãi (mặc định / theo danh mục gốc / riêng từng SP hoặc giá cố định), lãi tối thiểu, làm tròn lên, tuỳ chọn không vượt giá niêm yết. Lưu ở `config.pricing`; đổi quy tắc → `repriceNow()` tính lại toàn bộ ngay, không cần gọi DropBuy.
- SP lưu cả `public_price` và `wholesale_price`; mất phiên tạm thời thì giữ `wholesale_price` cũ.
- Admin: mục "Thiết Lập Giá Bán" (`/api/admin/pricing*`) và "Kiểm Tra Kết Nối API DropBuy" (`/api/admin/dropbuy-health`). Dòng lệnh: `npm run test:dropbuy`.

## 🧾 8. BIẾN THỂ, PHÍ SHIP, THANH TOÁN TỰ ĐỘNG (cập nhật 19/10/2026)

- **Biến thể**: `services/variants.js` + `dropbuyDetailScraper` (cache 6h). Dòng giỏ/đơn = SP + `variation_id`; checkout tra trực tiếp SKU biến thể. SP nhiều phân loại (`variant_count !== 1`) luôn mở popup chọn.
- **Phí ship**: `services/shipping.js` (34 tỉnh, phí theo miền + phụ phí kg vượt mức, miễn phí từ ngưỡng). `config.shipping`; API `/api/shipping/provinces`, `/api/shipping/quote`. Tổng đơn & QR đã gồm phí ship.
- **Tự huỷ đơn**: `services/orderExpiry.js` quét mỗi phút, huỷ `PENDING_PAYMENT` quá `config.orders.paymentTimeoutMinutes` (mặc định 30); `PAYMENT_REPORTED` chỉ gắn `needs_attention`.
- **Thanh toán tự động**: `services/payments.js` + webhook `/api/webhooks/sepay` (header `Authorization: Apikey $SEPAY_WEBHOOK_KEY`) và `/api/webhooks/casso` (`secure-token`). Khớp mã đơn `HM[0-9A-F]{8}` trong nội dung CK; đủ tiền → PAID; thiếu/huỷ/không khớp → ghi `data/payments.json` + gắn cờ. Idempotent theo mã giao dịch.
- **Thông báo**: `services/notify.js` (Telegram, tuỳ chọn).
- **Tra cứu đơn**: `GET /api/orders/:id/track?phone=` (bắt buộc đúng SĐT).
- **Test**: `npm test` (node:test, dùng file tạm qua `HM_ORDERS_FILE` / `HM_PAYMENTS_FILE`, không đụng dữ liệu thật). Không chạy `test_relay.js` cũ – nó ghi đơn test vào `data/orders.json` thật.

## 🚚 9. DROPSHIP COD & TỰ ĐẶT ĐƠN DROPBUY (cập nhật 20/10/2026 – KHÔNG ĐƯỢC HOÀN TÁC)
- **Mô hình**: hoangminh.com là vỏ; mọi đơn là đơn **dropship** trên DropBuy. Khách chọn **COD** (shipper thu, `cod_amount` = tổng khách trả) hoặc **chuyển khoản** (`cod_amount` = 0, cần tài khoản ngân hàng thật). Cả hai đều **trừ quỹ DropBuy** của shop (vốn + ship) với `payment_method: "P"`.
- **Xác thực BFF**: cookie KHÔNG đủ. Mọi `/api/proxy/bff/*` cần header `x-foxing-sid` = `user.sid` của `/api/auth/session` → `services/dropbuySession.js` (`ensureSession`, `bff`). Không lưu sid xuống file.
- **Request đặt đơn** (`services/dropbuyOrderFulfillment.js` → `orders/{sid}/normal-submit`, `{sid}` = sid của phiên hiện tại – tuyệt đối không ghi sid cố định vào mã) được chép từ 1 đơn thật đặt trên giao diện DropBuy. Không đoán/đổi trường khi chưa bắt lại request thật. Địa chỉ dùng danh mục 2 cấp của DropBuy (`provinces-v2.json`, `wards-v2.json`, `receiver_district_id = 0`) qua `services/vnAddress.js`.
- **Chốt chặn bắt buộc**: tắt mặc định (`config.autoOrder.enabled`), chặn lỗ, hạn mức/đơn, hạn mức/ngày, số dư quỹ; ghi `SUBMITTING` trước khi gửi; mất mạng sau khi gửi → `SUBMIT_UNKNOWN`, **không tự gửi lại**. Giỏ DropBuy dùng chung → đặt tuần tự, chỉ chọn món của đơn, trả lại giỏ cũ.
- **Test**: `test/autoOrder.test.js` dùng DropBuy giả. Tuyệt đối không test bằng đơn thật trừ khi chủ shop đồng ý và huỷ ngay sau đó.
- **Chế độ hiện tại (22/10/2026, chủ shop chọn): NHÂN VIÊN TỰ ĐẶT ĐƠN.** `config.autoOrder.enabled = false`. DropBuy chỉ dùng để lấy giá sỉ, tồn kho, **phí ship thật** (báo cho khách lúc checkout). Đơn mới → `dropbuy_sync.status = WAITING_STAFF` (không đụng giỏ DropBuy); admin hiện số tiền thu hộ COD, phí ship DropBuy dự kiến, lãi dự kiến, nút "Sao chép thông tin đặt" → nhân viên đặt trên DropBuy → "Đã đặt – nhập mã DropBuy" → hệ thống tự theo dõi giao hàng. Không tự bật lại tự đặt đơn.
