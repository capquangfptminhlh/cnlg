# BESI Taobao Chrome Helper (Windows)

This extension reads checkout freight **only when the operator clicks** after signing in directly on Taobao in Chrome/Edge. It does NOT log into Taobao for them, perform checkout, place orders, pay, bypass captchas or call an undocumented private Taobao API.

1. Download/clone the cnlg repository on the Windows workstation.
2. Open chrome://extensions or edge://extensions, turn on Developer Mode, then Load unpacked from tools/taobao-chrome-extension.
3. Open https://www.taobao.com and log in manually using Taobao’s own UI (QR, password or phone).
4. Choose exactly one item and SKU and, if supported, a Vietnam address. Open the page with Taobao’s delivery fee; do not place an order.
5. Open BESI admin /admin-besi.html#taobao and choose Tạo mã kết nối. This pairing token expires after five minutes and is single-use.
6. With the checkout tab active, click the extension, choose Đọc cước, and review the detected fee. If the amount is ambiguous, read it yourself from Taobao and enter it manually.
7. Enter the matching BESI staged item ID and SKU, destination region, method (direct or consolidated), quote status, amount/currency and confirmations. Paste the pairing code and send.

Security: the Taobao login session stays in Chrome. No cookies, passwords, session tokens, address, full page HTML, screenshots or cart content are sent to BESI. The helper sends only the confirmed numeric freight quote via a one-time bearer token to the approved BESI domain.

Carrier reality: Taobao/Cainiao checkout may not support Vietnam delivery for a particular item or address. In that case mark unavailable. Consolidation may show pending until warehouse weigh-in; do not claim a numeric quote before the warehouse finalizes it. Quoted reference expires in 24 hours and represents one sample address, not a guaranteed price to all of Vietnam.

Extension permissions are limited to the selected tab, Taobao domains and besi.com.vn. This helper is independent of official Taobao authorization or affiliate data permissions.
