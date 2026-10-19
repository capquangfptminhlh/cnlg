import { Prisma } from '@prisma/client';

/** Envelope giống hệ thống gốc: { success, error_code, message, data } */
export function ok<T>(data?: T, message = 'OK') {
  return { success: true, error_code: 0, message, data: data ?? null };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public error_code: number,
    message: string,
  ) {
    super(message);
  }
}

// Mã lỗi nghiệp vụ. Dải 1xxx auth, 2xxx dữ liệu vào, 3xxx nghiệp vụ, 4xxx quyền.
export const E = {
  unauthorized: () => new ApiError(401, 1001, 'Bạn cần đăng nhập'),
  badCredentials: () => new ApiError(401, 1002, 'Sai tên đăng nhập hoặc mật khẩu'),
  inactive: () => new ApiError(403, 1003, 'Tài khoản chưa kích hoạt hoặc đã bị khoá'),
  mfaRequired: () => new ApiError(403, 1004, 'Yêu cầu mã xác thực 2 lớp (totp_code)'),
  mfaInvalid: () => new ApiError(403, 1005, 'Mã xác thực 2 lớp không đúng'),
  invalid: (msg: string) => new ApiError(400, 2001, msg),
  notFound: (what = 'Dữ liệu') => new ApiError(404, 2004, `${what} không tồn tại`),
  conflict: (msg: string) => new ApiError(409, 2009, msg),
  business: (msg: string, code = 3000) => new ApiError(422, code, msg),
  insufficient: () => new ApiError(422, 3001, 'Số dư không đủ'),
  outOfStock: (sku: string) => new ApiError(422, 3002, `Sản phẩm ${sku} không đủ tồn kho`),
  badTransition: (from: string, to: string) => new ApiError(422, 3003, `Không thể chuyển trạng thái ${from} → ${to}`),
  forbidden: (msg = 'Bạn không có quyền thực hiện thao tác này') => new ApiError(403, 4003, msg),
};

/** Chuyển Decimal → number đệ quy trước khi serialize (FE gốc nhận số). */
export function plain(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof Prisma.Decimal) return v.toNumber();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = plain(x);
    return out;
  }
  return v;
}

/** Cờ T/F của hệ thống gốc */
export const tf = (b: boolean | null | undefined) => (b ? 'T' : 'F');
export const isT = (v: unknown) => v === true || v === 'T' || v === 't' || v === 1 || v === '1';
