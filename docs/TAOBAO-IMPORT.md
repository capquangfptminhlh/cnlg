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


## Đồng bộ tỷ giá CNY → VNĐ và phí vận chuyển Taobao (tham khảo)

- Tỷ giá lấy từ [ExchangeRate-API Open Access](https://www.exchangerate-api.com/docs/free),
  cập nhật **mỗi ngày** (theo nguồn), cache tại data/taobao-fx.json và ghi nguồn
  cùng thời điểm công bố. Máy chủ tự kiểm tra mỗi 12 giờ; không gọi API ở mỗi
  lần khách mở trang. Có thể làm mới thủ công bằng lệnh:

  ```powershell
  npm run taobao:fx
  ```

  Không dùng tỷ giá cố định/hardcode. Khi nguồn không cập nhật, tỷ giá quá 48h
  hoặc API lỗi: không hiện ước tính mới. Tỷ giá thị trường có thể khác mức
  thanh toán của dịch vụ mua hộ, vì vậy đây chỉ là **giá tham khảo**.

- Cần **biểu phí logistics thật** được đối tác cung cấp: lưu riêng ở
  data/taobao-shipping.json. Sao chép
  docs/TAOBAO-SHIPPING.template.json vào data/taobao-shipping.json, sau đó
  điền các giá trị thực tế với timestamp ISO và nhà vận chuyển đã xác minh.
  Các trường bắt buộc: `international_vnd_per_kg`, `billing_step_kg`,
  `volumetric_divisor`, `handling_vnd`, ba mức phí giao nội địa VN
  `domestic_vnd.hcm`, `domestic_vnd.hn`, `domestic_vnd.other`,
  `provider`, `updated_at`, `route: "CN-VN"`, `currency: "VND"`.
  Biểu phí quá 90 ngày không được dùng. Chưa có cước do đối tác cung cấp thì
  **không hiển thị tổng giá/ship**.

- Với mỗi sản phẩm, feed được cấp quyền cần thêm:
  `shipping_weight_kg` (cân nặng thực tế tính theo kg),
  `dimensions_cm` là object `{length,width,height}` tính bằng cm, và
  `china_domestic_shipping_cny` là cước vận chuyển từ shop Trung Quốc tới
  kho nhận hàng, bằng `0` **chỉ nếu người bán xác nhận miễn phí**.
  Taobao Affiliate API không được giả định có các dữ liệu này.

- Công thức:
  `Giá hàng VNĐ = giá Taobao CNY × tỷ giá tham khảo`.
  `Khối lượng tính cước = làm tròn lên theo billing_step_kg của
  max(cân nặng thực, Dài×Rộng×Cao/volumetric_divisor)`.
  `Ship VNĐ = ship nội địa TQ CNY × tỷ giá + khối lượng tính cước × đơn giá
  vận chuyển CN-VN/kg + giao nội địa Việt Nam theo vùng + phí xử lý`.
  `Tổng tạm tính = giá hàng quy đổi + ship VNĐ`.
  Giá vốn thực tế/chiết khấu, thuế nhập khẩu và VAT **không có** nếu chưa
  được xác minh; kết quả luôn ghi chú chưa gồm thuế/phí phát sinh.
  Nếu thiếu kích thước kiện hàng, KHÔNG hiển thị tổng phí ship vì cước thể tích có thể làm chi phí tăng.

- Tab riêng /taobao có lựa chọn giao TP.HCM, Hà Nội hoặc tỉnh khác.
  API /api/taobao/products trả breakdown VNĐ chỉ cho preview đã được
  dịch và kiểm duyệt; vẫn không có checkout, thanh toán, giá nguồn CNY hay
  định danh nhà cung cấp. Không trộn vào TechMall/DropBuy.
  Đồng bộ giá từ Taobao chỉ thực hiện khi có API/feed được cấp quyền và
  job sync nhập lại dữ liệu; bộ tỷ giá cập nhật độc lập.



## Đồng bộ giá Taobao từ dữ liệu được cấp quyền

Chỉ khi server có API Taobao đủ quyền và được phép dùng dữ liệu, đặt trong `.env`:

```dotenv
TAOBAO_AUTO_SYNC=1
TAOBAO_DATA_PERMISSION=1
TAOBAO_APP_KEY=...
TAOBAO_APP_SECRET=...
TAOBAO_ADZONE_ID=...
TAOBAO_AUTO_SYNC_KEYWORDS=手机充电线;手机壳;背包
TAOBAO_PAGES_PER_KEYWORD=2
TAOBAO_SYNC_INTERVAL_HOURS=12
TAOBAO_FX_AUTO_REFRESH=1
```

- Tự quét danh mục/giá CNY **trong giới hạn API đã được cấp**, tối đa một
  lượt đang chạy tại một thời điểm. Không vượt CAPTCHA, không sao chép toàn sàn.
- Giá CNY mới được cập nhật trong staging khi bên nguồn đổi giá, không cần
  dịch lại nội dung nếu tên, mô tả, ngành hàng và biến thể không đổi.
- Khi khách mở tab Taobao, giá tham khảo VNĐ được **tính lại từ snapshot
  tỷ giá còn hạn** và biểu phí logistics hiện có; không ghi giá CNY cố định
  sang catalog BESI đang bán.
- Nếu không có APP KEY/APP SECRET/ADZONE_ID, hoặc chưa xác nhận quyền dữ
  liệu, job tự đồng bộ sản phẩm **không chạy**, không làm ảnh hưởng website.
- Tỷ giá FX có thể tự refresh độc lập kể cả khi không có sản phẩm Taobao.
- Để tự cập nhật từ nguồn dữ liệu đối tác khác, cần tích hợp đúng API/feed
  được quyền sử dụng; command `npm run taobao:feed -- ... --confirm-rights`
  hiện chỉ nhận file, chưa chạy theo lịch tự động.


## Hoàn thiện code vận hành: SKU, đồng bộ an toàn, trạng thái & thời hạn giá

Đường nhập dữ liệu được cấp quyền hỗ trợ tùy chọn `sku_variants` cho giá và
đóng gói **từng biến thể**, không lấy giá ưu đãi thấp nhất làm giá mọi SKU.
Ví dụ một dòng JSONL (dữ liệu minh họa, KHÔNG phải hàng thật):

```json
{"item_id":"123456789012","title_zh":"手机数据线","description_zh":"快充 数据线","category_zh":"手机配件","sku_variants":[{"sku":"SKU-RED-1M","label_zh":"红色 1米","price_cny":18.5,"shipping_weight_kg":0.2,"china_domestic_shipping_cny":0,"dimensions_cm":{"length":20,"width":15,"height":8}},{"sku":"SKU-BLUE-2M","label_zh":"蓝色 2米","price_cny":23,"shipping_weight_kg":0.3,"china_domestic_shipping_cny":2,"dimensions_cm":{"length":24,"width":20,"height":8}}]}
```

- Nếu có SKU, model Ollama dịch `label_zh` qua `options_vi`; chỉ hiển thị
  biến thể sau khi kiểm duyệt bằng `taobao:review`. Mỗi biến thể có giá VNĐ
  và tổng phí vận chuyển tính riêng, chỉ hiện thông tin đã đủ cơ sở.
- Lượt làm mới API affiliate chỉ chứa giá sản phẩm và thiếu mô tả, cân nặng,
  cước TQ hay biến thể sẽ **không xóa dữ liệu được cấp quyền từ feed** nếu
  tiêu đề nguồn không đổi. Nếu tên nguồn thay đổi, phần duyệt bị hủy.
- Giá sản phẩm trong kho chờ quá **7 ngày** mà không được làm mới sẽ không
  được báo giá, dù tỷ giá CNY/VND còn mới.
- Chạy một quy trình ghi vào `data/taobao-staging.json` tại một thời điểm.
  Khoá `*.write.lock` ngăn đồng bộ, nhập file và duyệt hàng ghi đè nhau.
  Nếu tác vụ bị crash khiến khoá còn lại, **chỉ xóa thủ công sau khi đã
  xác minh không còn tác vụ nhập/duyệt nào chạy**. Không tự phá khóa.
- Lệnh quản trị chỉ chạy trong terminal nội bộ, không có API public:

```powershell
npm run taobao:ops -- status
npm run taobao:ops -- fx:refresh
npm run taobao:ops -- tariff:set .\private\carrier.json --confirm-carrier
```

  `status` chỉ trả về số lượng, trạng thái FX/tariff và số SKU đủ dữ liệu,
  không in token API hay mã nguồn hàng. `tariff:set` chỉ chấp nhận biểu phí
  thật có nguồn và ngày cập nhật còn hạn theo schema từ
  `docs/TAOBAO-SHIPPING.template.json`. Dữ liệu runtime nằm trong `data/`,
  tuyệt đối không commit.

**Giới hạn vận hành còn lại:** không thể tự tạo API keys, tự biết cân nặng
hay giá mua hộ/thuế quan khi đối tác không cung cấp. Tính giá preview không
đồng nghĩa hệ thống thanh toán/đặt hàng Taobao đã được phép hoạt động. Kho
staging JSON hiện giới hạn 25.000 item; đồng bộ hàng triệu item cần DB có chỉ
mục và phân trang server trước khi mở rộng.
