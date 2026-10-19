/**
 * VietQR & Napas 247 Helper
 * Sinh mã QR thanh toán chuẩn ngân hàng Việt Nam (VietQR / Napas)
 */

function generateVietQR(options) {
  const {
    bankId, // Mã BIN Napas của ngân hàng
    bankName = 'MBBank',
    accountNo,
    accountName,
    amount = 0,
    orderCode = 'HM0001',
    description = ''
  } = options;

  const memo = description || `TT DON HANG ${orderCode}`;
  const encodedMemo = encodeURIComponent(memo);
  const encodedAccountName = encodeURIComponent(accountName);

  // Chuẩn VietQR API của VietQR.io (chuẩn Napas 24/7 toàn quốc)
  const qrImageUrl = `https://img.vietqr.io/image/${bankId}-${accountNo}-compact2.png?amount=${amount}&addInfo=${encodedMemo}&accountName=${encodedAccountName}`;

  return {
    qr_image_url: qrImageUrl,
    bank_bin: bankId,
    bank_name: bankName,
    account_number: accountNo,
    account_name: accountName,
    amount: amount,
    order_code: orderCode,
    transfer_content: memo,
    expires_in_seconds: 900 // 15 phút
  };
}

module.exports = {
  generateVietQR
};
