# Chuyển cửa hàng sang máy chủ riêng (Windows)

Cửa hàng (besi.com.vn) là một chương trình Node chạy liên tục: nhận đơn, đồng bộ giá/tồn kho DropBuy,
tính phí ship. Khách vào qua **Cloudflare Tunnel** `hoangminh-store` – máy chủ không cần IP tĩnh hay mở cổng modem.

## A. Bạn chuẩn bị máy chủ (làm tay, một lần)

1. **Nguồn & khởi động**
   - Cắm điện qua bộ lưu điện (UPS) nếu có, cắm dây mạng LAN.
   - Vào BIOS bật **Restore on AC Power Loss = Power On** (có điện lại là máy tự bật). Tên mục khác nhau theo hãng: "AC Recovery", "After Power Loss".
   - Windows Update → **Active hours** đặt 6:00–23:00 để máy không tự khởi động lại giữa ngày.
2. **Cài phần mềm**
   - Node.js bản **LTS** (https://nodejs.org) – để mặc định khi cài.
   - Git for Windows (https://git-scm.com).
   - Ứng dụng **Claude** (để mở phiên Claude Code làm phần còn lại), đăng nhập tài khoản của bạn.
3. **Lấy mã nguồn** (repo riêng tư – Git sẽ mở trình duyệt để bạn đăng nhập GitHub):
   ```
   git clone https://github.com/capquangfptminhlh/cnlg.git C:\HoangMinh
   ```
   Thư mục nên ngắn, không dấu, không nằm trong OneDrive.

Không cần chỉnh chế độ ngủ bằng tay – script cài đặt tự đặt "không bao giờ ngủ".

## B. Cài thử trước (chưa nhận khách)

Mở PowerShell **Run as administrator**:
```
cd C:\HoangMinh
powershell -ExecutionPolicy Bypass -File scripts\install-server-windows.ps1
```
Chỉ cài thư viện + chạy test. Máy cũ vẫn bán bình thường.

## C. Chuyển thật (~10 phút, nên làm lúc vắng khách)

1. **Máy cũ** – tắt cửa hàng + đóng gói dữ liệu (PowerShell, trong thư mục cửa hàng):
   ```
   powershell -ExecutionPolicy Bypass -File scripts\export-server-bundle.ps1 -StopOld
   ```
   Ra file `HoangMinh-chuyen-may-<ngày giờ>.zip` trên Desktop: đơn hàng, cấu hình giá, tài khoản DropBuy
   (đã mã hoá + khoá), mật khẩu admin, khoá tunnel. **Chỉ chép bằng USB / mạng nội bộ – không gửi qua chat, email, GitHub.**

   > `-StopOld` là bắt buộc: hai máy cùng chạy tunnel thì Cloudflare chia khách cho cả hai → đơn bị tách hai nơi.

2. **Máy chủ** – PowerShell **Run as administrator**:
   ```
   cd C:\HoangMinh
   powershell -ExecutionPolicy Bypass -File scripts\install-server-windows.ps1 -Bundle D:\HoangMinh-chuyen-may-xxxx.zip
   ```
   Script: bung dữ liệu → đặt máy không ngủ → tạo 2 tác vụ **HoangMinh Store** và **HoangMinh Tunnel**
   chạy khi **bật máy** (tài khoản SYSTEM, không cần ai đăng nhập Windows) → bật và kiểm tra.

3. **Kiểm tra**
   - Điện thoại dùng 4G (không dùng Wi‑Fi nhà) mở https://besi.com.vn: xem sản phẩm, giỏ, phí ship.
   - Vào `https://besi.com.vn/admin.html` (mật khẩu admin như cũ): DropBuy còn "Đã kết nối", đơn cũ còn đủ.
     Nếu DropBuy đòi đăng nhập lại: nhập lại mật khẩu DropBuy trong admin (tick "Ghi nhớ").
   - Khởi động lại máy chủ một lần → sau ~1 phút besi.com.vn tự chạy lại.
4. Xoá file zip trên USB và Desktop máy cũ.

## Quay lại máy cũ (nếu máy chủ trục trặc)

Trên máy chủ: `Disable-ScheduledTask -TaskName 'HoangMinh Store','HoangMinh Tunnel'` rồi tắt máy chủ.
Trên máy cũ: đổi tên `HoangMinhStore.cmd.da-chuyen-may` trong thư mục Startup về `HoangMinhStore.cmd` và chạy nó.
(Đơn phát sinh trên máy chủ trong lúc đó cần chép `data\orders.json` về – gói lại bằng `export-server-bundle.ps1`.)

## Vận hành hằng ngày

| Việc | Ở đâu |
|---|---|
| Nhật ký cửa hàng | `data\server.log` |
| Nhật ký tunnel | `data\tunnel.log` |
| Tắt / bật | Task Scheduler → `HoangMinh Store`, `HoangMinh Tunnel` |
| Cập nhật mã mới | tự động mỗi 5 phút (mục dưới); nhật ký `data\update.log` |
| Sao lưu | tự động trong `data\backups\` (nên chép ra USB / ổ khác định kỳ) |

## Tự cập nhật mã nguồn từ GitHub (bật một lần)

Tác vụ **HoangMinh Update** chạy mỗi 5 phút: có bản mới trên `main` → lấy về → chạy test →
test đạt mới khởi động lại cửa hàng (gián đoạn vài giây) → cửa hàng không lên thì tự quay về bản cũ.
Test hỏng thì giữ nguyên bản đang chạy và không thử lại bản đó. Danh mục đang bán (`data\products.json`) luôn được giữ.

1. Trên máy chủ, PowerShell **Run as administrator**:
   ```
   cd C:\HoangMinh
   git pull
   powershell -ExecutionPolicy Bypass -File scripts\enable-auto-update.ps1
   ```
2. Script in ra **khoá công khai** (một dòng `ssh-ed25519 …`). Gửi dòng đó cho người quản trị repo để thêm vào
   GitHub → repo `cnlg` → Settings → Deploy keys, **không** tick "Allow write access" (chỉ đọc).
   Không gửi file `data\deploy\id_ed25519` (khoá riêng).
3. Sau tối đa 5 phút, `data\update.log` có dòng đầu tiên khi có bản mới.

Tắt tự cập nhật: `Disable-ScheduledTask -TaskName 'HoangMinh Update'`.
