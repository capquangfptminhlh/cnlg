// Ví: số dư nhiều loại, sao kê, nạp (QR) / rút, chuyển khả dụng ↔ đặt cọc, chuyển xu P2P có khiếu nại, sàn mua bán xu, racing (đổi phiếu mua hàng).
import type { FastifyInstance } from 'fastify';
import type { Prisma, User } from '@prisma/client';
import { prisma, Decimal, type Tx } from '../lib/db.js';
import { E } from '../lib/http.js';
import { route, body, query, params, input, type Req } from '../lib/router.js';
import { requireUser, requireSA, tenantOf, requireMfa } from '../lib/auth.js';
import { paging, paged, opt, dateRange } from '../lib/paging.js';
import { code, uuid } from '../lib/ids.js';
import { post, ensureBalance, type BalanceTypeT } from '../lib/balance.js';

const NAMES: Record<string, string> = { A: 'Ví khả dụng', L: 'Ví đặt cọc', D: 'Ví ký quỹ', X: 'Ví phiếu mua hàng', U: 'Điểm uy tín' };
const XU_RATE = () => new Decimal(process.env.XU_PER_VND ?? 1); // hệ số quy đổi VND → xu khi nạp xu

const amountOf = (v: unknown, name = 'amount') => {
  const a = new Decimal(String(v ?? 0));
  if (a.lte(0) || !a.isFinite()) throw E.invalid(`${name} phải lớn hơn 0`);
  return a;
};

function vietQr(content: string, amount?: Decimal) {
  const bank = process.env.QR_BANK_BIN ?? '970436';
  const acc = process.env.QR_BANK_ACCOUNT ?? '0000000000';
  const name = encodeURIComponent(process.env.QR_BANK_ACCOUNT_NAME ?? 'DROPBUY');
  return `https://img.vietqr.io/image/${bank}-${acc}-compact2.png?addInfo=${encodeURIComponent(content)}&accountName=${name}${amount ? `&amount=${amount}` : ''}`;
}

async function transferOut(t: Awaited<ReturnType<typeof prisma.balanceTransfer.findFirstOrThrow>>) {
  const users = await prisma.user.findMany({ where: { id: { in: [t.from_user_id, t.to_user_id] } }, select: { id: true, username: true, fullname: true } });
  return {
    code: t.code, from_user_id: t.from_user_id, from_username: users.find((u) => u.id === t.from_user_id)?.username, from_balance_type: t.from_balance_type,
    to_user_id: t.to_user_id, to_username: users.find((u) => u.id === t.to_user_id)?.username, to_balance_type: t.to_balance_type,
    transfer_amount: t.transfer_amount, status: t.status, kn_status: t.complain_status, notes: t.notes, complain_notes: t.complain_notes, complain_by_user_id: t.complain_by_user_id, created_at: t.created_at, updated_at: t.updated_at,
  };
}

async function exchangeOut(r: Awaited<ReturnType<typeof prisma.xuExchangeRequest.findFirstOrThrow>>, withDetails = false) {
  const matches = await prisma.xuExchangeMatch.findMany({ where: r.side === 'B' ? { buy_request_id: r.id } : { sell_request_id: r.id }, orderBy: { id: 'asc' } });
  return {
    id: r.id, code: r.code, user_id: r.user_id, side: r.side, rate: r.rate, xu_volume: r.xu_volume, commodity_amount: r.commodity_amount,
    origin_xu_volume: r.origin_xu_volume, origin_commodity_amount: r.origin_commodity_amount, status: r.status, created_at: r.created_at, done_at: r.done_at, cancel_at: r.cancel_at,
    total_xu_volume_mapping: matches.reduce((a, m) => a.plus(m.xu_volume), new Decimal(0)),
    total_commodity_amount_mapping: matches.reduce((a, m) => a.plus(m.commodity_amount), new Decimal(0)),
    details: withDetails ? matches : undefined,
  };
}

/** Khớp lệnh: lệnh mới (taker) khớp với lệnh đối ứng tốt nhất; giá khớp = giá của lệnh đang chờ (maker). */
async function matchOrder(tx: Tx, takerId: number) {
  let taker = await tx.xuExchangeRequest.findUniqueOrThrow({ where: { id: takerId } });
  const makers = await tx.xuExchangeRequest.findMany({
    where: { tenant_id: taker.tenant_id, status: 'P', side: taker.side === 'B' ? 'S' : 'B', user_id: { not: taker.user_id }, rate: taker.side === 'B' ? { lte: taker.rate } : { gte: taker.rate } },
    orderBy: [{ rate: taker.side === 'B' ? 'asc' : 'desc' }, { id: 'asc' }],
  });
  for (const maker of makers) {
    if (taker.xu_volume.lte(0)) break;
    const vol = Decimal.min(taker.xu_volume, maker.xu_volume);
    const money = vol.mul(maker.rate).toDecimalPlaces(0);
    const buy = taker.side === 'B' ? taker : maker;
    const sell = taker.side === 'B' ? maker : taker;
    // Người mua: tiền đã ký quỹ theo giá lệnh mua; trả theo giá khớp, phần dư hoàn lại
    const buyerReserved = vol.mul(buy.rate).toDecimalPlaces(0);
    await post(tx, buy.user_id, 'L', buyerReserved.neg(), { business_code: 'XU_EXCHANGE', business_sub_code: 'BUY_SETTLE', ref_code: buy.code });
    if (buyerReserved.gt(money)) await post(tx, buy.user_id, 'A', buyerReserved.minus(money), { business_code: 'XU_EXCHANGE', business_sub_code: 'BUY_REFUND_DIFF', ref_code: buy.code });
    await post(tx, buy.user_id, 'X', vol, { business_code: 'XU_EXCHANGE', business_sub_code: 'BUY_RECEIVE', ref_code: buy.code });
    await post(tx, sell.user_id, 'A', money, { business_code: 'XU_EXCHANGE', business_sub_code: 'SELL_RECEIVE', ref_code: sell.code });
    await tx.xuExchangeMatch.create({ data: { buy_request_id: buy.id, sell_request_id: sell.id, rate: maker.rate, xu_volume: vol, commodity_amount: money } });
    const upd = async (r: typeof taker) => {
      const left = r.xu_volume.minus(vol);
      return tx.xuExchangeRequest.update({ where: { id: r.id }, data: { xu_volume: left, commodity_amount: r.side === 'B' ? r.commodity_amount.minus(buyerReserved) : r.commodity_amount, status: left.lte(0) ? 'D' : 'P', done_at: left.lte(0) ? new Date() : null } });
    };
    await upd(maker);
    taker = await upd(taker);
  }
  return taker;
}

export default function wallet(app: FastifyInstance) {
  // ── Số dư ──
  route(app, 'GET', '/bff/balance/my-balance', async (req) => {
    const u = await requireUser(req);
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const types: BalanceTypeT[] = ['A', 'L', 'X', 'U', ...(u.user_level === 1 ? (['D'] as BalanceTypeT[]) : [])];
    return Promise.all(types.map(async (t) => {
      const b = await prisma.$transaction((tx) => ensureBalance(tx, u.id, t));
      const txns = await prisma.balanceTxn.findMany({ where: { balance_id: b.id, created_at: { gte: monthStart } } });
      const credit = txns.filter((x) => x.action_code === 'I').reduce((a, x) => a.plus(x.amount), new Decimal(0));
      const debit = txns.filter((x) => x.action_code === 'O').reduce((a, x) => a.plus(x.amount), new Decimal(0));
      return { unique_id: b.unique_id, account_code: `${u.bank_ref_user_code}-${t}`, type: t, balance_type: t, month_begin_balance: b.amount.minus(credit).plus(debit), month_credit_balance: credit, month_debit_balance: debit, current_balance: b.amount, display_name: NAMES[t] };
    }));
  });

  route(app, 'POST', '/bff/balance/:fx_hash/sao-ke', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    const p = paging(b);
    const bal = await prisma.balance.findUnique({ where: { user_id_balance_type: { user_id: u.id, balance_type: String(b.balance_type ?? 'A') } } });
    if (!bal) return paged(p, 0, []);
    const where: Prisma.BalanceTxnWhereInput = { balance_id: bal.id };
    for (const k of ['action_code', 'business_code', 'business_sub_code', 'ref_code'] as const) if (opt(b[k])) where[k] = String(b[k]);
    const r = dateRange(b.from_date, b.to_date);
    if (r) where.created_at = r;
    const [total, rows] = await Promise.all([prisma.balanceTxn.count({ where }), prisma.balanceTxn.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, rows.map((t) => ({
      unique_id: t.unique_id, transaction_date: t.created_at.toISOString().slice(0, 10), created_time: t.created_at, balance_id: bal.unique_id, balance_type: bal.balance_type,
      begin_balance: t.action_code === 'I' ? t.balance_after.minus(t.amount) : t.balance_after.plus(t.amount), action_code: t.action_code, amount: t.amount, last_balance: t.balance_after,
      status: 'D', business_code: t.business_code, business_sub_code: t.business_sub_code, ref_code: t.ref_code, notes: t.notes, user_id: t.user_id,
    })));
  });

  // Khả dụng ↔ đặt cọc
  route(app, 'POST', '/bff/balance/:fx_hash/transfer-to-lock', async (req) => {
    const u = await requireUser(req);
    const a = amountOf(body(req).transfer_amount, 'transfer_amount');
    await prisma.$transaction(async (tx) => {
      await post(tx, u.id, 'A', a.neg(), { business_code: 'INTERNAL_TRANSFER', business_sub_code: 'A_TO_L' });
      await post(tx, u.id, 'L', a, { business_code: 'INTERNAL_TRANSFER', business_sub_code: 'A_TO_L' });
    });
    return null;
  });
  route(app, 'POST', '/bff/balance/:fx_hash/transfer-to-avai', async (req) => {
    const u = await requireUser(req);
    const a = amountOf(body(req).transfer_amount, 'transfer_amount');
    // Không rút phần đặt cọc đang bị giữ bởi lệnh mua xu đang mở
    const reserved = (await prisma.xuExchangeRequest.aggregate({ where: { user_id: u.id, side: 'B', status: 'P' }, _sum: { commodity_amount: true } }))._sum.commodity_amount ?? new Decimal(0);
    const lock = await prisma.balance.findUnique({ where: { user_id_balance_type: { user_id: u.id, balance_type: 'L' } } });
    if (!lock || lock.amount.minus(reserved).lt(a)) throw E.insufficient();
    await prisma.$transaction(async (tx) => {
      await post(tx, u.id, 'L', a.neg(), { business_code: 'INTERNAL_TRANSFER', business_sub_code: 'L_TO_A' });
      await post(tx, u.id, 'A', a, { business_code: 'INTERNAL_TRANSFER', business_sub_code: 'L_TO_A' });
    });
    return null;
  });

  // ── Nạp tiền: tạo lệnh nạp chờ + QR chuyển khoản (nội dung chứa mã tham chiếu); SA xác nhận khi tiền về ──
  const depositLink = async (req: Req, balance_type: BalanceTypeT) => {
    const u = await requireUser(req);
    const q = { ...query(req), ...body(req) };
    const amount = q.amount ? amountOf(q.amount) : undefined;
    const dw = await prisma.dwTransaction.create({ data: { code: code('NAP'), user_id: u.id, dw_type: 'D', amount: amount ?? 0, balance_type, site: q.site ?? null } });
    const content = `${u.bank_ref_user_code} ${dw.code}`;
    return { code: dw.code, transfer_content: content, qr_link: vietQr(content, amount), amount: amount ?? null, balance_type };
  };
  route(app, 'GET', '/bff/balance/get-deposit-link', (req) => depositLink(req, 'A'));
  route(app, 'GET', '/bff/balance/:fx_hash/get-deposit-link-for-ky-quy', async (req) => {
    const u = await requireUser(req);
    if (u.user_level !== 1) throw E.forbidden('Chỉ tài khoản F1 có ví ký quỹ');
    return depositLink(req, 'D');
  });

  // ── Rút tiền: trừ ví ngay (giữ), SA chuyển khoản rồi xác nhận; từ chối → hoàn ──
  route(app, 'POST', '/bff/balance/wd', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    requireMfa(u, b.totp_code);
    const a = amountOf(b.amount);
    if (a.lt(50000)) throw E.invalid('Số tiền rút tối thiểu 50.000đ');
    const bank = b.bank_unique_id ? await prisma.userBankInfo.findUnique({ where: { unique_id: String(b.bank_unique_id) } }) : await prisma.userBankInfo.findFirst({ where: { user_id: u.id, is_default: true } });
    if (!bank || bank.user_id !== u.id) throw E.business('Chưa có tài khoản ngân hàng nhận tiền (/bff/user-bank-info)');
    const dw = await prisma.$transaction(async (tx) => {
      const dw = await tx.dwTransaction.create({ data: { code: code('RUT'), user_id: u.id, dw_type: 'W', amount: a, balance_type: 'A', site: b.site ?? null, bank_info: JSON.stringify({ bank_code: bank.bank_code, bank_name: bank.bank_name, acc_number: bank.acc_number, acc_name: bank.acc_name }) } });
      await post(tx, u.id, 'A', a.neg(), { business_code: 'WITHDRAW', ref_code: dw.code, notes: 'Yêu cầu rút tiền' });
      return dw;
    });
    return { code: dw.code, amount: dw.amount, status: dw.status };
  });

  // SA: danh sách & xác nhận nạp/rút
  const dwOut = async (rows: Awaited<ReturnType<typeof prisma.dwTransaction.findMany>>) => {
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.user_id) } }, select: { id: true, username: true, fullname: true, bank_ref_user_code: true } });
    return rows.map((r) => ({ ...r, bank_info: r.bank_info ? JSON.parse(r.bank_info) : null, username: users.find((u) => u.id === r.user_id)?.username, fullname: users.find((u) => u.id === r.user_id)?.fullname, bank_ref_user_code: users.find((u) => u.id === r.user_id)?.bank_ref_user_code }));
  };
  route(app, 'GET', '/bff/sa/dw-transactions/list', async (req) => {
    await requireSA(req);
    const q = query(req);
    const p = paging(q);
    const where: Prisma.DwTransactionWhereInput = {};
    if (opt(q.dw_type)) where.dw_type = String(q.dw_type);
    if (opt(q.status)) where.status = String(q.status);
    if (opt(q.user_id)) where.user_id = Number(q.user_id);
    if (opt(q.keyword)) where.code = { contains: String(q.keyword) };
    const [total, rows] = await Promise.all([prisma.dwTransaction.count({ where }), prisma.dwTransaction.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await dwOut(rows));
  });
  // body: { amount?: số tiền thực nhận (với lệnh nạp), reject?: true }
  route(app, 'PUT', '/bff/sa/dw-transactions/mark-confirm/:code', async (req) => {
    const sa = await requireSA(req);
    const b = body(req);
    const dw = await prisma.dwTransaction.findUnique({ where: { code: params(req).code } });
    if (!dw) throw E.notFound('Giao dịch nạp/rút');
    if (dw.status !== 'P') throw E.business('Giao dịch đã được xử lý');
    const out = await prisma.$transaction(async (tx) => {
      if (b.reject) {
        if (dw.dw_type === 'W') await post(tx, dw.user_id, dw.balance_type as BalanceTypeT, dw.amount, { business_code: 'WITHDRAW_REJECT', ref_code: dw.code });
        return tx.dwTransaction.update({ where: { id: dw.id }, data: { status: 'R', confirmed_by: sa.id, confirmed_at: new Date() } });
      }
      if (dw.dw_type === 'D') {
        const amt = b.amount != null ? amountOf(b.amount) : dw.amount;
        if (amt.lte(0)) throw E.invalid('Cần amount thực nhận cho lệnh nạp');
        const credit = dw.balance_type === 'X' ? amt.mul(XU_RATE()) : amt;
        await post(tx, dw.user_id, dw.balance_type as BalanceTypeT, credit, { business_code: 'DEPOSIT', ref_code: dw.code });
        return tx.dwTransaction.update({ where: { id: dw.id }, data: { status: 'C', amount: amt, confirmed_by: sa.id, confirmed_at: new Date() } });
      }
      return tx.dwTransaction.update({ where: { id: dw.id }, data: { status: 'C', confirmed_by: sa.id, confirmed_at: new Date() } });
    });
    return (await dwOut([out]))[0];
  });

  // ── Xu (phiếu mua hàng) ──
  // Nạp xu bằng chuyển khoản
  route(app, 'POST', '/bff/balance-transfers/:fx_hash/transfer-xu-create', async (req) => {
    const u = await requireUser(req);
    const tenant = await tenantOf(req);
    if (!tenant.xu_enabled) throw E.forbidden('Website chưa bật phiếu mua hàng');
    const b = body(req);
    const a = amountOf(b.amount);
    const dw = await prisma.dwTransaction.create({ data: { code: code('XU'), user_id: u.id, dw_type: 'D', amount: a, balance_type: 'X', site: b.site_code ?? null } });
    const content = `${u.bank_ref_user_code} ${dw.code}`;
    return { code: dw.code, amount_xu: a.mul(XU_RATE()), he_so: XU_RATE(), qr_link: vietQr(content, a), qr_data: content };
  });
  route(app, 'POST', '/bff/balance-transfers/:fx_hash/transfer-xu-cancel', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    // Huỷ lệnh nạp xu đang chờ, hoặc huỷ lệnh chuyển xu P2P chưa được nhận
    const dw = await prisma.dwTransaction.findUnique({ where: { code: String(b.code ?? '') } });
    if (dw) {
      if (dw.user_id !== u.id || dw.status !== 'P') throw E.business('Không huỷ được lệnh này');
      await prisma.dwTransaction.update({ where: { id: dw.id }, data: { status: 'R' } });
      return null;
    }
    const t = await prisma.balanceTransfer.findUnique({ where: { code: String(b.code ?? '') } });
    if (!t || t.from_user_id !== u.id) throw E.notFound('Lệnh chuyển xu');
    if (t.status !== 'P') throw E.business('Lệnh đã được người nhận xác nhận');
    await prisma.$transaction(async (tx) => {
      await post(tx, u.id, 'X', t.transfer_amount, { business_code: 'XU_TRANSFER', business_sub_code: 'CANCEL', ref_code: t.code });
      await tx.balanceTransfer.update({ where: { id: t.id }, data: { status: 'C' } });
    });
    return null;
  });
  // Chuyển xu cho user khác: tiền bị giữ tới khi người nhận xác nhận
  route(app, 'POST', '/bff/balance-transfers/:fx_hash/transfer-xu-approve', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    requireMfa(u, b.totp_code);
    const a = amountOf(b.transfer_amount, 'transfer_amount');
    const to = await prisma.user.findUnique({ where: { id: Number(b.to_user_id) } });
    if (!to || to.status !== 'A') throw E.notFound('Người nhận');
    if (to.id === u.id) throw E.invalid('Không thể chuyển cho chính mình');
    const t = await prisma.$transaction(async (tx) => {
      const t = await tx.balanceTransfer.create({ data: { code: code('CX'), from_user_id: u.id, to_user_id: to.id, transfer_amount: a, notes: b.notes ?? null } });
      await post(tx, u.id, 'X', a.neg(), { business_code: 'XU_TRANSFER', business_sub_code: 'HOLD', ref_code: t.code });
      return t;
    });
    return transferOut(t);
  });
  route(app, 'POST', '/bff/balance-transfers/:fx_hash/transfer-xu-confirm', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    const t = await prisma.balanceTransfer.findUnique({ where: { code: String(b.code ?? '') } });
    if (!t || t.to_user_id !== u.id) throw E.notFound('Lệnh chuyển xu');
    if (t.status !== 'P') throw E.business('Lệnh không ở trạng thái chờ nhận');
    const up = await prisma.$transaction(async (tx) => {
      await post(tx, u.id, 'X', t.transfer_amount, { business_code: 'XU_TRANSFER', business_sub_code: 'RECEIVE', ref_code: t.code });
      return tx.balanceTransfer.update({ where: { id: t.id }, data: { status: 'D' } });
    });
    return transferOut(up);
  });
  const transferList = (side: 'from' | 'to') => async (req: Req) => {
    const u = await requireUser(req);
    const b = input(req);
    const p = paging(b);
    const where: Prisma.BalanceTransferWhereInput = side === 'from' ? { from_user_id: u.id } : { to_user_id: u.id };
    if (opt(b.status)) where.status = String(b.status);
    if (opt(b.kn_status)) where.complain_status = String(b.kn_status);
    if (opt(b.keyword)) where.code = { contains: String(b.keyword) };
    const r = dateRange(b.from_date, b.to_date);
    if (r) where.created_at = r;
    const [total, rows] = await Promise.all([prisma.balanceTransfer.count({ where }), prisma.balanceTransfer.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map(transferOut)));
  };
  route(app, 'POST', '/bff/balance-transfers/:fx_hash/transfer-xu-list-for-from', transferList('from'));
  route(app, 'POST', '/bff/balance-transfers/:fx_hash/transfer-xu-list-for-to', transferList('to'));

  // Khiếu nại lệnh chuyển (vd: người nhận không giao hàng/dịch vụ tương ứng)
  route(app, 'POST', '/bff/balance-transfers/:fx_hash/transfer-xu-complain-create', async (req) => {
    const u = await requireUser(req);
    const b = body(req);
    const t = await prisma.balanceTransfer.findUnique({ where: { code: String(b.code ?? '') } });
    if (!t || (t.from_user_id !== u.id && t.to_user_id !== u.id)) throw E.notFound('Lệnh chuyển xu');
    if (t.complain_status === 'P') throw E.conflict('Lệnh đang khiếu nại');
    if (!['P', 'D'].includes(t.status)) throw E.business('Lệnh đã huỷ');
    return transferOut(await prisma.balanceTransfer.update({ where: { id: t.id }, data: { complain_status: 'P', complain_notes: b.notes ?? null, complain_by_user_id: u.id } }));
  });
  route(app, 'POST', '/bff/balance-transfers/:fx_hash/transfer-xu-complain-cancel', async (req) => {
    const u = await requireUser(req);
    const t = await prisma.balanceTransfer.findUnique({ where: { code: String(body(req).code ?? '') } });
    if (!t || t.complain_by_user_id !== u.id || t.complain_status !== 'P') throw E.notFound('Khiếu nại đang mở');
    return transferOut(await prisma.balanceTransfer.update({ where: { id: t.id }, data: { complain_status: 'C' } }));
  });
  // Phán xử (SA): from-win = hoàn xu cho người gửi; to-win = xu thuộc về người nhận
  const resolve = (winner: 'F' | 'T') => async (req: Req) => {
    await requireSA(req);
    const t = await prisma.balanceTransfer.findUnique({ where: { code: String(body(req).code ?? '') } });
    if (!t || t.complain_status !== 'P') throw E.notFound('Khiếu nại đang mở');
    const up = await prisma.$transaction(async (tx) => {
      if (winner === 'F') {
        if (t.status === 'D') await post(tx, t.to_user_id, 'X', t.transfer_amount.neg(), { business_code: 'XU_TRANSFER', business_sub_code: 'COMPLAIN_REVERT', ref_code: t.code, allowNegative: true });
        await post(tx, t.from_user_id, 'X', t.transfer_amount, { business_code: 'XU_TRANSFER', business_sub_code: 'COMPLAIN_REFUND', ref_code: t.code });
        return tx.balanceTransfer.update({ where: { id: t.id }, data: { complain_status: 'F', status: 'C' } });
      }
      if (t.status === 'P') await post(tx, t.to_user_id, 'X', t.transfer_amount, { business_code: 'XU_TRANSFER', business_sub_code: 'RECEIVE', ref_code: t.code });
      return tx.balanceTransfer.update({ where: { id: t.id }, data: { complain_status: 'T', status: 'D' } });
    });
    return transferOut(up);
  };
  route(app, 'POST', '/bff/balance-transfers/:fx_hash/transfer-xu-complain-from-win', resolve('F'));
  route(app, 'POST', '/bff/balance-transfers/:fx_hash/transfer-xu-complain-to-win', resolve('T'));
  route(app, 'POST', '/bff/sa/balance-transfers/:fx_hash/transfer-xu-list', async (req) => {
    await requireSA(req);
    const b = body(req);
    const p = paging(b);
    const where: Prisma.BalanceTransferWhereInput = {};
    if (opt(b.status)) where.status = String(b.status);
    if (opt(b.kn_status)) where.complain_status = String(b.kn_status);
    if (opt(b.user_id)) where.OR = [{ from_user_id: Number(b.user_id) }, { to_user_id: Number(b.user_id) }];
    const [total, rows] = await Promise.all([prisma.balanceTransfer.count({ where }), prisma.balanceTransfer.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map(transferOut)));
  });

  // ── Sàn mua bán xu ──
  const placeOrder = (side: 'B' | 'S') => async (req: Req) => {
    const u = await requireUser(req);
    const tenant = await tenantOf(req);
    const b = body(req);
    requireMfa(u, b.totp_code);
    const rate = amountOf(b.rate, 'rate');
    const vol = amountOf(b.xu_volume, 'xu_volume');
    const money = vol.mul(rate).toDecimalPlaces(0);
    const r = await prisma.$transaction(async (tx) => {
      const r = await tx.xuExchangeRequest.create({ data: { code: code(side === 'B' ? 'MX' : 'BX'), tenant_id: tenant.id, user_id: u.id, side, rate, origin_xu_volume: vol, xu_volume: vol, origin_commodity_amount: money, commodity_amount: side === 'B' ? money : 0 } });
      // Ký quỹ: lệnh mua giữ tiền (A → L), lệnh bán giữ xu
      if (side === 'B') {
        await post(tx, u.id, 'A', money.neg(), { business_code: 'XU_EXCHANGE', business_sub_code: 'BUY_HOLD', ref_code: r.code });
        await post(tx, u.id, 'L', money, { business_code: 'XU_EXCHANGE', business_sub_code: 'BUY_HOLD', ref_code: r.code });
      } else await post(tx, u.id, 'X', vol.neg(), { business_code: 'XU_EXCHANGE', business_sub_code: 'SELL_HOLD', ref_code: r.code });
      return matchOrder(tx, r.id);
    });
    return exchangeOut(r, true);
  };
  route(app, 'POST', '/bff/xu-exchange-requests/:fx_hash/buy', placeOrder('B'));
  route(app, 'POST', '/bff/xu-exchange-requests/:fx_hash/sell', placeOrder('S'));
  route(app, 'POST', '/bff/xu-exchange-requests/:fx_hash/cancel', async (req) => {
    const u = await requireUser(req);
    const r = await prisma.xuExchangeRequest.findUnique({ where: { id: Number(body(req).id) } });
    if (!r || r.user_id !== u.id) throw E.notFound('Lệnh');
    if (r.status !== 'P') throw E.business('Lệnh đã khớp hết hoặc đã huỷ');
    const up = await prisma.$transaction(async (tx) => {
      if (r.side === 'B' && r.commodity_amount.gt(0)) {
        await post(tx, u.id, 'L', r.commodity_amount.neg(), { business_code: 'XU_EXCHANGE', business_sub_code: 'BUY_CANCEL', ref_code: r.code });
        await post(tx, u.id, 'A', r.commodity_amount, { business_code: 'XU_EXCHANGE', business_sub_code: 'BUY_CANCEL', ref_code: r.code });
      }
      if (r.side === 'S' && r.xu_volume.gt(0)) await post(tx, u.id, 'X', r.xu_volume, { business_code: 'XU_EXCHANGE', business_sub_code: 'SELL_CANCEL', ref_code: r.code });
      return tx.xuExchangeRequest.update({ where: { id: r.id }, data: { status: 'C', cancel_at: new Date() } });
    });
    return exchangeOut(up);
  });
  const exList = (admin: boolean) => async (req: Req) => {
    const u = admin ? await requireSA(req) : await requireUser(req);
    const tenant = await tenantOf(req);
    const b = input(req);
    const p = paging(b);
    const where: Prisma.XuExchangeRequestWhereInput = { tenant_id: tenant.id };
    // mine=T → lệnh của tôi; mặc định → sổ lệnh đang mở của sàn
    if (!admin) Object.assign(where, b.mine === 'T' ? { user_id: u.id } : { status: 'P' });
    if (opt(b.side)) where.side = String(b.side);
    if (opt(b.status)) where.status = String(b.status);
    if (opt(b.keyword)) where.code = { contains: String(b.keyword) };
    const r = dateRange(b.from_date, b.to_date);
    if (r) where.created_at = r;
    const order: Prisma.XuExchangeRequestOrderByWithRelationInput[] = b.side === 'S' ? [{ rate: 'asc' }, { id: 'asc' }] : b.side === 'B' ? [{ rate: 'desc' }, { id: 'asc' }] : [{ id: 'desc' }];
    const [total, rows] = await Promise.all([prisma.xuExchangeRequest.count({ where }), prisma.xuExchangeRequest.findMany({ where, orderBy: order, skip: p.skip, take: p.take })]);
    return paged(p, total, await Promise.all(rows.map((x) => exchangeOut(x))));
  };
  route(app, 'POST', '/bff/xu-exchange-requests/:fx_hash/list', exList(false));
  route(app, 'POST', '/bff/sa/xu-exchange-requests/:fx_hash/list', exList(true));
  const view = (admin: boolean) => async (req: Req) => {
    const u = admin ? await requireSA(req) : await requireUser(req);
    const r = await prisma.xuExchangeRequest.findUnique({ where: { id: Number(params(req).id) } });
    if (!r || (!admin && r.user_id !== u.id)) throw E.notFound('Lệnh');
    return exchangeOut(r, true);
  };
  route(app, 'GET', '/bff/xu-exchange-requests/:fx_hash/view/:id', view(false));
  route(app, 'GET', '/bff/sa/xu-exchange-requests/:fx_hash/view/:id', view(true));

  // ── Racing: đổi tiền ví khả dụng lấy gói phiếu mua hàng (theo cấu hình tenant) ──
  const racingInfo = (t: Awaited<ReturnType<typeof tenantOf>>) => ({
    racing_enabled: t.racing_enabled, racing_convert_rate: t.racing_convert_rate, racing_start_time: t.racing_start_time, racing_end_time: t.racing_end_time,
    racing_min_require_balance_u: t.racing_min_require_balance_u, racing_pmh_package: t.racing_pmh_package, racing_pmh_ratio: t.racing_pmh_ratio,
  });
  route(app, 'POST', '/bff/racing/:fx_hash/info', async (req) => racingInfo(await tenantOf(req)));
  route(app, 'POST', '/bff/racing/:fx_hash/buy-pmh', async (req) => {
    const u = await requireUser(req);
    const t = await tenantOf(req);
    const now = new Date();
    if (!t.racing_enabled || (t.racing_start_time && t.racing_start_time > now) || (t.racing_end_time && t.racing_end_time < now)) throw E.business('Chương trình racing chưa mở');
    const qty = Number(body(req).quantity);
    if (!Number.isInteger(qty) || qty < 1) throw E.invalid('quantity phải là số nguyên ≥ 1');
    const rep = await prisma.balance.findUnique({ where: { user_id_balance_type: { user_id: u.id, balance_type: 'U' } } });
    if ((rep?.amount ?? new Decimal(0)).lt(t.racing_min_require_balance_u)) throw E.business(`Cần tối thiểu ${t.racing_min_require_balance_u} điểm uy tín`);
    const cost = t.racing_pmh_package.mul(qty);
    const xu = cost.mul(t.racing_pmh_ratio).toDecimalPlaces(0);
    const ref = code('PMH');
    await prisma.$transaction(async (tx) => {
      await post(tx, u.id, 'A', cost.neg(), { business_code: 'RACING_PMH', ref_code: ref });
      await post(tx, u.id, 'X', xu, { business_code: 'RACING_PMH', ref_code: ref });
    });
    return { code: ref, quantity: qty, paid_amount: cost, received_xu: xu };
  });

  void uuid;
  void ((x: User) => x);
}
