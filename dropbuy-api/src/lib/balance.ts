import { Decimal, type DecimalValue, type Tx, prisma } from './db.js';
import { E } from './http.js';
import { uuid } from './ids.js';

export type BalanceTypeT = 'A' | 'L' | 'D' | 'X' | 'U';

export async function ensureBalance(tx: Tx, user_id: number, balance_type: BalanceTypeT) {
  return tx.balance.upsert({
    where: { user_id_balance_type: { user_id, balance_type } },
    create: { unique_id: uuid(), user_id, balance_type, amount: 0 },
    update: {},
  });
}

/**
 * Ghi sổ ví (luôn trong transaction). delta > 0 cộng, < 0 trừ.
 * Không cho âm, trừ khi allowNegative (vd SA điều chỉnh).
 */
export async function post(
  tx: Tx,
  user_id: number,
  balance_type: BalanceTypeT,
  delta: DecimalValue,
  meta: { business_code: string; business_sub_code?: string; ref_code?: string; notes?: string; allowNegative?: boolean },
) {
  const d = new Decimal(delta);
  if (d.isZero()) return null;
  const b = await ensureBalance(tx, user_id, balance_type);
  const after = b.amount.plus(d);
  if (after.isNegative() && !meta.allowNegative) throw E.insufficient();
  await tx.balance.update({ where: { id: b.id }, data: { amount: after } });
  return tx.balanceTxn.create({
    data: {
      unique_id: uuid(),
      balance_id: b.id,
      user_id,
      action_code: d.isNegative() ? 'O' : 'I',
      business_code: meta.business_code,
      business_sub_code: meta.business_sub_code,
      amount: d.abs(),
      balance_after: after,
      ref_code: meta.ref_code,
      notes: meta.notes,
    },
  });
}

/** Chuyển giữa 2 ví (cùng user hoặc khác user) – atomic. */
export async function move(
  tx: Tx,
  from: { user_id: number; type: BalanceTypeT },
  to: { user_id: number; type: BalanceTypeT },
  amount: DecimalValue,
  meta: { business_code: string; ref_code?: string; notes?: string },
) {
  const a = new Decimal(amount);
  if (a.lte(0)) throw E.invalid('Số tiền phải lớn hơn 0');
  await post(tx, from.user_id, from.type, a.neg(), meta);
  await post(tx, to.user_id, to.type, a, meta);
}

export async function balancesOf(user_id: number) {
  const rows = await prisma.balance.findMany({ where: { user_id } });
  const by = Object.fromEntries(rows.map((r) => [r.balance_type, r]));
  return (['A', 'L', 'D', 'X', 'U'] as BalanceTypeT[]).map((t) => ({
    balance_unique_id: by[t]?.unique_id ?? null,
    balance_type: t,
    balance_current: by[t]?.amount ?? new Decimal(0),
  }));
}
