'use strict';
/**
 * Trang thông tin & chính sách của BESI (giai đoạn 2 – AEO/GEO): Giới thiệu, Liên hệ, Vận chuyển,
 * Thanh toán, Đổi trả, Bảo hành, Bảo mật, Câu hỏi thường gặp + /llms.txt.
 *
 * Nguyên tắc: chỉ ghi điều hệ thống THẬT SỰ làm hoặc chủ shop đã chốt. Thông tin pháp lý / liên hệ
 * (tên đăng ký, MST, địa chỉ, SĐT, Zalo…) do chủ shop tự điền ở Admin → Thông tin cửa hàng;
 * ô nào trống thì trang không hiện dòng đó (không bịa số).
 */
const pages = require('./seoPages');

const esc = pages.esc;

/** Chính sách chủ shop đã chốt (21/11/2026). */
const POLICY = {
  returnDays: 7,             // đổi trả hàng lỗi / giao sai / thiếu – tính từ ngày nhận hàng
  returnShippingByShop: true, // lỗi không do khách → cửa hàng chịu phí ship 2 chiều
  changeOfMind: false,        // không nhận đổi ý khi hàng không lỗi
  warranty: 'per-product'     // thời hạn theo từng SP, cửa hàng tiếp nhận
};

// ───────────── Thông tin cửa hàng (Admin → Thông tin cửa hàng) ─────────────
const FIELDS = {
  legalName: 160, taxId: 20, address: 240, hotline: 20, zalo: 20, email: 120, hours: 120, facebook: 200
};
const normPhone = v => String(v || '').replace(/[^\d+]/g, '').replace(/^\+?84(?=\d{9}$)/, '0');

/** Làm sạch dữ liệu admin gửi lên; ném lỗi nếu sai định dạng. */
function normalizeStoreInfo(input = {}) {
  const out = {};
  for (const [k, max] of Object.entries(FIELDS)) {
    const v = String(input[k] ?? '').replace(/\s+/g, ' ').trim();
    if (v.length > max) throw new Error(`"${k}" quá dài (tối đa ${max} ký tự).`);
    out[k] = v;
  }
  for (const k of ['hotline', 'zalo']) {
    if (!out[k]) continue;
    const p = normPhone(out[k]);
    if (!/^(0\d{9,10}|1[89]00\d{4,6})$/.test(p)) throw new Error(`Số ${k === 'zalo' ? 'Zalo' : 'hotline'} không hợp lệ.`);
    out[k] = p;
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(out.email)) throw new Error('Email không hợp lệ.');
  if (out.facebook && !/^https:\/\/(www\.|m\.)?(facebook|fb)\.com\/[\w.\-/?=]+$/i.test(out.facebook)) throw new Error('Link Facebook phải dạng https://facebook.com/…');
  if (out.taxId && !/^\d{10}(-\d{3})?$/.test(out.taxId)) throw new Error('Mã số thuế gồm 10 số (hoặc 10 số-3 số).');
  return out;
}

const infoOf = cfg => ({ ...Object.fromEntries(Object.keys(FIELDS).map(k => [k, ''])), ...(cfg?.storeInfo || {}) });
const fmtPhone = p => (p.length === 10 ? `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}` : p);
const zaloUrl = p => `https://zalo.me/${p}`;

// ───────────── Nội dung các trang ─────────────
const SUPPORT = info => {
  const ways = [];
  if (info.zalo) ways.push(`nhắn Zalo <a href="${esc(zaloUrl(info.zalo))}" rel="nofollow">${esc(fmtPhone(info.zalo))}</a>`);
  if (info.hotline) ways.push(`gọi <a href="tel:${esc(info.hotline)}">${esc(fmtPhone(info.hotline))}</a>`);
  if (info.email) ways.push(`email <a href="mailto:${esc(info.email)}">${esc(info.email)}</a>`);
  return ways.length ? ways.join(', ') : 'liên hệ cửa hàng qua trang <a href="/lien-he">Liên hệ</a>';
};

function faqItems(info, stats) {
  return [
    ['Mua lẻ 1 món trên BESI có được không?', 'Được. BESI bán lẻ từ 1 sản phẩm, giá hiển thị công khai trên từng trang sản phẩm. Khách mua số lượng lớn có thể đăng ký tài khoản khách sỉ để xem giá sỉ.'],
    ['Giá sỉ và giá lẻ khác nhau thế nào?', 'Khách chưa đăng nhập thấy giá lẻ. Khách sỉ đăng ký tài khoản (số điện thoại + mật khẩu), được cửa hàng duyệt, rồi đăng nhập sẽ thấy và đặt hàng theo giá sỉ.'],
    ['Làm sao đăng ký khách sỉ?', 'Bấm nút "Khách sỉ – Đăng nhập" ở đầu trang, chọn Đăng ký, nhập số điện thoại, họ tên, tên shop và mật khẩu. Tài khoản ở trạng thái chờ duyệt; sau khi cửa hàng duyệt, đăng nhập lại là thấy giá sỉ.'],
    ['Có được kiểm tra hàng trước khi thanh toán không?', 'Có. Khi chọn thanh toán khi nhận hàng (COD), bạn được kiểm tra hàng rồi mới trả tiền cho nhân viên giao hàng.'],
    ['BESI có những hình thức thanh toán nào?', 'Thanh toán khi nhận hàng (COD) và chuyển khoản qua mã VietQR. Với chuyển khoản, cửa hàng xác nhận đơn khi nhận được tiền.'],
    ['Bao lâu thì nhận được hàng?', 'Thường 1–2 ngày nếu kho và bạn cùng tỉnh, 2–3 ngày trong cùng miền, 3–5 ngày giữa hai miền Bắc – Nam, cộng thời gian kho chuẩn bị hàng. Đơn chốt trước 16h thường được bàn giao vận chuyển trong ngày. Ngày giao dự kiến hiện ngay khi đặt hàng.'],
    ['Phí vận chuyển tính thế nào?', 'Phí ship tính theo địa chỉ nhận và khối lượng đơn, hiện đầy đủ ở bước đặt hàng trước khi bạn xác nhận. Đơn có hàng từ nhiều kho có thể được chia thành nhiều kiện giao riêng.'],
    ['Làm sao theo dõi đơn hàng?', 'Bấm "Theo dõi đơn hàng" ở đầu trang, nhập mã đơn và số điện thoại đặt hàng để xem trạng thái, mã vận đơn và ngày giao dự kiến. Khách sỉ đã đăng nhập xem ở mục "Đơn hàng của tôi".'],
    [`Hàng lỗi hoặc giao sai thì đổi trả thế nào?`, `Trong ${POLICY.returnDays} ngày kể từ khi nhận hàng, nếu sản phẩm lỗi do nhà sản xuất, giao sai mẫu/phân loại, thiếu hàng hoặc hư hỏng do vận chuyển, bạn ${SUPPORT(info)} kèm mã đơn và ảnh/video tình trạng hàng. Cửa hàng chịu phí vận chuyển đổi trả trong các trường hợp này.`],
    ['Không thích sản phẩm nữa có trả được không?', 'Cửa hàng không nhận đổi trả vì đổi ý khi hàng không lỗi. Vì vậy bạn nên kiểm tra kỹ hàng khi nhận (COD).'],
    ['Sản phẩm được bảo hành bao lâu?', 'Thời hạn bảo hành ghi trên trang từng sản phẩm. Khi cần bảo hành, cửa hàng tiếp nhận sản phẩm và làm việc với hãng/kho thay cho bạn.'],
    ['BESI có bao nhiêu sản phẩm?', `Hiện có ${stats.products.toLocaleString('vi-VN')} sản phẩm thuộc ${stats.categories.toLocaleString('vi-VN')} danh mục và ${stats.brands.toLocaleString('vi-VN')} thương hiệu, giá và tồn kho được cập nhật tự động liên tục.`]
  ];
}

function legalBlock(info) {
  const rows = [
    info.legalName && ['Tên đăng ký kinh doanh', esc(info.legalName)],
    info.taxId && ['Mã số thuế', esc(info.taxId)],
    info.address && ['Địa chỉ', esc(info.address)],
    info.hotline && ['Hotline', `<a href="tel:${esc(info.hotline)}">${esc(fmtPhone(info.hotline))}</a>`],
    info.zalo && ['Zalo', `<a href="${esc(zaloUrl(info.zalo))}" rel="nofollow">${esc(fmtPhone(info.zalo))}</a>`],
    info.email && ['Email', `<a href="mailto:${esc(info.email)}">${esc(info.email)}</a>`],
    info.hours && ['Giờ làm việc', esc(info.hours)],
    info.facebook && ['Facebook', `<a href="${esc(info.facebook)}" rel="nofollow noopener">${esc(info.facebook.replace(/^https:\/\/(www\.)?/, ''))}</a>`]
  ].filter(Boolean);
  return rows.length ? `<dl class="info-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : '';
}

const PAGES = {
  'gioi-thieu': {
    title: 'Giới thiệu BESI – Sàn mua lẻ giá tốt, nhập sỉ từ nhiều tổng kho', nav: 'Giới thiệu', type: 'AboutPage',
    desc: (i, s) => `BESI là sàn mua lẻ giá tốt và nhập sỉ với ${s.products.toLocaleString('vi-VN')} sản phẩm từ nhiều tổng kho, giao toàn quốc, kiểm tra hàng trước khi trả tiền.`,
    body: (i, s) => `
      <p><strong>BESI</strong> (besi.com.vn) là sàn mua sắm tập hợp hàng từ nhiều tổng kho và nhà phân phối tại Việt Nam. Bạn có thể <strong>mua lẻ từ 1 sản phẩm</strong> với giá công khai, hoặc đăng ký <strong>khách sỉ</strong> để nhập hàng theo giá sỉ.</p>
      <h2>BESI có gì?</h2>
      <ul>
        <li>${s.products.toLocaleString('vi-VN')} sản phẩm, ${s.categories.toLocaleString('vi-VN')} danh mục, ${s.brands.toLocaleString('vi-VN')} thương hiệu – từ phụ kiện điện thoại, thiết bị âm thanh đến đồ gia dụng.</li>
        <li>Giá và tồn kho cập nhật tự động liên tục từ kho, nên giá bạn thấy là giá đang bán.</li>
        <li>Giao hàng toàn quốc, ngày giao dự kiến hiện ngay khi đặt hàng.</li>
        <li>Thanh toán khi nhận hàng (COD) – kiểm tra hàng rồi mới trả tiền; hoặc chuyển khoản VietQR.</li>
        <li>Đổi trả trong ${POLICY.returnDays} ngày nếu hàng lỗi hoặc giao sai, cửa hàng chịu phí vận chuyển.</li>
      </ul>
      <h2>Mua lẻ và mua sỉ</h2>
      <p>Khách chưa đăng nhập thấy <strong>giá lẻ</strong>. Khách sỉ đăng ký bằng số điện thoại, được cửa hàng duyệt, rồi đăng nhập sẽ thấy và đặt hàng theo <strong>giá sỉ</strong>. Xem thêm ở <a href="/cau-hoi-thuong-gap">Câu hỏi thường gặp</a>.</p>
      ${legalBlock(i) ? `<h2>Thông tin cửa hàng</h2>${legalBlock(i)}` : ''}`
  },
  'lien-he': {
    title: 'Liên hệ BESI – Hỗ trợ đặt hàng, đổi trả, bảo hành', nav: 'Liên hệ', type: 'ContactPage',
    desc: () => 'Liên hệ BESI để được hỗ trợ đặt hàng, theo dõi đơn, đổi trả và bảo hành.',
    body: i => `
      <p>Cần hỗ trợ đặt hàng, theo dõi đơn, đổi trả hay bảo hành? Khi liên hệ về một đơn hàng, vui lòng gửi kèm <strong>mã đơn</strong> (dạng HM…) để được hỗ trợ nhanh.</p>
      ${legalBlock(i) || '<p><em>Thông tin liên hệ đang được cập nhật.</em></p>'}
      <h2>Tự tra cứu đơn hàng</h2>
      <p>Bấm <a href="/?tra-cuu=1">Theo dõi đơn hàng</a>, nhập mã đơn và số điện thoại đặt hàng để xem trạng thái, mã vận đơn và ngày giao dự kiến.</p>`
  },
  'chinh-sach-van-chuyen': {
    title: 'Chính sách vận chuyển – Giao toàn quốc | BESI', nav: 'Vận chuyển',
    desc: () => 'BESI giao hàng toàn quốc: thường 1–5 ngày tuỳ khoảng cách, phí ship tính theo địa chỉ và hiện trước khi đặt, kiểm tra hàng khi nhận.',
    body: () => `
      <h2>Phạm vi giao hàng</h2>
      <p>BESI giao hàng toàn quốc qua các đơn vị vận chuyển đối tác (như Viettel Post). Mỗi đơn có mã vận đơn để theo dõi.</p>
      <h2>Thời gian giao hàng</h2>
      <ul>
        <li>Cùng tỉnh với kho: thường 1–2 ngày.</li>
        <li>Cùng miền: thường 2–3 ngày.</li>
        <li>Miền lân cận: thường 3–4 ngày.</li>
        <li>Bắc ↔ Nam: thường 3–5 ngày.</li>
      </ul>
      <p>Thời gian trên chưa gồm thời gian kho chuẩn bị hàng. Đơn chốt trước 16h thường được bàn giao vận chuyển trong ngày. Ngày giao dự kiến của đơn bạn hiện ngay khi đặt hàng, và được cập nhật theo hành trình thật của vận đơn.</p>
      <h2>Phí vận chuyển</h2>
      <p>Phí ship tính theo địa chỉ nhận và khối lượng đơn hàng, hiện đầy đủ ở bước đặt hàng <strong>trước khi bạn xác nhận</strong>. Đơn có hàng từ nhiều kho có thể được chia thành nhiều kiện giao riêng; phí mỗi kiện đều hiện rõ.</p>
      <h2>Nhận hàng</h2>
      <p>Bạn được kiểm tra hàng trước khi thanh toán (COD). Nếu hàng giao sai, thiếu hoặc hư hỏng do vận chuyển, hãy báo cửa hàng theo <a href="/chinh-sach-doi-tra">chính sách đổi trả</a>.</p>`
  },
  'hinh-thuc-thanh-toan': {
    title: 'Hình thức thanh toán – COD và chuyển khoản VietQR | BESI', nav: 'Thanh toán',
    desc: () => 'Thanh toán trên BESI: COD – kiểm tra hàng rồi trả tiền, hoặc chuyển khoản VietQR được xác nhận tự động.',
    body: () => `
      <h2>1. Thanh toán khi nhận hàng (COD)</h2>
      <p>Bạn kiểm tra hàng rồi trả tiền mặt cho nhân viên giao hàng. Không cần trả trước.</p>
      <h2>2. Chuyển khoản qua mã VietQR</h2>
      <p>Sau khi đặt hàng, trang thanh toán hiện mã VietQR với đúng số tiền và nội dung chuyển khoản. Quét mã bằng ứng dụng ngân hàng; cửa hàng xác nhận đơn khi nhận được tiền và màn hình tự cập nhật.</p>
      <h2>Giá và phí</h2>
      <p>Tổng tiền gồm giá sản phẩm và phí vận chuyển, hiện đầy đủ trước khi bạn xác nhận đặt hàng. Giá được kiểm tra lại với kho ngay lúc đặt; nếu giá hoặc tồn kho vừa thay đổi, hệ thống báo để bạn xác nhận lại trước khi tạo đơn.</p>`
  },
  'chinh-sach-doi-tra': {
    title: `Chính sách đổi trả ${POLICY.returnDays} ngày | BESI`, nav: 'Đổi trả',
    desc: () => `Đổi trả trong ${POLICY.returnDays} ngày nếu hàng lỗi do nhà sản xuất, giao sai hoặc thiếu; cửa hàng chịu phí vận chuyển. Không nhận đổi ý.`,
    body: i => `
      <p class="info-lead">Đổi trả trong <strong>${POLICY.returnDays} ngày</strong> kể từ ngày nhận hàng khi sản phẩm lỗi hoặc giao không đúng. <strong>Cửa hàng chịu phí vận chuyển</strong> đổi trả trong các trường hợp này.</p>
      <h2>Trường hợp được đổi trả</h2>
      <ul>
        <li>Sản phẩm lỗi do nhà sản xuất.</li>
        <li>Giao sai mẫu, sai phân loại (màu, dung lượng, kích thước…).</li>
        <li>Thiếu sản phẩm hoặc thiếu phụ kiện so với mô tả.</li>
        <li>Hư hỏng, móp vỡ do vận chuyển.</li>
      </ul>
      <h2>Trường hợp không áp dụng</h2>
      <ul>
        <li>Đổi ý khi sản phẩm không lỗi (không thích, đặt nhầm…). Bạn nên kiểm tra kỹ hàng khi nhận (COD).</li>
        <li>Quá ${POLICY.returnDays} ngày kể từ ngày nhận hàng.</li>
        <li>Sản phẩm hư hỏng do sử dụng sai hướng dẫn, rơi vỡ, vào nước sau khi nhận.</li>
        <li>Sản phẩm không còn đủ hộp, phụ kiện, quà tặng kèm như lúc nhận.</li>
      </ul>
      <h2>Cách đổi trả</h2>
      <ol>
        <li>Trong ${POLICY.returnDays} ngày, ${SUPPORT(i)}, gửi <strong>mã đơn</strong> và ảnh/video tình trạng sản phẩm. Bạn nên quay video khi mở hộp.</li>
        <li>Cửa hàng xác nhận và hướng dẫn gửi hàng về (cửa hàng chịu phí).</li>
        <li>Cửa hàng gửi sản phẩm mới cùng loại cho bạn. Nếu không còn hàng để đổi, cửa hàng hoàn tiền cho sản phẩm đó.</li>
      </ol>`
  },
  'chinh-sach-bao-hanh': {
    title: 'Chính sách bảo hành | BESI', nav: 'Bảo hành',
    desc: () => 'Bảo hành theo thời hạn ghi trên từng sản phẩm; BESI tiếp nhận và làm việc với hãng/kho thay cho khách.',
    body: i => `
      <h2>Thời hạn bảo hành</h2>
      <p>Thời hạn bảo hành <strong>ghi trên trang từng sản phẩm</strong> (ví dụ: 6 tháng, 12 tháng, bảo hành chính hãng…), tính từ ngày nhận hàng.</p>
      <h2>Cửa hàng tiếp nhận bảo hành</h2>
      <p>Bạn không cần tự mang đến trung tâm bảo hành. ${SUPPORT(i).replace(/^./, c => c.toUpperCase())}, gửi mã đơn và mô tả lỗi; cửa hàng hướng dẫn gửi sản phẩm về và làm việc với hãng/kho thay cho bạn, rồi gửi lại sản phẩm đã bảo hành hoặc sản phẩm thay thế.</p>
      <h2>Không thuộc phạm vi bảo hành</h2>
      <ul>
        <li>Hết thời hạn bảo hành.</li>
        <li>Hư hỏng do rơi vỡ, va đập, vào nước, cháy nổ do nguồn điện không phù hợp.</li>
        <li>Sản phẩm đã bị tháo, sửa chữa bởi nơi không được uỷ quyền; tem bảo hành bị rách hoặc sửa.</li>
      </ul>
      <p>Hàng lỗi ngay khi nhận được xử lý theo <a href="/chinh-sach-doi-tra">chính sách đổi trả ${POLICY.returnDays} ngày</a>.</p>`
  },
  'chinh-sach-bao-mat': {
    title: 'Chính sách bảo mật thông tin | BESI', nav: 'Bảo mật',
    desc: () => 'BESI chỉ dùng thông tin của bạn để giao hàng và hỗ trợ đơn hàng; không bán thông tin cho bên thứ ba.',
    body: i => `
      <h2>Thông tin chúng tôi thu thập</h2>
      <ul>
        <li><strong>Khi đặt hàng:</strong> họ tên, số điện thoại, địa chỉ nhận hàng và ghi chú – để giao hàng và liên hệ về đơn.</li>
        <li><strong>Tài khoản khách sỉ:</strong> số điện thoại, họ tên, tên shop. Mật khẩu được mã hoá một chiều; cửa hàng không đọc được mật khẩu của bạn.</li>
        <li><strong>Trên trình duyệt của bạn:</strong> giỏ hàng và danh sách đơn đã đặt được lưu ngay trên máy bạn; cookie đăng nhập khách sỉ; cookie ghi nhận bạn đến từ bài giới thiệu nào (lưu 7 ngày).</li>
        <li><strong>Thống kê ẩn danh:</strong> số lượt xem trang, xem sản phẩm, thêm giỏ, mở bước đặt hàng – gắn với một mã phiên ngẫu nhiên, không kèm tên, số điện thoại hay địa chỉ IP – để cửa hàng biết cần cải thiện bước nào.</li>
        <li><strong>Đánh giá sản phẩm:</strong> số sao và nhận xét bạn gửi sau khi nhận hàng; trên web chỉ hiện tên đã che bớt (ví dụ "Tuấn N."), không hiện số điện thoại.</li>
      </ul>
      <h2>Chúng tôi dùng thông tin để</h2>
      <ul>
        <li>Xử lý, giao hàng và thông báo tình trạng đơn.</li>
        <li>Hỗ trợ đổi trả, bảo hành.</li>
        <li>Hiển thị đúng giá cho khách sỉ đã duyệt.</li>
      </ul>
      <h2>Chia sẻ thông tin</h2>
      <p>Thông tin giao hàng (tên, số điện thoại, địa chỉ) chỉ được chuyển cho kho hàng và đơn vị vận chuyển để giao đơn của bạn. BESI <strong>không bán hoặc cho thuê</strong> thông tin khách hàng.</p>
      <h2>Bảo vệ thông tin</h2>
      <p>Trang tra cứu đơn chỉ hiện đơn khi nhập đúng mã đơn và số điện thoại; số điện thoại được che bớt. Mỗi khách sỉ chỉ xem được đơn của chính mình.</p>
      <h2>Yêu cầu sửa hoặc xoá thông tin</h2>
      <p>Bạn có thể yêu cầu xem, sửa hoặc xoá thông tin cá nhân: ${SUPPORT(i)}.</p>`
  },
  'cau-hoi-thuong-gap': {
    title: 'Câu hỏi thường gặp khi mua hàng trên BESI', nav: 'Hỏi đáp', type: 'FAQPage',
    desc: () => 'Giải đáp nhanh về mua lẻ, khách sỉ, thanh toán COD, thời gian giao hàng, phí ship, đổi trả và bảo hành trên BESI.',
    body: (i, s) => faqItems(i, s).map(([q, a]) => `<section class="info-faq"><h2>${esc(q)}</h2><p>${a}</p></section>`).join('')
  }
};
const SLUGS = Object.keys(PAGES);
const pagePath = slug => `/${slug}`;

/** Link "Hỗ trợ khách hàng" cho chân trang mọi trang. */
const supportLinks = () => SLUGS.map(s => ({ name: PAGES[s].nav, url: pagePath(s) }));

// ───────────── JSON-LD ─────────────
function returnPolicyLd(base) {
  return {
    '@type': 'MerchantReturnPolicy', '@id': `${base}/chinh-sach-doi-tra#policy`, url: `${base}/chinh-sach-doi-tra`,
    applicableCountry: 'VN', returnPolicyCountry: 'VN',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: POLICY.returnDays,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees: 'https://schema.org/FreeReturn',
    itemDefectReturnFees: 'https://schema.org/FreeReturn',
    customerRemorseReturnFees: 'https://schema.org/ReturnFeesCustomerResponsibility'
  };
}

/** Organization đầy đủ: liên hệ, địa chỉ, pháp lý, chính sách đổi trả (chỉ trường đã điền). */
function organizationLd(base, cfg) {
  const i = infoOf(cfg);
  const contact = [];
  if (i.hotline) contact.push({ '@type': 'ContactPoint', telephone: i.hotline, contactType: 'customer service', areaServed: 'VN', availableLanguage: 'vi' });
  if (i.email) contact.push({ '@type': 'ContactPoint', email: i.email, contactType: 'customer service', areaServed: 'VN', availableLanguage: 'vi' });
  const sameAs = [i.facebook, i.zalo && zaloUrl(i.zalo)].filter(Boolean);
  return {
    ...pages.orgLd(base),
    ...(i.legalName ? { legalName: i.legalName } : {}),
    ...(i.taxId ? { taxID: i.taxId } : {}),
    ...(i.address ? { address: { '@type': 'PostalAddress', streetAddress: i.address, addressCountry: 'VN' } } : {}),
    ...(i.hotline ? { telephone: i.hotline } : {}),
    ...(i.email ? { email: i.email } : {}),
    ...(contact.length ? { contactPoint: contact } : {}),
    ...(sameAs.length ? { sameAs } : {}),
    hasMerchantReturnPolicy: { '@id': `${base}/chinh-sach-doi-tra#policy` }
  };
}

// ───────────── HTML trang ─────────────
function renderInfoPage({ slug, base, cfg, stats, footerHtml = '', assetVersion = '' }) {
  const page = PAGES[slug];
  if (!page) return null;
  const info = infoOf(cfg);
  const url = base + pagePath(slug);
  const title = page.title;
  const desc = page.desc(info, stats);
  const crumbs = [{ name: 'Trang chủ', url: '/' }, { name: page.nav }];
  const graph = [
    organizationLd(base, cfg), returnPolicyLd(base), pages.websiteLd(base),
    { '@type': page.type || 'WebPage', '@id': `${url}#page`, url, name: title, description: desc, inLanguage: 'vi-VN', isPartOf: { '@id': `${base}/#website` }, about: { '@id': `${base}/#organization` } },
    pages.breadcrumbLd(base, crumbs)
  ];
  if (page.type === 'FAQPage') {
    graph[3].mainEntity = faqItems(info, stats).map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: pages.plainText(a) } }));
  }
  const v = assetVersion ? `?${assetVersion}` : '';
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="${esc(url)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="vi_VN">
  <meta property="og:site_name" content="BESI">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${esc(base)}/og-besi.png">
  <link rel="stylesheet" href="/seo-ssr.css${v}">
  ${pages.ldScript(graph)}
</head>
<body class="info-body">
  <header class="info-top">
    <div class="info-wrap">
      <a class="info-logo" href="/" aria-label="BESI – Trang chủ"><b>be</b><span>si.</span></a>
      <nav aria-label="Điều hướng"><a href="/">Mua sắm</a><a href="/?tra-cuu=1">Theo dõi đơn</a><a href="/lien-he">Liên hệ</a></nav>
    </div>
  </header>
  <main class="info-wrap info-main">
    <article class="info-article">
      ${pages.crumbsHtml(crumbs)}
      <h1>${esc(page.type === 'FAQPage' ? page.title : page.title.split(/ [–|] /)[0])}</h1>
      ${page.body(info, stats)}
    </article>
    <aside class="info-aside" aria-label="Hỗ trợ khách hàng">
      <h2>Hỗ trợ khách hàng</h2>
      <ul>${SLUGS.map(s => `<li><a href="${pagePath(s)}"${s === slug ? ' aria-current="page"' : ''}>${esc(PAGES[s].nav)}</a></li>`).join('')}</ul>
    </aside>
  </main>
  <footer class="info-footer">${footerHtml}<p class="info-wrap">© ${new Date().getFullYear()} BESI · besi.com.vn</p></footer>
</body>
</html>`;
}

/**
 * Trang 404 (mã 404 thật để Google bỏ URL cũ nhanh; noindex). Gợi ý tìm kiếm + danh mục phổ biến để khách không thoát.
 * categories: [{ name, path }]
 */
function renderNotFoundPage({ footerHtml = '', assetVersion = '', categories = [], product = false }) {
  const v = assetVersion ? `?${assetVersion}` : '';
  const title = product ? 'Sản phẩm không còn bán' : 'Không tìm thấy trang';
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} | BESI</title>
  <meta name="robots" content="noindex, follow">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/seo-ssr.css${v}">
</head>
<body class="info-body">
  <header class="info-top">
    <div class="info-wrap">
      <a class="info-logo" href="/" aria-label="BESI – Trang chủ"><b>be</b><span>si.</span></a>
      <nav aria-label="Điều hướng"><a href="/">Mua sắm</a><a href="/?tra-cuu=1">Theo dõi đơn</a><a href="/lien-he">Liên hệ</a></nav>
    </div>
  </header>
  <main class="info-wrap info-main">
    <article class="info-article">
      <h1>${esc(title)}</h1>
      <p>${product ? 'Sản phẩm này đã ngừng bán hoặc đường link đã thay đổi.' : 'Đường link có thể đã cũ hoặc gõ nhầm.'} Bạn thử tìm sản phẩm khác nhé:</p>
      <form action="/" method="get" role="search" style="display:flex;gap:8px;margin:12px 0 18px;max-width:520px">
        <input type="search" name="q" placeholder="Tìm sạc dự phòng, tai nghe, cáp sạc…" aria-label="Tìm sản phẩm" style="flex:1;min-width:0;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px">
        <button type="submit" style="padding:10px 16px;border:0;border-radius:10px;background:#ee4d2d;color:#fff;font-weight:700;font-size:15px">Tìm</button>
      </form>
      ${categories.length ? `<h2>Danh mục được xem nhiều</h2><ul>${categories.map(c => `<li><a href="${esc(c.path)}">${esc(c.name)}</a></li>`).join('')}</ul>` : ''}
      <p><a href="/">← Về trang chủ BESI</a></p>
    </article>
  </main>
  <footer class="info-footer">${footerHtml}<p class="info-wrap">© ${new Date().getFullYear()} BESI · besi.com.vn</p></footer>
</body>
</html>`;
}

/** Hỏi đáp nhanh dưới mỗi trang SP (bot AI đọc được câu trả lời gắn với đúng sản phẩm). */
function productQaHtml(product, cfg) {
  const info = infoOf(cfg);
  const w = product.warranty ? `Bảo hành ${esc(String(product.warranty).replace(/^bảo hành\s*/i, ''))}; cửa hàng tiếp nhận bảo hành thay bạn.` : 'Thời hạn bảo hành theo sản phẩm; cửa hàng tiếp nhận bảo hành thay bạn.';
  const qa = [
    ['Bao lâu nhận được hàng?', 'Thường 1–5 ngày tuỳ khoảng cách (ngày giao dự kiến hiện khi đặt hàng). Đơn chốt trước 16h thường được gửi đi trong ngày.'],
    ['Có được kiểm tra hàng trước khi trả tiền?', 'Có, khi chọn thanh toán khi nhận hàng (COD).'],
    ['Bảo hành thế nào?', `${w} <a href="/chinh-sach-bao-hanh">Xem chính sách bảo hành</a>.`],
    ['Hàng lỗi hoặc giao sai thì sao?', `Đổi trả trong ${POLICY.returnDays} ngày, cửa hàng chịu phí vận chuyển. <a href="/chinh-sach-doi-tra">Xem chính sách đổi trả</a>.`]
  ];
  void info;
  return `<section class="ssr-qa"><h2>Hỏi đáp nhanh</h2>${qa.map(([q, a]) => `<h3>${esc(q)}</h3><p>${a}</p>`).join('')}</section>`;
}

// ───────────── /llms.txt ─────────────
function llmsTxt({ base, cfg, stats, categories = [], brands = [] }) {
  const i = infoOf(cfg);
  const contact = [i.hotline && `Hotline: ${fmtPhone(i.hotline)}`, i.zalo && `Zalo: ${fmtPhone(i.zalo)} (${zaloUrl(i.zalo)})`, i.email && `Email: ${i.email}`, i.hours && `Giờ làm việc: ${i.hours}`, i.address && `Địa chỉ: ${i.address}`]
    .filter(Boolean);
  return `# BESI (besi.com.vn)

> Sàn mua lẻ giá tốt và nhập sỉ tại Việt Nam: ${stats.products.toLocaleString('vi-VN')} sản phẩm từ nhiều tổng kho, ${stats.categories} danh mục, ${stats.brands} thương hiệu. Mua lẻ từ 1 sản phẩm; khách sỉ đã được duyệt xem giá sỉ. Giao toàn quốc, thanh toán khi nhận hàng (COD) hoặc chuyển khoản VietQR, đổi trả ${POLICY.returnDays} ngày khi hàng lỗi/giao sai.

Giá trên trang là giá lẻ công khai, cập nhật tự động theo kho. Ngày giao dự kiến và phí vận chuyển hiện ở bước đặt hàng.${i.legalName ? `\n\nĐơn vị vận hành: ${i.legalName}${i.taxId ? ` (MST ${i.taxId})` : ''}.` : ''}

## Chính sách & hỗ trợ
${SLUGS.map(s => `- [${PAGES[s].nav}](${base}${pagePath(s)}): ${PAGES[s].desc(i, stats)}`).join('\n')}
${contact.length ? `\n## Liên hệ\n${contact.map(c => `- ${c}`).join('\n')}\n` : ''}
## Danh mục chính
${categories.map(c => `- [${c.name}](${base}${pages.categoryPath(c)}): ${Number(c.product_count || 0).toLocaleString('vi-VN')} sản phẩm`).join('\n')}

## Thương hiệu nổi bật
${brands.map(b => `- [${b.name}](${base}${pages.brandPath(b.name)})`).join('\n')}

## Cấu trúc đường dẫn
- Sản phẩm: ${base}/sp/<mã>-<tên-không-dấu> (có JSON-LD Product: giá VND, tình trạng, thương hiệu)
- Danh mục: ${base}/danh-muc/<mã>-<tên-không-dấu>
- Thương hiệu: ${base}/thuong-hieu/<tên-không-dấu>
- Tìm kiếm: ${base}/tim-kiem/<từ-khoá-không-dấu>
- Sitemap: ${base}/sitemap.xml
`;
}

module.exports = {
  POLICY, PAGES, SLUGS, pagePath, supportLinks, normalizeStoreInfo, infoOf,
  renderInfoPage, renderNotFoundPage, productQaHtml, llmsTxt, organizationLd, returnPolicyLd, faqItems
};
