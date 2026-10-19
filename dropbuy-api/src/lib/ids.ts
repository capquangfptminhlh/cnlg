import { randomUUID, randomBytes, randomInt } from 'node:crypto';

export const uuid = () => randomUUID();
export const hex = (bytes = 16) => randomBytes(bytes).toString('hex');

function yymmdd(d = new Date()) {
  return d.toISOString().slice(2, 10).replace(/-/g, '');
}

/** Mã nghiệp vụ dạng PREFIX-YYMMDD-XXXXXX (vd ORD-261018-4F2A9C) */
export function code(prefix: string) {
  return `${prefix}-${yymmdd()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Mã kho giống định dạng gốc: DP-<shop_id>-<rand>-<rand> */
export function depotCode(shopId: number) {
  return `DP-${shopId}-${randomInt(100, 999999)}-${randomInt(10, 99999)}`;
}

/** SKU giống định dạng gốc: S<shop>-<product>-<seq> */
export function sku(shopId: number, productId: number) {
  return `S${shopId}-${productId}-${randomInt(100000, 999999)}`;
}

/** Mã chương trình flash sale FS-00xxxx */
export function fsCode(n: number) {
  return `FS-${String(n).padStart(6, '0')}`;
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
