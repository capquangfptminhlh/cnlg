// Hệ thống CTV: duyệt tài khoản cấp dưới, nhóm hoa hồng (+ theo sản phẩm), nâng cấp F1, yêu cầu đổi người giới thiệu.
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma, Decimal } from '../lib/db.js';
import { E } from '../lib/http.js';
import { route, body, query, params, input, arr, type Req } from '../lib/router.js';
import { requireUser } from '../lib/auth.js';
import { paging, paged, opt } from '../lib/paging.js';
import { uuid, code } from '../lib/ids.js';

/** Đường dẫn cấp trên: "1/5/9" (gốc → user) */
async function userPath(user_id: number) {
  const ids: number[] = [];
  let cur: number | null = user_id;
  for (let i = 0; cur && i < 20; i++) {
    ids.unshift(cur);
    const u: { parent_user_id: number | null } | null = await prisma.user.findUnique({ where: { id: cur }, select: { parent_user_id: true } });
    cur = u?.parent_user_id ?? null;
  }
  return ids.join('/');
}

const groupOut = (g: Awaited<ReturnType<typeof prisma.userReferralGroup.findFirstOrThrow>>) => ({ id: g.id, user_id: g.owner_user_id, title: g.title, commission: g.commission, created_at: g.created_at, updated_at: g.updated_at, is_default: g.is_default });

async function myGroup(req: Req, id: unknown) {
  const u = await requireUser(req);
  const g = await prisma.userReferralGroup.findUnique({ where: { id: Number(id) } });
  if (!g || g.owner_user_id !== u.id) throw E.notFound('Nhóm hoa hồng');
  return { u, g };
}

const commissionOf = (v: unknown) => {
  const c = new Decimal(String(v ?? 'NaN'));
  if (!c.isFinite() || c.lt(0) || c.gt(100)) throw E.invalid('commission là % trong khoảng 0..100');
  return c;
};

export default function referral(app: FastifyInstance) {
  // ── Tài khoản cấp dưới ──
  route(app, 'GET', '/bff/user-referrals/list', async (req) => {
    const u = await requireUser(req);
    const q = query(req);
    const p = paging(q);
    const where: Prisma.UserReferralWhereInput = { parent_user_id: u.id, ...(q.pending_approve === 'T' ? { status: 'W' } : opt(q.status) ? { status: String(q.status) } : {}) };
    const [total, rows] = await Promise.all([prisma.userReferral.count({ where }), prisma.userReferral.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.user_id) } } });
    return paged(p, total, await Promise.all(rows.map(async (r) => {
      const x = users.find((y) => y.id === r.user_id)!;
      return { user_id: r.user_id, parent_user_id: r.parent_user_id, user_level: x.user_level, created_at: r.created_at, updated_at: r.approved_at, referral_group_id: r.referral_group_id, referral_status: r.status, user_path: await userPath(r.user_id), username: x.username, email: x.email, phone: x.phone, fullname: x.fullname, user_status: x.status };
    })));
  });

  // items: [{ user_id, user_referral_group_id }] – duyệt & xếp nhóm (có thể đổi nhóm cho user đã duyệt)
  route(app, 'PUT', '/bff/user-referrals/approve', async (req) => {
    const u = await requireUser(req);
    if (u.user_level !== 1 && !u.is_sa) throw E.forbidden('Chỉ tài khoản F1 duyệt cấp dưới');
    const out = [];
    for (const it of arr<{ user_id: number; user_referral_group_id?: number }>(body(req).items)) {
      const r = await prisma.userReferral.findUnique({ where: { user_id: Number(it.user_id) } });
      if (!r || r.parent_user_id !== u.id) { out.push({ user_id: it.user_id, user_referral_group_id: it.user_referral_group_id ?? null, message: 'Không phải tài khoản cấp dưới của bạn' }); continue; }
      let gid = it.user_referral_group_id != null ? Number(it.user_referral_group_id) : null;
      if (gid == null) gid = (await prisma.userReferralGroup.findFirst({ where: { owner_user_id: u.id, is_default: true } }))?.id ?? null;
      if (gid != null) {
        const g = await prisma.userReferralGroup.findUnique({ where: { id: gid } });
        if (!g || g.owner_user_id !== u.id) { out.push({ user_id: it.user_id, user_referral_group_id: gid, message: 'Nhóm không hợp lệ' }); continue; }
      }
      await prisma.userReferral.update({ where: { id: r.id }, data: { status: 'A', referral_group_id: gid, approved_at: r.approved_at ?? new Date() } });
      await prisma.user.update({ where: { id: r.user_id }, data: { user_level: 2 } });
      out.push({ user_id: r.user_id, user_referral_group_id: gid, message: 'OK' });
    }
    return out;
  });

  // Nâng cấp lên F1 (tách khỏi bảng giá nhóm; vẫn giữ người giới thiệu để thống kê)
  route(app, 'POST', '/bff/user-referrals/:fx_hash/upgrade-f1', async (req) => {
    const u = await requireUser(req);
    if (u.user_level === 1) throw E.business('Tài khoản đã là F1');
    const done = await prisma.order.count({ where: { buyer_user_id: u.id, order_status: 'D' } });
    const minOrders = Number(process.env.UPGRADE_F1_MIN_ORDERS ?? 1);
    if (done < minOrders) throw E.business(`Cần tối thiểu ${minOrders} đơn hoàn thành để lên F1`);
    await prisma.user.update({ where: { id: u.id }, data: { user_level: 1 } });
    await prisma.userReferral.updateMany({ where: { user_id: u.id }, data: { referral_group_id: null } });
    return { user_level: 1 };
  });

  // ── Nhóm hoa hồng ──
  route(app, 'GET', '/bff/user-referral-groups/list', async (req) => {
    const u = await requireUser(req);
    const p = paging(query(req));
    const where = { owner_user_id: u.id };
    const [total, rows] = await Promise.all([prisma.userReferralGroup.count({ where }), prisma.userReferralGroup.findMany({ where, orderBy: { id: 'asc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map(groupOut));
  });
  route(app, 'GET', '/bff/user-referral-groups/:referral_group_id', async (req) => groupOut((await myGroup(req, params(req).referral_group_id)).g));
  route(app, 'POST', '/bff/user-referral-groups/create', async (req) => {
    const u = await requireUser(req);
    if (u.user_level !== 1 && !u.is_sa) throw E.forbidden('Chỉ F1 tạo nhóm hoa hồng');
    const b = body(req);
    if (!b.title) throw E.invalid('Thiếu title');
    const first = (await prisma.userReferralGroup.count({ where: { owner_user_id: u.id } })) === 0;
    const is_default = first || !!b.is_default;
    if (is_default) await prisma.userReferralGroup.updateMany({ where: { owner_user_id: u.id }, data: { is_default: false } });
    return groupOut(await prisma.userReferralGroup.create({ data: { owner_user_id: u.id, title: String(b.title), commission: commissionOf(b.commission), is_default } }));
  });
  route(app, 'PUT', '/bff/user-referral-groups/update', async (req) => {
    const b = body(req);
    const { u, g } = await myGroup(req, b.id);
    if (b.is_default) await prisma.userReferralGroup.updateMany({ where: { owner_user_id: u.id }, data: { is_default: false } });
    return groupOut(await prisma.userReferralGroup.update({ where: { id: g.id }, data: { title: b.title ?? undefined, commission: b.commission != null ? commissionOf(b.commission) : undefined, is_default: b.is_default != null ? !!b.is_default : undefined } }));
  });
  route(app, 'DELETE', '/bff/user-referral-groups/:referral_group_id', async (req) => {
    const { g } = await myGroup(req, params(req).referral_group_id);
    if (await prisma.userReferral.count({ where: { referral_group_id: g.id } })) throw E.business('Nhóm còn thành viên – chuyển thành viên sang nhóm khác trước');
    await prisma.userReferralGroupDetail.deleteMany({ where: { referral_group_id: g.id } });
    await prisma.userReferralGroup.delete({ where: { id: g.id } });
    return null;
  });

  // ── Hoa hồng riêng theo sản phẩm ──
  const detailOut = async (rows: Awaited<ReturnType<typeof prisma.userReferralGroupDetail.findMany>>) => {
    const ps = await prisma.product.findMany({ where: { id: { in: rows.map((r) => r.product_id) } }, select: { id: true, name: true } });
    return rows.map((r) => ({ unique_id: r.unique_id, referral_group_id: r.referral_group_id, product_id: r.product_id, commission: r.commission, created_at: r.created_at, updated_at: r.updated_at, product_name: ps.find((p) => p.id === r.product_id)?.name ?? null }));
  };
  route(app, 'GET', '/bff/user-referral-group-details/list', async (req) => {
    const u = await requireUser(req);
    const q = query(req);
    const groups = (await prisma.userReferralGroup.findMany({ where: { owner_user_id: u.id, ...(q.referral_group_id ? { id: Number(q.referral_group_id) } : {}) } })).map((g) => g.id);
    return detailOut(await prisma.userReferralGroupDetail.findMany({ where: { referral_group_id: { in: groups } }, orderBy: { id: 'asc' } }));
  });
  route(app, 'POST', '/bff/user-referral-group-details/ensure', async (req) => {
    const b = body(req);
    const { g } = await myGroup(req, b.referral_group_id);
    const product_id = Number(b.product_id);
    if (!(await prisma.product.findUnique({ where: { id: product_id } }))) throw E.notFound('Sản phẩm');
    const commission = commissionOf(b.commission);
    await prisma.userReferralGroupDetail.upsert({ where: { referral_group_id_product_id: { referral_group_id: g.id, product_id } }, create: { unique_id: uuid(), referral_group_id: g.id, product_id, commission }, update: { commission } });
    return detailOut(await prisma.userReferralGroupDetail.findMany({ where: { referral_group_id: g.id } }));
  });
  route(app, 'PUT', '/bff/user-referral-group-details/delete', async (req) => {
    const b = body(req);
    const { g } = await myGroup(req, b.referral_group_id);
    await prisma.userReferralGroupDetail.deleteMany({ where: { referral_group_id: g.id, product_id: Number(b.product_id) } });
    return null;
  });

  // ── Đổi người giới thiệu ──
  const reqOut = async (rows: Awaited<ReturnType<typeof prisma.changeReferralRequest.findMany>>) => {
    const users = await prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.user_id, r.to_parent_user_id]) } } });
    return Promise.all(rows.map(async (r) => {
      const u = users.find((x) => x.id === r.user_id);
      const np = users.find((x) => x.id === r.to_parent_user_id);
      return {
        unique_id: r.code, user_id: r.user_id, current_referral_user_id: r.from_parent_user_id, current_user_path: await userPath(r.user_id), new_referral_user_id: r.to_parent_user_id,
        new_referral_user_level: np?.user_level ?? null, new_user_path: `${await userPath(r.to_parent_user_id)}/${r.user_id}`, status: r.status, notes: r.reason, created_at: r.created_at,
        rejected_at: r.status === 'R' ? r.processed_at : null, approved_at: r.status === 'A' ? r.processed_at : null, user_phone: u?.phone ?? null, user_fullname: u?.fullname ?? null,
      };
    }));
  };
  route(app, 'POST', '/bff/change-referral-requests/:fx_hash/submit', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    const np = await prisma.user.findUnique({ where: { id: Number(b.new_referral_user_id) } });
    if (!np || np.status !== 'A') throw E.notFound('Người giới thiệu mới');
    if (np.id === u.id || np.id === u.parent_user_id) throw E.invalid('Người giới thiệu mới không hợp lệ');
    if ((await userPath(np.id)).split('/').includes(String(u.id))) throw E.invalid('Không thể chọn tài khoản cấp dưới của mình làm người giới thiệu');
    if (await prisma.changeReferralRequest.findFirst({ where: { user_id: u.id, status: 'P' } })) throw E.conflict('Bạn đang có yêu cầu chờ duyệt');
    const r = await prisma.changeReferralRequest.create({ data: { code: code('DGT'), user_id: u.id, from_parent_user_id: u.parent_user_id, to_parent_user_id: np.id, reason: b.notes ?? null } });
    return (await reqOut([r]))[0];
  });
  const list = (mine: boolean) => async (req: Req) => {
    const u = await requireUser(req);
    const b = input(req);
    const p = paging(b);
    const where: Prisma.ChangeReferralRequestWhereInput = mine ? { user_id: u.id } : { to_parent_user_id: u.id };
    if (opt(b.status)) where.status = String(b.status);
    const [total, rows] = await Promise.all([prisma.changeReferralRequest.count({ where }), prisma.changeReferralRequest.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await reqOut(rows));
  };
  route(app, 'POST', '/bff/change-referral-requests/:fx_hash/list', list(false));
  route(app, 'POST', '/bff/change-referral-requests/:fx_hash/list-my-requests', list(true));
  const pending = async (req: Req, as: 'new' | 'self') => {
    const u = await requireUser(req);
    const r = await prisma.changeReferralRequest.findUnique({ where: { code: String(body(req).unique_id ?? '') } });
    if (!r || (as === 'new' ? r.to_parent_user_id : r.user_id) !== u.id) throw E.notFound('Yêu cầu');
    if (r.status !== 'P') throw E.business('Yêu cầu đã được xử lý');
    return { u, r };
  };
  route(app, 'POST', '/bff/change-referral-requests/:fx_hash/approve', async (req) => {
    const { u, r } = await pending(req, 'new');
    const b = body(req);
    const gid = b.new_referral_group_id != null ? Number(b.new_referral_group_id) : (await prisma.userReferralGroup.findFirst({ where: { owner_user_id: u.id, is_default: true } }))?.id ?? null;
    if (gid != null && (await prisma.userReferralGroup.findUnique({ where: { id: gid } }))?.owner_user_id !== u.id) throw E.invalid('Nhóm không hợp lệ');
    await prisma.$transaction([
      prisma.user.update({ where: { id: r.user_id }, data: { parent_user_id: u.id } }),
      prisma.userReferral.upsert({ where: { user_id: r.user_id }, create: { user_id: r.user_id, parent_user_id: u.id, referral_group_id: gid, status: 'A', approved_at: new Date() }, update: { parent_user_id: u.id, referral_group_id: gid, status: 'A', approved_at: new Date() } }),
      prisma.changeReferralRequest.update({ where: { id: r.id }, data: { status: 'A', processed_at: new Date() } }),
    ]);
    return null;
  });
  route(app, 'POST', '/bff/change-referral-requests/:fx_hash/reject', async (req) => {
    const { r } = await pending(req, 'new');
    await prisma.changeReferralRequest.update({ where: { id: r.id }, data: { status: 'R', processed_at: new Date(), reason: body(req).notes ?? r.reason } });
    return null;
  });
  route(app, 'POST', '/bff/change-referral-requests/:fx_hash/cancel', async (req) => {
    const { r } = await pending(req, 'self');
    await prisma.changeReferralRequest.update({ where: { id: r.id }, data: { status: 'C', processed_at: new Date() } });
    return null;
  });
}
