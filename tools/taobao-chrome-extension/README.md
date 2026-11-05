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


## Catalog and inventory sync from your own Chrome session (v0.2)

The extension now has a separate **Đồng bộ danh mục & tồn kho** mode.
It does **not** require an official Taobao API key because it records
information already visible on web pages you deliberately visit.

1. Update BESI Windows server from the latest GitHub main before use.
2. In Chrome extensions, reload the **BESI Taobao** extension from
   `tools/taobao-chrome-extension` (v0.2+).
3. Log in to Taobao in Chrome **using Taobao's own login page**.
4. In authenticated BESI admin `/admin-besi.html#taobao`, click
   **Tạo mã đồng bộ**, then copy the 20-minute code. This token authorizes
   importing a bounded number of product observations to BESI, and can be
   revoked instantly from admin. It is separate from the 5-minute
   one-use shipping quote pairing token.
5. Open the extension, paste this catalog pairing code, check the explicit
   rights statement, then select **Bật đồng bộ trong 20 phút**.
6. Visit Taobao search/category and product detail pages normally. As each
   page is loaded, the extension will examine *visible* product labels
   and at most 30 item links per page. Use **Quét ngay trang Taobao đang mở**
   to request an immediate scan. To collect more, **navigate to the next
   page yourself**; this extension will not automatically traverse the
   site or bypass CAPTCHA/login checks.
7. BESI holds imported titles and CNY reference prices in the **separate
   private Taobao staging area**, not BESI checkout. The review queue shows
   inventory observations; missing or >2-hour-old observations become
   **Tồn kho chưa xác minh**.
8. Click **Dừng đồng bộ** in Chrome and/or **Thu hồi mã** in BESI admin.
   Chrome's access token is stored only in ephemeral extension session
   memory and is cleared on restart.

The extension sends no cookies, passwords, OTPs, street address, page HTML
or shopping-cart contents. It sends only product ID/title/link, explicitly
observed CNY price and inventory-status signals with a timestamp. **Exact
inventory counts are never guessed**: only a numeric "库存 / 剩余" label on a
visible product-detail page qualifies; listings normally report only
in-stock, out-of-stock, or unknown.

### Important limitations

This implements an operator-initiated browser **capture connector**, not
a bulk downloader for the full Taobao marketplace. Taobao is a large,
dynamic third-party site; some page layouts may expose no product/price/stock
data and authenticated pages may require manual verification. The tool must
not circumvent access controls or site restrictions. Permission to sign in
as a buyer does not by itself grant unrestricted rights to reuse seller
photographs/descriptions or republish products. All captured products remain
non-purchasable and need translation and rights review before public preview.
The existing private JSON staging store still has a **25,000-item cap**.
