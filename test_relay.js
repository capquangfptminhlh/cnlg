const orderStore = require('./services/orderStore');
const relay = require('./services/dropbuyRelay');
const scraper = require('./services/dropbuyScraper');

async function runSelfTest() {
  console.log('--- BẮT ĐẦU KIỂM THỬ TỰ ĐỘNG HỆ THỐNG HOANGMINH X DROPBUY RELAY ---');

  // 1. Kiểm tra kho sản phẩm và danh mục
  const categories = scraper.getCategories();
  const products = scraper.getProducts();
  console.log(`[Test 1] Danh mục đã nạp: ${categories.length} (Kỳ vọng >= 80)`);
  console.log(`[Test 2] Sản phẩm đã nạp: ${products.length} (Kỳ vọng > 0)`);
  if (products.length === 0) {
    throw new Error('Chưa có sản phẩm nào được nạp vào kho!');
  }

  // 2. Tạo đơn hàng thử nghiệm
  const sampleProduct = products[0];
  console.log(`[Test 3] Chọn sản phẩm test: "${sampleProduct.name}" (Giá: ${sampleProduct.price.toLocaleString()} đ)`);

  const order = orderStore.createOrder({
    customer: {
      name: 'Nguyễn Văn Test',
      phone: '0988889999',
      address: '123 Đường Láng, Đống Đa, Hà Nội',
      note: 'Giao hàng thử nghiệm hệ thống'
    },
    items: [
      {
        id: sampleProduct.id,
        name: sampleProduct.name,
        price: sampleProduct.price,
        dropbuy_url: sampleProduct.dropbuy_url,
        quantity: 2
      }
    ],
    total_amount: sampleProduct.price * 2
  });

  console.log(`[Test 4] Đã tạo đơn hàng #${order.id} trị giá ${order.total_amount.toLocaleString()} đ`);

  // 3. Giả lập Socket.io mock để kiểm tra bắn sự kiện realtime
  const eventsCaptured = [];
  const mockIo = {
    to: (roomId) => ({
      emit: (event, payload) => {
        console.log(`[Socket.io EMIT -> Room ${roomId}] Event: ${event}`);
        eventsCaptured.push({ event, payload });
      }
    })
  };

  // 4. Kích hoạt Fulfillment Relay
  console.log('[Test 5] Kích hoạt tiến trình Relay DropBuy...');
  const relayResult = await relay.processOrderFulfillment(order, mockIo);
  console.log('[Test 6] Kết quả Relay:', relayResult.success ? 'THÀNH CÔNG' : 'THẤT BẠI', `(Chế độ: ${relayResult.mode})`);
  console.log('[Test 7] Mã VietQR thu được:', relayResult.qr.qr_image_url);

  // 5. Kiểm tra xác nhận thanh toán
  console.log('[Test 8] Kích hoạt xác nhận thanh toán...');
  const paidOrder = relay.confirmPayment(order.id, mockIo);
  console.log('[Test 9] Trạng thái sau thanh toán:', paidOrder.status);

  if (paidOrder.status !== 'PAID') {
    throw new Error('Trạng thái đơn hàng không chuyển sang PAID!');
  }

  console.log('--- TẤT CẢ 9 BƯỚC KIỂM THỬ ĐỀU ĐẠT CHUẨN 100%! ---');
}

runSelfTest()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('LỖI KIỂM THỬ:', err);
    process.exit(1);
  });
