import type { FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import type { User, Shop, Tenant } from '@prisma/client';
import { prisma } from './db.js';
import { E } from './http.js';
import { verifyTotp } from './totp.js';

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET || 'dev-secret-change-me');
const TOKEN_TTL = '7d';

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);

export async function signToken(user: Pick<User, 'id' | 'tenant_id'>) {
  return new SignJWT({ tid: user.tenant_id })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secret());
}

type Ctx = { user?: User | null; shop?: Shop | null; tenant?: Tenant };
const ctx = new WeakMap<FastifyRequest, Ctx>();
const c = (req: FastifyRequest) => {
  let x = ctx.get(req);
  if (!x) ctx.set(req, (x = {}));
  return x;
};

/** User hiện tại hoặc null (không bắt buộc đăng nhập). */
export async function currentUser(req: FastifyRequest): Promise<User | null> {
  const x = c(req);
  if (x.user !== undefined) return x.user;
  const h = req.headers.authorization;
  x.user = null;
  if (h?.startsWith('Bearer ')) {
    try {
      const { payload } = await jwtVerify(h.slice(7), secret());
      const u = await prisma.user.findUnique({ where: { id: Number(payload.sub) } });
      if (u && u.status !== 'L') x.user = u;
    } catch {
      /* token sai/hết hạn → coi như khách */
    }
  }
  return x.user;
}

export async function requireUser(req: FastifyRequest): Promise<User> {
  const u = await currentUser(req);
  if (!u) throw E.unauthorized();
  if (u.status !== 'A') throw E.inactive();
  return u;
}

export async function requireShop(req: FastifyRequest): Promise<{ user: User; shop: Shop }> {
  const user = await requireUser(req);
  const x = c(req);
  if (x.shop === undefined) x.shop = await prisma.shop.findUnique({ where: { user_id: user.id } });
  if (!x.shop) throw E.forbidden('Bạn chưa đăng ký gian hàng');
  if (x.shop.status === 'L' || x.shop.admin_status === 'L') throw E.forbidden('Gian hàng đang bị khoá');
  return { user, shop: x.shop };
}

export async function requireSA(req: FastifyRequest): Promise<User> {
  const u = await requireUser(req);
  if (!u.is_sa) throw E.forbidden('Chỉ quản trị hệ thống (SA) được phép');
  return u;
}

/** Tenant từ path param fx_hash, header x-tenant-fx-hash hoặc tenant mặc định. */
export async function tenantOf(req: FastifyRequest): Promise<Tenant> {
  const x = c(req);
  if (x.tenant) return x.tenant;
  const p = (req.params as Record<string, string> | undefined)?.fx_hash;
  const h = req.headers['x-tenant-fx-hash'];
  const fx = p || (typeof h === 'string' ? h : undefined) || process.env.DEFAULT_TENANT_FX_HASH;
  const t = fx ? await prisma.tenant.findUnique({ where: { fx_hash: fx } }) : await prisma.tenant.findFirst({ orderBy: { id: 'asc' } });
  if (!t) throw E.notFound('Tenant (fx_hash)');
  if (t.status === 'L') throw E.forbidden('Website đang bị khoá');
  x.tenant = t;
  return t;
}

export async function requireTenantOwner(req: FastifyRequest): Promise<{ user: User; tenant: Tenant }> {
  const user = await requireUser(req);
  const tenant = await tenantOf(req);
  if (tenant.owner_user_id !== user.id && !user.is_sa) throw E.forbidden('Chỉ chủ website (tenant owner) được phép');
  return { user, tenant };
}

/** Thao tác nhạy cảm: nếu user bật MFA thì bắt buộc totp_code hợp lệ. */
export function requireMfa(user: User, code: unknown) {
  if (!user.mfa_enabled || !user.mfa_secret) return;
  if (!code) throw E.mfaRequired();
  if (!verifyTotp(user.mfa_secret, String(code))) throw E.mfaInvalid();
}

/** Định danh giỏ hàng/khách: client_id do trình duyệt sinh. */
export function clientIdOf(req: FastifyRequest, body?: Record<string, unknown>) {
  const v = body?.client_id ?? (req.query as Record<string, unknown> | undefined)?.client_id ?? req.headers['x-client-id'];
  if (!v || typeof v !== 'string') throw E.invalid('Thiếu client_id');
  return v;
}
