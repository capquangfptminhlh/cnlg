# dropbuy-api

Backend clone tương thích bề mặt API `/bff/*` của **dropbuy.vn** (sàn dropship nhiều website con). Đây là bản tự viết hoàn toàn, chạy trên server của bạn. Nó không gọi tới hệ thống của dropbuy.

- **378/378 endpoint** mà frontend dropbuy.vn đang dùng, cộng thêm 7 route phụ trợ (đăng nhập, danh mục, các route Nhanh cho đồng bộ với hai đối tác kia).
- Envelope giống bản gốc: `{ success, error_code, message, data }`, phân trang `{ page_num, page_size, total_records, items }`, cờ `T`/`F`, mã trạng thái 1 ký tự.
- Hỗ trợ cả tiền tố `/api/proxy/bff/*` như FE gốc.

## Chạy

```bash
npm install
cp .env.example .env
npm run db:reset      # tạo SQLite + seed dữ liệu mẫu
npm run dev           # http://localhost:4000
npm test              # 35 test e2e (DB test riêng: test.db)
```

Tài khoản seed (mật khẩu `123456`): `admin` là SA và chủ website gốc, `shopdemo` là chủ shop có kho và 4 sản phẩm, `ctv1` là F1 (aff_code `CTV1AFF`), `khach1` là khách lẻ dưới ctv1.

```bash
curl -X POST localhost:4000/bff/auth/login -H 'content-type: application/json' -d '{"username":"ctv1","password":"123456"}'
# → data.access_token, gửi kèm: Authorization: Bearer <token>
```

Tài liệu API: `GET /openapi.json` (sinh bằng `npm run contract:openapi`). Kiểm tra độ phủ so với contract: `npm run contract:coverage`.

**Postgres:** đổi `provider = "postgresql"` trong `prisma/schema.prisma`, đặt `DATABASE_URL`, rồi chạy `npm run db:push`.

## Cấu trúc

```
prisma/schema.prisma     ~50 bảng: tenant, user, shop, kho, sp/biến thể/tồn, giỏ, đơn, ví, xu, kho ảo, hợp đồng, voucher, flash sale...
src/lib/                 lõi nghiệp vụ dùng chung
  auth.ts                JWT, guard: requireUser / requireShop / requireTenantOwner / requireSA, MFA (TOTP)
  pricing.ts             giá theo người xem: public / F1 / nhóm hoa hồng (F2) / giá tốt / flash sale / hoa hồng website con
  cart.ts                tính giỏ (3 loại giỏ), voucher shop/sàn/ship
  orders.ts              tạo đơn theo kho, máy trạng thái, giữ/xuất/trả tồn, thanh toán – hoàn – tất toán
  balance.ts             sổ cái ví (A khả dụng, L đặt cọc, D ký quỹ, X xu, U điểm uy tín)
  integrations.ts        adapter KiotViet / Nhanh / Pancake
src/modules/             route theo nhóm (account, catalog, cart, orders, shop-orders, marketing, wallet, referral, shop, tenant, admin, integrations)
contract/                contract trích từ dropbuy.vn (xem bên dưới) + openapi.json
test/                    e2e qua fastify.inject, có bài quét gọi toàn bộ route để bắt lỗi 500
```

## Quy tắc nghiệp vụ chính

| Luồng | Cách hoạt động |
|---|---|
| Giá | SA/F1 thấy giá F1. Tài khoản cấp dưới trong nhóm hoa hồng thấy giá F1 × (1 + commission%), có thể đặt riêng theo sản phẩm. Khách thường thấy giá public, hoặc giá F1 nếu tenant bật `public_good_price`. Flash sale được áp nếu rẻ hơn. Website con cộng thêm % hoa hồng của chủ website. |
| Đặt hàng | Mỗi kho xuất là một đơn. Thanh toán bằng `B` ví (trừ ngay), `C` COD, hoặc `Q` QR (đơn ở trạng thái chờ thanh toán). Tạo đơn thì giữ tồn (pending), shop đóng gói xong mới trừ tồn thật. |
| Trạng thái đơn | `W` chờ đóng → `G` đã đóng → `Q` chờ lấy (có vận đơn) → `S` đang giao → `F` đã giao → `D` hoàn thành. Ngoài ra có `C` huỷ, `B` bom, `K` khiếu nại, `X` hoàn hàng, `N` giao thất bại. Chuyển sai luồng trả lỗi `3003`. |
| Tất toán (D) | Shop nhận tiền hàng trừ voucher shop (với đơn aff/CTV thì nhận theo giá gốc F1). Người rải link aff và CTV cấp trên nhận chênh lệch. Đơn dropship/COD trả phần COD dư về ví buyer. Chủ website con nhận hoa hồng. Buyer được +1 điểm uy tín. |
| Huỷ / bom / khiếu nại | Huỷ: hoàn tiền, nhả tồn, trả lượt voucher và suất flash sale. Bom: trả hàng về kho, buyer mất phí ship và bị −5 uy tín. Khiếu nại: shop chấp nhận hoặc SA/chủ website phán xử, kết quả là hoàn hàng + hoàn tiền hoặc hoàn thành đơn. |
| Ví | Mọi biến động đi qua sổ cái (sao kê). Nạp tiền: tạo lệnh kèm QR VietQR, SA xác nhận khi tiền về. Rút tiền: trừ ví ngay, SA duyệt hoặc từ chối (từ chối thì hoàn lại). |
| Xu | Chuyển P2P: xu bị giữ tới khi người nhận xác nhận; có khiếu nại do SA phân xử. Sàn mua bán xu: sổ lệnh, khớp theo giá của lệnh chờ, ký quỹ tiền/xu, khớp một phần được. |
| Kho ảo | Buyer thuê sức chứa (gram × ngày) ở kho shop, rồi mua hàng nhập vào kho ảo (shop duyệt). Hàng này xuất được thành đơn (chỉ trả phí ship) hoặc chuyển cho user khác (xác nhận bằng OTP, có thể kèm tiền). |
| Website con | Mở website (phí setup + phí tháng), chọn sản phẩm hoặc theo dõi shop, đặt hoa hồng %, chọn sản phẩm cho trang chủ, chặn shop, quản lý user và đơn, xem báo cáo R601. |

## Contract được trích như thế nào

FE dropbuy.vn (Next.js) được build kèm một client API do Orval sinh tự động và một bộ **schema Zod** cho mọi request/response, có mô tả tiếng Việt của từng field. `scripts/crawl-chunks.mjs`, `extract-endpoints.mjs` và `schemas.mjs` tải các file JS công khai, dựng lại 378 endpoint (method, path, path/query/body), rồi chuyển Zod sang JSON Schema mà không thực thi code của bên thứ ba (chỉ parse AST).

Hạn chế cần biết:
- Việc ghép schema với từng endpoint là **tự động theo thứ tự + ngữ nghĩa**. Phần lớn khớp, nhưng một số cặp endpoint có hình dạng giống nhau có thể bị ghép lệch. Đã sửa tay trong `contract/overrides.json`. Schema trong `openapi.json` chỉ là tham chiếu; hành vi thật nằm trong `src/modules`.
- Logic phía server của dropbuy **không thể thấy được**. Toàn bộ quy tắc nghiệp vụ ở trên là thiết kế của bản clone, suy ra từ tên endpoint, field, mô tả và label trên UI. Phí, tỉ lệ, luồng duyệt có thể khác hệ thống thật.
- Request body được chấp nhận theo tên field của contract khi đã xác định được. Vài endpoint có contract mơ hồ thì nhận thêm alias (ví dụ `order_id` / `order_ids`), có ghi chú ngay trong code.

## Phần chưa phải "thật"

- **Gửi email** (kích hoạt tài khoản, quên mật khẩu): hiện chỉ ghi log. Ngoài môi trường production, API trả kèm `activation_code` / `reset_token` để test.
- **Vận chuyển:** phí ship tính theo bảng mô phỏng (`src/lib/shipping.ts`), mã vận đơn sinh nội bộ. Trạng thái giao hàng được đồng bộ qua `sa-check-n-force-sync-shipping`, chưa nối API VTP/SPX.
- **Thanh toán QR:** link VietQR là thật (cấu hình `QR_BANK_*`), nhưng xác nhận tiền về vẫn do SA làm tay (`/bff/sa/dw-transactions/mark-confirm/:code`). Chưa có webhook ngân hàng.
- **KiotViet / Nhanh / Pancake:** adapter gọi endpoint công khai của từng bên nhưng **chưa được test với tài khoản thật**. Dùng `INTEGRATION_MOCK=true` để chạy giả lập.
- **Đăng nhập Google** (`gg-auth`) chưa làm.
- Upload ảnh/media chưa có: các field ảnh nhận URL có sẵn.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | Kết nối DB (mặc định SQLite `file:./dev.db`) |
| `JWT_SECRET` | Khoá ký JWT. **Bắt buộc đổi khi deploy** |
| `DEFAULT_TENANT_FX_HASH` | fx_hash của website gốc |
| `QR_BANK_BIN`, `QR_BANK_ACCOUNT`, `QR_BANK_ACCOUNT_NAME`, `QR_BANK_CODE` | Tài khoản nhận tiền nạp |
| `XU_PER_VND` | Hệ số quy đổi khi nạp xu (mặc định 1) |
| `ROOT_DOMAIN` | Tên miền gốc cho website con dạng subdomain |
| `TENANT_SETUP_FEE`, `TENANT_MONTHLY_FEE`, `TENANT_FEE_PER_PRODUCT`, `TENANT_GG_SSO_FEE`, `TENANT_AAP_FEE` | Phí website con |
| `SHOP_REQUIRE_APPROVAL` | `true` thì shop mới đăng ký phải chờ SA duyệt |
| `UPGRADE_F1_MIN_ORDERS` | Số đơn hoàn thành tối thiểu để lên F1 |
| `INTEGRATION_MOCK` | `true` thì giả lập API KiotViet/Nhanh/Pancake |
