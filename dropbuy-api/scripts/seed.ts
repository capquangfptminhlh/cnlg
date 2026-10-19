// Dữ liệu mẫu: tenant gốc, danh mục (giống dropbuy.vn), vài tỉnh/huyện/xã, SA, shop có kho + sản phẩm, buyer F1, khách thường.
try {
  process.loadEnvFile();
} catch {}
import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();
const D = (n: number) => new Prisma.Decimal(n);
const pw = await bcrypt.hash('123456', 10);
const FX = process.env.DEFAULT_TENANT_FX_HASH || 'afa4cf0301eb4a75882dd5df30cc54a5';

async function main() {
  if (await prisma.tenant.count()) {
    console.log('DB đã có dữ liệu – bỏ qua seed (dùng npm run db:reset để làm lại)');
    return;
  }
  const root = await prisma.tenant.create({ data: { fx_hash: FX, code: 'ROOT', name: 'DropBuy', domain_primary: 'localhost', public_good_price: true } });

  const cats = ['Nhà cửa & đời sống', 'Thú cưng', 'Ô tô - Xe máy - Xe đạp', 'Đồ chơi', 'Sức khỏe & làm đẹp', 'Thời trang', 'Giày dép', 'Balo - Túi xách - Vali', 'Điện thoại & phụ kiện', 'Máy ảnh & Camera', 'Thiết bị điện gia dụng', 'Máy tính & Laptop', 'Thiết bị âm thanh'];
  const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/&/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const [i, name] of cats.entries()) await prisma.category.create({ data: { name, slug: slug(name), num: i } });

  // Địa giới mẫu (id theo bảng VTP): Hà Nội 1, TP.HCM 2, Đà Nẵng 18
  const loc = [
    { id: 1, level: 1, parent_id: null, name: 'Hà Nội' }, { id: 2, level: 1, parent_id: null, name: 'TP. Hồ Chí Minh' }, { id: 18, level: 1, parent_id: null, name: 'Đà Nẵng' },
    { id: 22, level: 2, parent_id: 1, name: 'Quận Cầu Giấy' }, { id: 24, level: 2, parent_id: 1, name: 'Quận Đống Đa' }, { id: 135, level: 2, parent_id: 2, name: 'Quận 1' }, { id: 191, level: 2, parent_id: 18, name: 'Quận Hải Châu' },
    { id: 449, level: 3, parent_id: 22, name: 'Phường Dịch Vọng' }, { id: 482, level: 3, parent_id: 24, name: 'Phường Láng Hạ' }, { id: 1947, level: 3, parent_id: 135, name: 'Phường Bến Nghé' }, { id: 3286, level: 3, parent_id: 191, name: 'Phường Hải Châu 1' },
  ];
  for (const l of loc) await prisma.location.create({ data: l });

  const mk = (username: string, extra: Partial<Prisma.UserCreateInput> = {}) =>
    prisma.user.create({ data: { username, email: `${username}@example.test`, phone: '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), password_hash: pw, fullname: username, status: 'A', bank_ref_user_code: `DB${username.toUpperCase()}`, tenant_id: root.id, ...extra } });

  const sa = await mk('admin', { is_sa: true, user_level: 1, fullname: 'Quản trị hệ thống' });
  await prisma.tenant.update({ where: { id: root.id }, data: { owner_user_id: sa.id } });
  const shopUser = await mk('shopdemo', { user_level: 1, fullname: 'Chủ shop demo' });
  const f1 = await mk('ctv1', { user_level: 1, fullname: 'CTV cấp 1', aff_code: 'CTV1AFF' });
  const buyer = await mk('khach1', { user_level: 0, fullname: 'Khách lẻ', parent_user_id: f1.id });
  await prisma.userReferral.create({ data: { user_id: buyer.id, parent_user_id: f1.id, status: 'A', approved_at: new Date() } });

  const shop = await prisma.shop.create({ data: { user_id: shopUser.id, name: 'shop-demo', display_name: 'Shop Demo', fullname: 'Chủ shop demo', phone: '0900000001', address_line: '1 Láng Hạ', province_id: 1, district_id: 24, ward_id: 482, enable_virtual_depot: true } });
  const depot = await prisma.shopDepot.create({ data: { unique_id: randomUUID(), depot_code: `DP-${shop.id}-1001-1`, shop_id: shop.id, name: 'Kho Hà Nội', fullname: 'Chủ shop demo', phone: '0900000001', address_line: '1 Láng Hạ', province_id: 1, district_id: 24, ward_id: 482 } });

  const products = [
    { name: 'Sạc dự phòng từ tính 10.000mAh 25W', cat: 9, pub: 2650000, f1: 639000, w: 300, stock: 177, vars: ['Đen', 'Trắng'] },
    { name: 'Bình nước trẻ em PPSU chống đổ', cat: 1, pub: 500000, f1: 99999, w: 400, stock: 80, vars: [] },
    { name: 'Tai nghe Bluetooth K5', cat: 13, pub: 450000, f1: 220000, w: 150, stock: 50, vars: [] },
    { name: 'Máy hút bụi cầm tay MX113', cat: 11, pub: 500000, f1: 235000, w: 1200, stock: 20, vars: [] },
  ];
  for (const x of products) {
    const p = await prisma.product.create({ data: { unique_id: randomUUID(), shop_id: shop.id, category_id: x.cat, name: x.name, slug: slug(x.name), description: `<p>${x.name}</p>`, status: 'A', admin_status: 'A', aff_enabled: true, aff_rate: D(10), weight_gram: x.w, thumbnail_url: '/md/demo.jpg' } });
    const names = x.vars.length ? x.vars : [x.name];
    for (const [i, vn] of names.entries()) {
      const v = await prisma.variation.create({ data: { id: randomUUID(), product_id: p.id, name: vn, sku: `S${shop.id}-${p.id}-${100000 + i}`, price_public: D(x.pub), price_f1: D(x.f1), weight_vtp: D(x.w), weight_spx: D(x.w), num: i } });
      await prisma.stock.create({ data: { variation_id: v.id, depot_id: depot.id, current_stock: x.stock } });
    }
  }

  // Ví: nạp sẵn cho buyer & ctv để test thanh toán bằng ví
  for (const u of [buyer, f1]) {
    const b = await prisma.balance.create({ data: { unique_id: randomUUID(), user_id: u.id, balance_type: 'A', amount: D(5_000_000) } });
    await prisma.balanceTxn.create({ data: { unique_id: randomUUID(), balance_id: b.id, user_id: u.id, action_code: 'I', business_code: 'DEPOSIT', amount: D(5_000_000), balance_after: D(5_000_000), notes: 'seed' } });
  }

  const baseline = [
    [1, 'Đổi ý, không muốn mua nữa'], [1, 'Đặt nhầm sản phẩm'], [1, 'Muốn đổi địa chỉ nhận'],
    [2, 'Hàng giao thiếu'], [2, 'Hàng bị hư hỏng'], [2, 'Hàng không đúng mô tả'],
  ] as const;
  for (const [i, [t, text]] of baseline.entries()) await prisma.baselineData.create({ data: { bl_type_id: t, bl_text: text, num: i } });

  console.log(`Seed xong. fx_hash tenant gốc = ${FX}`);
  console.log('Tài khoản (mật khẩu 123456): admin (SA, chủ tenant gốc), shopdemo (chủ shop), ctv1 (F1, aff_code CTV1AFF), khach1 (khách lẻ)');
}

await main();
await prisma.$disconnect();
