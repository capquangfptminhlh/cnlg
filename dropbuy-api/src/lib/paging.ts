/** Phân trang theo quy ước gốc: page_num (mặc định 1), page_size (mặc định 20). */
export function paging(src: Record<string, unknown> | undefined, defSize = 20) {
  const page_num = Math.max(1, Number(src?.page_num ?? src?.page ?? 1) || 1);
  const page_size = Math.min(500, Math.max(1, Number(src?.page_size ?? defSize) || defSize));
  return { page_num, page_size, skip: (page_num - 1) * page_size, take: page_size };
}

export function paged<T>(p: { page_num: number; page_size: number }, total_records: number, items: T[]) {
  return { page_num: p.page_num, page_size: p.page_size, total_records, items };
}

/** Khoảng ngày yyyy-MM-dd → điều kiện Prisma (to_date tính trọn ngày). */
export function dateRange(from?: unknown, to?: unknown) {
  const r: { gte?: Date; lt?: Date } = {};
  if (typeof from === 'string' && from) r.gte = new Date(`${from.slice(0, 10)}T00:00:00.000Z`);
  if (typeof to === 'string' && to) {
    const d = new Date(`${to.slice(0, 10)}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    r.lt = d;
  }
  return Object.keys(r).length ? r : undefined;
}

/** Chuỗi rỗng = không lọc (quy ước của API gốc). */
export const opt = (v: unknown) => (v === '' || v === null || v === undefined ? undefined : v);
