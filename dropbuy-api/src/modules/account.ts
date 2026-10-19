// Tài khoản: đăng ký / kích hoạt / quên mật khẩu, đăng nhập (JWT), hồ sơ, MFA, địa chỉ, ngân hàng, chặn shop.
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { E } from '../lib/http.js';
import { route, body, query, params, input } from '../lib/router.js';
import { hashPassword, checkPassword, signToken, requireUser, tenantOf, currentUser } from '../lib/auth.js';
import { hex, uuid } from '../lib/ids.js';
import { newSecret, verifyTotp, otpauthUrl } from '../lib/totp.js';
import { paging, paged, opt } from '../lib/paging.js';
import { profileOf, addressesOut } from '../lib/serialize.js';

const required = (b: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (b[k] === undefined || b[k] === null || b[k] === '') throw E.invalid(`Thiếu trường ${k}`);
};

export default function account(app: FastifyInstance) {
  // ── Đăng ký ──
  route(app, 'POST', '/bff/register', async (req) => {
    const b = body(req);
    required(b, ['username', 'password', 'fullname', 'phone', 'email']);
    if (!/^[a-zA-Z0-9_.]{4,32}$/.test(b.username)) throw E.invalid('username 4-32 ký tự: chữ, số, _ .');
    if (String(b.password).length < 6) throw E.invalid('Mật khẩu tối thiểu 6 ký tự');
    const tenant = await tenantOf(req);
    if (await prisma.user.findFirst({ where: { OR: [{ username: b.username }, { email: b.email }] } })) throw E.conflict('username hoặc email đã được sử dụng');

    // registration_code = mã giới thiệu (aff_code của người giới thiệu)
    let parent_user_id: number | null = null;
    if (b.registration_code) {
      const p = await prisma.user.findUnique({ where: { aff_code: String(b.registration_code) } });
      if (!p) throw E.invalid('Mã giới thiệu không tồn tại');
      parent_user_id = p.id;
    }
    const activation_code = hex(16);
    const user = await prisma.user.create({
      data: {
        username: b.username,
        email: b.email,
        phone: b.phone,
        password_hash: await hashPassword(b.password),
        fullname: b.fullname,
        link_fb: b.link_fb ?? '',
        cccd: b.cccd ?? '',
        default_address: b.default_address ?? '',
        parent_user_id,
        tenant_id: tenant.id,
        bank_ref_user_code: `DB${hex(4).toUpperCase()}`,
        activation_code,
        status: 'P',
      },
    });
    if (parent_user_id) await prisma.userReferral.create({ data: { user_id: user.id, parent_user_id, status: 'W' } });
    // Email kích hoạt: hệ thống thật gửi mail; ở đây log ra (dev) và trả code khi NODE_ENV != production
    req.log.info({ user: user.username, activation_code }, 'activation code');
    return { user_id: user.id, status: user.status, ...(process.env.NODE_ENV !== 'production' ? { activation_code } : {}) };
  });

  route(app, 'GET', '/bff/register/verify-email/:activation_code', async (req) => {
    const u = await prisma.user.findUnique({ where: { activation_code: params(req).activation_code } });
    if (!u) throw E.notFound('Mã kích hoạt');
    const x = await prisma.user.update({ where: { id: u.id }, data: { status: 'A', activation_code: null } });
    return { user_id: x.id, status: x.status };
  });

  route(app, 'GET', '/bff/register/forgot-password', async (req) => {
    const email = String(query(req).email ?? '');
    const u = email ? await prisma.user.findUnique({ where: { email } }) : null;
    // Luôn trả OK để không lộ email nào tồn tại
    if (u) {
      const token = hex(24);
      await prisma.user.update({ where: { id: u.id }, data: { reset_token: token, reset_token_exp: new Date(Date.now() + 30 * 60_000) } });
      req.log.info({ email, token }, 'reset token');
      if (process.env.NODE_ENV !== 'production') return { reset_token: token };
    }
    return null;
  });

  route(app, 'POST', '/bff/register/reset-password', async (req) => {
    const b = body(req);
    required(b, ['token', 'password']);
    const u = await prisma.user.findUnique({ where: { reset_token: String(b.token) } });
    if (!u || !u.reset_token_exp || u.reset_token_exp < new Date()) throw E.invalid('Token không hợp lệ hoặc đã hết hạn');
    await prisma.user.update({ where: { id: u.id }, data: { password_hash: await hashPassword(b.password), reset_token: null, reset_token_exp: null } });
    return null;
  });

  // ── Đăng nhập (FE gốc dùng NextAuth gọi nội bộ; ở đây mở endpoint trả JWT) ──
  route(app, 'POST', '/bff/auth/login', async (req) => {
    const b = body(req);
    required(b, ['username', 'password']);
    const u = await prisma.user.findFirst({ where: { OR: [{ username: b.username }, { email: b.username }, { phone: b.username }] } });
    if (!u || !(await checkPassword(String(b.password), u.password_hash))) throw E.badCredentials();
    if (u.status !== 'A') throw E.inactive();
    if (u.mfa_enabled && u.mfa_secret) {
      if (!b.totp_code) return { mfa_required: true, user_id: u.id };
      if (!verifyTotp(u.mfa_secret, String(b.totp_code))) throw E.mfaInvalid();
    }
    return { access_token: await signToken(u), token_type: 'Bearer', expires_in: 7 * 86400, user: await profileOf(u) };
  });

  route(app, 'GET', '/bff/auth/session', async (req) => {
    const u = await currentUser(req);
    return u ? { user: await profileOf(u) } : null;
  });

  // ── Hồ sơ ──
  route(app, 'GET', '/bff/profile/me', async (req) => profileOf(await requireUser(req)));
  route(app, 'GET', '/bff/profile/:fx_hash/me', async (req) => {
    await tenantOf(req);
    return profileOf(await requireUser(req));
  });

  route(app, 'PUT', '/bff/profile/me', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    const data: Record<string, unknown> = {};
    for (const k of ['email', 'phone', 'link_fb', 'fullname', 'default_address', 'cccd']) if (b[k] !== undefined) data[k] = b[k];
    if (data.email && data.email !== u.email && (await prisma.user.findUnique({ where: { email: String(data.email) } }))) throw E.conflict('Email đã được sử dụng');
    return profileOf(await prisma.user.update({ where: { id: u.id }, data }));
  });

  route(app, 'PUT', '/bff/profile/change-password', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    required(b, ['old_password', 'new_password']);
    if (!(await checkPassword(String(b.old_password), u.password_hash))) throw E.invalid('Mật khẩu cũ không đúng');
    if (String(b.new_password).length < 6) throw E.invalid('Mật khẩu tối thiểu 6 ký tự');
    await prisma.user.update({ where: { id: u.id }, data: { password_hash: await hashPassword(b.new_password) } });
    return null;
  });

  route(app, 'GET', '/bff/profile/:fx_hash/generate-aff', async (req) => {
    const u = await requireUser(req);
    const tenant = await tenantOf(req);
    const aff_code = u.aff_code ?? (await prisma.user.update({ where: { id: u.id }, data: { aff_code: `A${u.id}${hex(3)}` } })).aff_code!;
    return { aff_code, aff_link: `https://${tenant.domain_primary ?? 'localhost'}/?ref=${aff_code}` };
  });

  // MFA: bước 1 gọi mfa-on không có totp → nhận secret; bước 2 gửi totp để bật
  route(app, 'POST', '/bff/profile/:fx_hash/mfa-on', async (req) => {
    const u = await requireUser(req);
    const { totp } = body(req);
    if (u.mfa_enabled) throw E.business('MFA đã được bật');
    if (!totp) {
      const secret = u.mfa_secret ?? newSecret();
      if (!u.mfa_secret) await prisma.user.update({ where: { id: u.id }, data: { mfa_secret: secret } });
      return { secret, otpauth_url: otpauthUrl(secret, u.username) };
    }
    if (!u.mfa_secret || !verifyTotp(u.mfa_secret, String(totp))) throw E.mfaInvalid();
    await prisma.user.update({ where: { id: u.id }, data: { mfa_enabled: true, mfa_enabled_at: new Date() } });
    return { mfa_enabled: true };
  });

  route(app, 'POST', '/bff/profile/:fx_hash/mfa-off', async (req) => {
    const u = await requireUser(req);
    const { totp } = body(req);
    if (!u.mfa_enabled || !u.mfa_secret) throw E.business('MFA chưa bật');
    if (!verifyTotp(u.mfa_secret, String(totp ?? ''))) throw E.mfaInvalid();
    await prisma.user.update({ where: { id: u.id }, data: { mfa_enabled: false, mfa_enabled_at: null, mfa_secret: null } });
    return { mfa_enabled: false };
  });

  route(app, 'POST', '/bff/profile/:fx_hash/update-vat-info', async (req) => {
    const u = await requireUser(req);
    const v = body(req).vat_info;
    await prisma.user.update({ where: { id: u.id }, data: { vat_info: v == null ? null : typeof v === 'string' ? v : JSON.stringify(v) } });
    return null;
  });

  // ── Chặn shop (buyer không thấy sp của shop) ──
  const blockOut = async (rows: { unique_id: string; shop_id: number; user_id: number; created_at: Date }[]) => {
    const shops = await prisma.shop.findMany({ where: { id: { in: rows.map((r) => r.shop_id) } } });
    const sm = new Map(shops.map((s) => [s.id, s]));
    return rows.map((r) => ({
      unique_id: r.unique_id, shop_id: r.shop_id, shop_user_id: sm.get(r.shop_id)?.user_id ?? null, buyer_user_id: r.user_id,
      block_type: 'M', created_at: r.created_at, updated_at: r.created_at, shop_name: sm.get(r.shop_id)?.display_name ?? null, shop_pic_name: sm.get(r.shop_id)?.fullname ?? null,
    }));
  };
  route(app, 'GET', '/bff/profile/block-shops/:fx_hash/list', async (req) => {
    const u = await requireUser(req);
    const q = query(req);
    const p = paging(q);
    const kw = opt(q.keyword) as string | undefined;
    const shopIds = kw ? (await prisma.shop.findMany({ where: { display_name: { contains: kw } }, select: { id: true } })).map((s) => s.id) : undefined;
    const where = { user_id: u.id, ...(shopIds ? { shop_id: { in: shopIds } } : {}) };
    const [total, rows] = await Promise.all([prisma.userBlockShop.count({ where }), prisma.userBlockShop.findMany({ where, skip: p.skip, take: p.take, orderBy: { id: 'desc' } })]);
    return paged(p, total, await blockOut(rows));
  });
  route(app, 'POST', '/bff/profile/block-shops/:fx_hash/block', async (req) => {
    const u = await requireUser(req);
    const shop_id = Number(body(req).shop_id);
    if (!(await prisma.shop.findUnique({ where: { id: shop_id } }))) throw E.notFound('Shop');
    const r = await prisma.userBlockShop.upsert({ where: { user_id_shop_id: { user_id: u.id, shop_id } }, create: { unique_id: uuid(), user_id: u.id, shop_id }, update: {} });
    return (await blockOut([r]))[0];
  });
  route(app, 'POST', '/bff/profile/block-shops/:fx_hash/unblock', async (req) => {
    const u = await requireUser(req);
    await prisma.userBlockShop.deleteMany({ where: { user_id: u.id, shop_id: Number(body(req).shop_id) } });
    return null;
  });

  // ── Sổ địa chỉ ──
  const addrData = (b: Record<string, any>) => ({
    fullname: String(b.fullname), phone: String(b.phone), address_line: String(b.address_line),
    province_id: Number(b.province_id), district_id: Number(b.district_id ?? 0), ward_id: Number(b.ward_id),
    is_default: !!b.is_default, note: b.note ?? null,
  });
  const clearDefault = (user_id: number) => prisma.address.updateMany({ where: { user_id, is_default: true }, data: { is_default: false } });

  route(app, 'POST', '/bff/my-address', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    required(b, ['fullname', 'phone', 'address_line', 'province_id', 'ward_id']);
    const count = await prisma.address.count({ where: { user_id: u.id } });
    const data = addrData(b);
    if (count === 0) data.is_default = true;
    if (data.is_default) await clearDefault(u.id);
    const a = await prisma.address.create({ data: { ...data, unique_id: uuid(), user_id: u.id, kind: b.kind === 'R' ? 'R' : 'S' } });
    return (await addressesOut([a]))[0];
  });
  route(app, 'PUT', '/bff/my-address', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    const a = await prisma.address.findUnique({ where: { unique_id: String(b.unique_id) } });
    if (!a || a.user_id !== u.id) throw E.notFound('Địa chỉ');
    const data = { ...addrData({ ...a, ...b }) };
    if (data.is_default) await clearDefault(u.id);
    return (await addressesOut([await prisma.address.update({ where: { id: a.id }, data })]))[0];
  });
  route(app, 'DELETE', '/bff/my-address/:unique_id', async (req) => {
    const u = await requireUser(req);
    const r = await prisma.address.deleteMany({ where: { unique_id: params(req).unique_id, user_id: u.id } });
    if (!r.count) throw E.notFound('Địa chỉ');
    return null;
  });
  route(app, 'GET', '/bff/my-address/list', async (req) => {
    const u = await requireUser(req);
    const q = query(req);
    const p = paging(q, 50);
    const kw = opt(q.keyword) as string | undefined;
    const where = { user_id: u.id, ...(opt(q.kind) ? { kind: String(q.kind) } : {}), ...(kw ? { OR: [{ fullname: { contains: kw } }, { phone: { contains: kw } }, { address_line: { contains: kw } }] } : {}) };
    const [total, rows] = await Promise.all([prisma.address.count({ where }), prisma.address.findMany({ where, orderBy: [{ is_default: 'desc' }, { id: 'desc' }], skip: p.skip, take: p.take })]);
    return paged(p, total, await addressesOut(rows));
  });

  // ── Tài khoản ngân hàng nhận tiền rút ──
  const bankOut = (b: { unique_id: string; user_id: number; is_default: boolean; bank_name: string; bank_code: string; acc_number: string; acc_name: string; created_at: Date }) => ({ ...b, updated_at: b.created_at });
  route(app, 'GET', '/bff/user-bank-info/list', async (req) => {
    const u = await requireUser(req);
    const rows = await prisma.userBankInfo.findMany({ where: { user_id: u.id }, orderBy: [{ is_default: 'desc' }, { id: 'asc' }] });
    return rows.map(({ id: _id, ...r }) => bankOut(r));
  });
  route(app, 'POST', '/bff/user-bank-info', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    required(b, ['bank_name', 'bank_code', 'acc_number', 'acc_name']);
    const first = (await prisma.userBankInfo.count({ where: { user_id: u.id } })) === 0;
    const is_default = first || !!b.is_default;
    if (is_default) await prisma.userBankInfo.updateMany({ where: { user_id: u.id }, data: { is_default: false } });
    const { id: _id, ...r } = await prisma.userBankInfo.create({ data: { unique_id: uuid(), user_id: u.id, bank_name: b.bank_name, bank_code: b.bank_code, acc_number: String(b.acc_number), acc_name: String(b.acc_name).toUpperCase(), is_default } });
    return bankOut(r);
  });
  route(app, 'PUT', '/bff/user-bank-info', async (req) => {
    const u = await requireUser(req);
    const b = input(req);
    const cur = await prisma.userBankInfo.findUnique({ where: { unique_id: String(b.unique_id) } });
    if (!cur || cur.user_id !== u.id) throw E.notFound('Tài khoản ngân hàng');
    if (b.is_default) await prisma.userBankInfo.updateMany({ where: { user_id: u.id }, data: { is_default: false } });
    const data: Record<string, unknown> = {};
    for (const k of ['bank_name', 'bank_code', 'acc_number', 'acc_name']) if (b[k] !== undefined) data[k] = String(b[k]);
    if (b.is_default !== undefined) data.is_default = !!b.is_default;
    const { id: _id, ...r } = await prisma.userBankInfo.update({ where: { id: cur.id }, data });
    return bankOut(r);
  });
}
