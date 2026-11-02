# Taobao → BESI: authorized private staging

This is phase 1 of the Taobao integration in CNLG. It imports only products
accessible via the configured, authorized Taobao Open Platform affiliate
material-search API. It is **not** a full Taobao catalog dump.

## Behavior

- Searches Chinese keywords, follows API pages, upserts by Taobao item ID.
- Keeps original title, optional descriptions, and variant names; if a locally
  installed Ollama model is configured, translates each field to Vietnamese.
- Checks that complete translations contain no Han characters; failures stay
  pending, not published. The affiliate API often does not provide descriptions,
  variants, or reliable stock, so these fields can remain missing.
- Writes to **gitignored private** data/taobao-staging.json, not to TechMall,
  DropBuy, or BESI's sellable product catalog. Partial keyword scans do not
  remove prior staged products.
- Treats Taobao promotional prices in CNY as *reference prices*, not as
  landed supplier costs. No fabricated inventory, shipping, FX rate or checkout.
- Staging has a 25,000-item cap for local JSON safety. Migrate to indexed
  database and workers before expanding to large-volume ingestion.

## Setup

1. Obtain authorized access and data usage rights to the relevant API.
2. Install/start Ollama locally with a Chinese → Vietnamese capable model.
3. Store credentials in the private .env **on the actual server**, never GitHub:

   TAOBAO_APP_KEY=...
   TAOBAO_APP_SECRET=...
   TAOBAO_ADZONE_ID=...
   TAOBAO_DATA_PERMISSION=1
   TAOBAO_LOCAL_MODEL=<installed-model-name>
   TAOBAO_PAGES_PER_KEYWORD=2

4. Run on Windows or Linux:

   npm run sync:taobao:stage -- "手机数据线" "手机充电器" "手机壳"

5. Inspect data/taobao-staging.json privately and review language, rights,
   genuine landed cost, stock, SKU variants, and fulfillment feasibility.

## Not yet done

- No production credentials have been provided or tested.
- No Taobao bulk extraction outside the permissions and search results of
  the official API; no CAPTCHA/session bypass.
- No live product publication, auto-order, international freight quotation,
  tax/customs calculation or automatic Vietnamese pricing at checkout.
- No image downloading or image-text OCR. Image licensing and translation
  overlay require separate rights and implementation.
- No assumption that affiliate material equals merchandise one can resell.

Next phase: build reviewed sourcing contracts + a private indexed database,
translate full detail/variants when supplied by an authorized feed, confirm
landed-cost/availability with partner, then enable sellable products behind
a dedicated fulfillment adapter, with smoke tests before rollout.


## Local, manually reviewed preview publication (separate `/taobao` tab)

Importing alone does NOT make a Taobao item publicly visible or sellable.
After an authorized import and completed Vietnamese translations, the Windows
BESI operator can inspect the private staging data and approve individual
**informational previews** only (no prices, no customer checkout):

```powershell
npm run taobao:review -- list
npm run taobao:review -- approve 123456789012 --rights-confirmed --translation-reviewed --category "Phụ kiện điện thoại"
npm run taobao:review -- revoke 123456789012
```

By approving, the operator explicitly asserts they have the right to republish
the relevant listing information and have manually checked the Vietnamese
translation. An optional approved first-party image under
`/images/taobao/...` may be passed with `--image`; external Taobao image
hotlinks are rejected. Missing images display a placeholder.

Unchanged source titles/descriptions/variants keep their prior preview
approval on subsequent imports. Any change to these fields invalidates
approval and the new content must be translated and reviewed again. This
prevents a sync from silently republishing changed or Chinese content.
Review only one running importer or review command at a time on the
same local JSON file; use a database and transactions for concurrent workers.

The public `GET /api/taobao/products` route is independent from BESI's
normal catalog. It never exposes original Chinese details, Taobao item IDs,
reference CNY prices, supplier URLs or purchase buttons. Preview approval
DOES NOT authorize ordering, payment or international shipping.


## Nhập đầy đủ tiêu đề, mô tả, ngành hàng và phân loại từ feed được cấp quyền

API tìm kiếm vật liệu Taobao chỉ cung cấp các trường thuộc kết quả quảng bá; không nên
tự suy diễn rằng đã có mô tả/biến thể đầy đủ. Khi có dữ liệu xuất hợp lệ từ đối tác
hoặc tài khoản được cấp quyền, sử dụng file **JSON Lines (JSONL)** riêng tư,
mỗi dòng là một sản phẩm:

```json
{"item_id":"123456789012","title_zh":"手机充电线","description_zh":"耐用 100W","category_zh":"手机配件","options_zh":["红色","蓝色"],"price_cny_reference":19.5}
```

Chạy **trên máy chủ** có Ollama và biến `TAOBAO_DATA_PERMISSION=1` trong
`.env`, sau khi xác nhận quyền tái sử dụng feed:

```powershell
npm run taobao:feed -- .\private\products.jsonl --confirm-rights
npm run taobao:review -- list
```

- Tự dịch tiêu đề, mô tả, ngành hàng, tên biến thể sang tiếng Việt. Nếu bất cứ
  phần chữ Hán nào vẫn chưa dịch thì trạng thái vẫn là `pending`.
- Khôi phục bản dịch và phê duyệt preview khi nội dung gốc không đổi;
  đổi tiêu đề/mô tả/ngành hàng/biến thể sẽ bắt kiểm duyệt lại.
- Ghi dữ liệu sau mỗi 100 dòng; nếu file lỗi sau đó, các lô trước vẫn còn.
- Không dùng giá nhân dân tệ của chương trình affiliate làm giá vốn, không
  tự tạo tồn kho/vận chuyển, không đưa sản phẩm vào giỏ hàng.
- Đây là **đường nhập file** từ nguồn đã cấp quyền, không phải chức năng quét
  hoặc sao chép toàn bộ taobao.com; số dòng bị giới hạn 25.000 trong cơ chế
  staging JSON hiện tại. Để có hàng triệu sản phẩm cần CSDL có chỉ mục,
  job hàng đợi, lưu ảnh và thỏa thuận dữ liệu phù hợp.
- Chạy một tác vụ nhập/duyệt tại một thời điểm vì staging JSON không có
  giao dịch đa tiến trình. Không đăng feed hay thông tin nguồn lên GitHub.
