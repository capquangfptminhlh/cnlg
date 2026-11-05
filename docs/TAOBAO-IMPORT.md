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


## Quản trị Taobao ngay trong BESI Supplier Hub

Đăng nhập BESI admin, sau đó mở `/admin-besi.html#taobao`:

- Xem số hàng Taobao đã nhập, đã duyệt, SKU đủ giá và có thể báo cước,
  trạng thái tỷ giá và biểu phí. Không tiết lộ API key qua trình duyệt.
- Tìm kiếm và phân trang danh sách hàng chờ dịch / chờ duyệt / đã duyệt.
  Chỉ cho phép **duyệt giới thiệu** khi đánh dấu cả quyền sử dụng nội dung
  và xác nhận đã kiểm tra bản dịch tiếng Việt.
- Thu hồi ngay preview không phù hợp (không ảnh hưởng hàng BESI/TechMall/DropBuy).
- Làm mới tỷ giá, lưu biểu phí JSON có ngày hiệu lực và xác nhận từ đối tác,
  hoặc kích hoạt đồng bộ API Taobao đã cấp quyền. Nếu thiếu quyền, API key,
  từ khóa, bộ xử lý sẽ từ chối và nút tương ứng bị vô hiệu.
- Không có nút mua hàng, thanh toán hay tự gửi đơn Taobao trên giao diện quản trị
  này. Chỉ API có `requireAdmin` và giới hạn tần suất mới cho phép thay đổi.
- Các thao tác nhập số lượng lớn qua JSONL vẫn dùng terminal nội bộ
  `npm run taobao:feed`, không upload hàng loạt dữ liệu nguồn lên browser.
- Ảnh sản phẩm vẫn phải là tài sản BESI được cấp quyền nằm trong
  `public/images/taobao/`; có thể chọn ảnh này khi duyệt. Không hotlink
  ảnh/sao chép nội dung từ người bán khi chưa có quyền tái sử dụng.


## Tải ảnh được cấp quyền lên BESI (không hotlink)

Trong `/admin-besi.html#taobao`, chọn một sản phẩm cần duyệt:

1. Đánh dấu đã có **quyền sử dụng nội dung và ảnh**.
2. Chọn file ảnh JPEG, PNG hoặc WebP hợp lệ **tối đa 3 MB** ngay trên máy
   quản trị, nhấn **Tải ảnh lên kho BESI**.
3. Backend đòi phiên admin hợp lệ + quyền đã xác nhận, kiểm tra chữ ký
   định dạng file, tạo tên SHA-256 thay vì lưu tên file nhà cung cấp và ghi
   ảnh vào `public/images/taobao/` trên máy chủ. Không lấy URL nguồn.
4. Đường dẫn ảnh được điền vào form duyệt. Duyệt lại nội dung tiếng Việt
   trước khi bấm "Duyệt giới thiệu". Ảnh không tự công khai trong danh mục
   chờ hay biến mặt hàng thành hàng có thể mua.

Ảnh này là **tài sản runtime riêng của máy chủ**, được `.gitignore` bỏ qua.
Phải sao lưu `public/images/taobao/` cùng với `data/` trước khi chuyển
server hoặc cập nhật cơ sở hạ tầng. Không dùng ảnh nếu chưa có quyền.
Không nhận SVG, HTML, định dạng lạ hay ảnh từ URL bên ngoài.


## Đồng bộ thủ công không bắt buộc bật đồng bộ tự động

Trong quản trị `/admin-besi.html#taobao`, nút **Đồng bộ sản phẩm bằng
API đã cấp quyền** có thể hoạt động khi `TAOBAO_AUTO_SYNC=0`. Các biến
`TAOBAO_DATA_PERMISSION=1`, `TAOBAO_APP_KEY`,
`TAOBAO_APP_SECRET`, `TAOBAO_ADZONE_ID` và
`TAOBAO_AUTO_SYNC_KEYWORDS` vẫn là bắt buộc. Bật
`TAOBAO_AUTO_SYNC=1` **chỉ** khi muốn chương trình tự chạy theo chu kỳ
`TAOBAO_SYNC_INTERVAL_HOURS`. Dù ở chế độ nào, dữ liệu vẫn chỉ nằm
trong staging chưa mua được, và khóa ghi chung ngăn hai lượt đồng bộ
ghi đè nhau.


## Kiểm tra phí ship theo kiện hàng ngay trong quản trị

Trong `/admin-besi.html#taobao`, mở **Kiểm tra phí ship Trung Quốc →
Việt Nam**; nhập cân nặng thực (kg), chiều dài/rộng/cao (cm), cước ship
nội địa TQ (CNY, bằng 0 chỉ khi shop miễn phí), chọn khu vực nhận, rồi
xác nhận thông tin đã đối chiếu. Nhấn nút kiểm tra sẽ sử dụng:

- Tỷ giá CNY/VND còn hạn từ tệp `data/taobao-fx.json`.
- Bảng phí CN→VN do admin đã xác nhận trong `data/taobao-shipping.json`.
- Cân nặng tính cước là mức cao hơn giữa cân nặng thực và thể tích
  quy đổi theo hệ số của nhà vận chuyển, làm tròn theo bước cước.
- Ship nội địa TQ (CNY → VND) + cước CN→VN + giao trong nước theo
  vùng + phí xử lý, với phí tối thiểu/khối lượng tính cước tối thiểu
  nếu biểu phí của đơn vị vận chuyển có áp dụng.

Không cần giá mua sản phẩm để **chỉ kiểm tra phí ship**: API riêng
`POST /api/admin/taobao/shipping-check` với phiên quản trị hợp lệ trả
`shipping_vnd` khi đủ dữ liệu; `item_vnd` và `total_vnd` luôn là
`null`, không tạo đơn hàng.

### Quy tắc biểu phí mở rộng (tuỳ chọn)

Bảng phí gốc yêu cầu `international_vnd_per_kg`. Nếu hợp đồng áp
dụng **đơn giá khác nhau theo nơi nhận**, bổ sung vào JSON:

```json
{
  "international_vnd_per_kg_by_region": {
    "hcm": 29000,
    "hn": 23000,
    "other": 29000
  },
  "minimum_billable_kg": 0.2,
  "minimum_international_vnd": 7000
}
```

**Các số trong ví dụ chỉ minh hoạ cách điền, không được tự động áp dụng
vào đơn thật.** Phải đối chiếu hợp đồng vận chuyển. Bảng giá công khai
VMT Global (https://vmtglobal.com/bieu-phi-dat-hang-trung-quoc/)
có quy tắc cước tối thiểu 7.000đ/kiện và thể tích / 8.000 cho tuyến
tiêu chuẩn; Ship Trung Việt
(https://shiptrungviet.vn/bang-gia-order-nhap-hang-trung-quoc.html)
có biểu phí và điều kiện riêng theo trọng lượng/địa điểm. Không
suy diễn các bảng đó là giá hợp đồng BESI.

**Giới hạn báo giá:** đây là dự kiến theo biểu phí đã cấu hình, không
phải phản hồi báo giá trực tiếp/được bảo đảm từ API nhà vận chuyển.
Chưa tính được thuế/VAT/hải quan, phí mua hộ, hàng cồng kềnh đặc biệt,
pin/chất lỏng hoặc phụ phí chưa có trong hợp đồng. Các mức theo bậc
số lượng lớn, gom đơn nhiều kiện hoặc dịch vụ đặc biệt cần bổ sung
bảng cước hợp đồng riêng (chưa tự áp dụng bậc giảm giá).


## Đăng nhập Taobao bằng Chrome Windows và đọc phí ship Taobao/Cainiao

**Không nhập mật khẩu Taobao vào BESI, không sao chép cookie/session lên
server.** Taobao không cung cấp API checkout ship cho sản phẩm affiliate
được xác thực trong dự án này. Vì vậy luồng tích hợp *không giả lập API*;
nó sử dụng tiện ích Chrome cài trên **máy tính Windows của người quản trị**,
tự đăng nhập trên website Taobao, rồi xác nhận số tiền Taobao thực sự
hiển thị trên trang thanh toán.

### Cài tiện ích BESI Taobao

1. Triển khai bản mới của repo lên Windows BESI trước, đảm bảo
   `https://besi.com.vn/taobao` và các API mới phản hồi (không còn 404).
2. Trên Chrome/Edge Windows nơi anh đang làm việc, tải mã nguồn repo và mở
   `chrome://extensions` / `edge://extensions`. Bật **Developer mode**,
   chọn **Load unpacked** (Tải tiện ích đã giải nén) rồi chỉ đến
   `tools/taobao-chrome-extension`.
3. Trong `/admin-besi.html#taobao`, đăng nhập quản trị BESI, bấm
   **Tạo mã kết nối** và sao chép. Mã ghép nối chỉ hiệu lực 5 phút và
   sử dụng một lần; không lưu vào file cấu hình hoặc URL.
4. Mở `https://www.taobao.com`, tự đăng nhập Taobao theo QR/mật khẩu
   trực tiếp trên Taobao. Không gửi mật khẩu/OTP vào BESI.
5. Trong Taobao, chọn **đúng một sản phẩm** và SKU, địa chỉ nhận
   **tại Việt Nam**; đến bước xác nhận vận chuyển mà chưa đặt hàng.
   Mở tiện ích, nhấn **Đọc cước đang hiển thị trong tab Taobao**.
   Tiện ích cố tìm dòng phí vận chuyển đã hiển thị; nếu không chắc chắn
   phải đọc và điền tay. Cước nội địa TQ không phải cước trọn gói VN.
6. Nhập mã sản phẩm/SKU *đã có trong kho chờ Taobao*, khu vực giao hàng,
   cách giao (官方直送 hoặc 官方集运), trạng thái và số tiền CNY/VND, rồi
   **tích xác nhận** phí giao đến địa chỉ VN cho đúng một món. Dán mã
   ghép nối BESI và bấm **Lưu cước đã kiểm tra về BESI**.
7. Trang `/taobao` ưu tiên cước Taobao/Cainiao được đối chiếu còn hạn;
   nếu hết 24 giờ quay lại biểu phí đối tác BESI khi có đủ cân nặng
   và hợp đồng. Không tính lại phí nội địa hai lần khi Taobao đã báo phí
   giao trọn gói. Nếu chỉ báo trạng thái chờ gom hàng, không hiển thị
   phí chính thức giả.

### Quy tắc quan trọng

- **Không tự nhấn đặt hàng, mua hàng, thanh toán, xác nhận đơn, CAPTCHA
  hoặc đăng nhập thay người dùng.** Tiện ích chỉ thao tác khi người
  quản trị bấm quét/cập nhật.
- **Không hỗ trợ tự lấy phí ship hàng loạt qua API checkout Taobao.**
  Website Taobao có thể thay đổi giao diện, yêu cầu xác minh thêm hoặc
  không cung cấp phương án giao chính thức tới Việt Nam; tiện ích khi
  đó bắt buộc yêu cầu xác minh thủ công thay vì ghi số tiền giả.
- Với gom hàng (官方集运), **chỉ báo cước sau khi kho cân đo và xác nhận**
  `weighed_at_warehouse=true`. Trước đó lưu
  `pending_consolidation`; không tự gán phí ship/kg của đối tác thành
  phí chính thức Cainiao.
- Cước kiểm tra cho **một địa chỉ mẫu** trong khu vực chỉ mang tính
  tham khảo, không phải phí cam kết cho mọi địa chỉ trong cùng tỉnh.
  Không lưu thông tin địa chỉ cụ thể, cookie, phiên, giá trị đơn hàng
  hay dữ liệu DOM đầy đủ vào máy chủ.
- `POST /api/taobao/browser-quote` chỉ nhận mã dùng một lần, nguồn
  Chrome extension, dữ liệu báo cước được xác nhận, đúng mã sản phẩm/SKU
  trong kho chờ; không thể tự mở bán.
- Lệnh quản trị có thể nhập tay một báo cước đã đọc bằng
  `POST /api/admin/taobao/official-shipping`, dùng chung kiểm tra dữ
  liệu và thời hạn 24 giờ.
- Hỗ trợ cửa hàng qua tiện ích Chrome **không phải hỗ trợ/ủy quyền API
  chính thức của Taobao/Cainiao**. Cần nghiệm thu trực tiếp với tài khoản
  thật, địa chỉ VN thật và cấu trúc checkout hiện tại.
