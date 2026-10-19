// Giá trị enum trích từ FE gốc (Orval const objects + bảng label trong UI).

export const OrderStatus = {
  U: 'U', // Chưa xác định / đơn nháp (giỏ đã chốt, chưa thanh toán)
  P: 'P', // Chờ thanh toán
  O: 'O', // Đã thanh toán
  W: 'W', // Chờ đóng hàng
  G: 'G', // Đã đóng hàng
  Q: 'Q', // Chờ lấy hàng
  S: 'S', // Đang giao
  F: 'F', // Đã giao
  D: 'D', // Hoàn thành
  K: 'K', // Đang khiếu nại
  C: 'C', // Đã huỷ
  B: 'B', // Bom hàng
  X: 'X', // Hoàn hàng về shop
  N: 'N', // Không thành công (giao thất bại)
} as const;
export type OrderStatusT = keyof typeof OrderStatus;

export const OrderStatusLabel: Record<OrderStatusT, string> = {
  U: 'Nháp', P: 'Chờ thanh toán', O: 'Đã thanh toán', W: 'Chờ đóng hàng', G: 'Đã đóng hàng',
  Q: 'Chờ lấy hàng', S: 'Đang giao', F: 'Đã giao', D: 'Hoàn thành', K: 'Đang khiếu nại',
  C: 'Đã huỷ', B: 'Bom hàng', X: 'Hoàn hàng', N: 'Giao không thành công',
};

/** Máy trạng thái đơn: from → các trạng thái được phép. */
export const OrderTransitions: Record<OrderStatusT, OrderStatusT[]> = {
  U: ['P', 'W', 'C'],
  P: ['O', 'C'],
  O: ['W', 'C'],
  W: ['G', 'C'],
  G: ['Q', 'W', 'C'],
  Q: ['S', 'C'],
  S: ['F', 'B', 'N'],
  F: ['D', 'K'],
  K: ['D', 'X'],
  N: ['S', 'X', 'B'],
  B: [],
  X: [],
  C: [],
  D: [],
};

export const ProductStatus = { U: 'U', W: 'W', A: 'A', L: 'L', X: 'X' } as const; // chưa đăng, chờ duyệt, đang bán, khoá, xoá
export const UserStatus = { P: 'P', A: 'A', L: 'L' } as const; // chờ kích hoạt, hoạt động, khoá
export const ReferralStatus = { W: 'W', A: 'A', P: 'P' } as const;
export const BalanceType = { A: 'A', L: 'L', D: 'D', X: 'X', U: 'U' } as const; // khả dụng, đặt cọc, ký quỹ, phiếu mua hàng (xu), điểm uy tín
export const OrderType = { N: 'N', A: 'A', V: 'V' } as const; // thường, affiliate, từ kho ảo
export const ShippingMethod = { V: 'V', S: 'S', T: 'T' } as const; // VTP, SPX, shop tự giao
export const DeliveryOption = { N: 'N', X: 'X' } as const;
export const PaymentMethod = { B: 'B', C: 'C', Q: 'Q' } as const; // ví, COD, QR
export const ContractType = { N: 'N', V: 'V' } as const;
export const ServiceContractKind = { FS: 'FS', B: 'B', F: 'F' } as const;
