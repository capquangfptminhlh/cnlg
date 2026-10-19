const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const vietqrHelper = require('./vietqrHelper');
const orderStore = require('./orderStore');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    dropbuy: { simulationMode: true },
    bank: { bankId: '970422', bankName: 'MBBank', accountNo: '0386888999', accountName: 'HOANG MINH STORE' }
  };
}

function getBrowserExecutable() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (fs.existsSync(chromePath)) return chromePath;
  if (fs.existsSync(edgePath)) return edgePath;
  return null;
}

/**
 * Tự động đặt hàng trên DropBuy & lấy mã QR thanh toán realtime
 * @param {Object} order - Đơn hàng từ hoangminh.com
 * @param {Object} io - Socket.io instance để bắn realtime về client
 */
async function processOrderFulfillment(order, io) {
  const config = getConfig();
  const orderId = order.id;
  const isSimulation = config.dropbuy?.simulationMode !== false || !config.dropbuy?.username;

  console.log(`[Relay] Bắt đầu xử lý đơn #${orderId} (Chế độ: ${isSimulation ? 'SIMULATION / SANDBOX' : 'DROPBUY LIVE BOT'})...`);

  // Báo cho client: Hệ thống đang kết nối Dropbuy
  if (io) {
    io.to(orderId).emit('ORDER_STATUS_UPDATE', {
      orderId,
      status: 'CONNECTING_DROPBUY',
      message: 'Đang kết nối DropBuy và khởi tạo đơn hàng...'
    });
  }

  if (isSimulation) {
    // Chế độ mô phỏng hoàn hảo / Sandbox để test ngay không cần nạp tiền tài khoản
    await new Promise(r => setTimeout(r, 1200)); // Delay tạo hiệu ứng realtime relay

    const qrData = vietqrHelper.generateVietQR({
      bankId: config.bank?.bankId || '970422',
      bankName: config.bank?.bankName || 'MBBank',
      accountNo: config.bank?.accountNo || '0386888999',
      accountName: config.bank?.accountName || 'HOANG MINH STORE',
      amount: order.total_amount,
      orderCode: orderId,
      description: `HOANGMINH ${orderId}`
    });

    const dropbuyOrderId = `DB${Date.now().toString().slice(-7)}`;

    orderStore.updateOrder(orderId, {
      status: 'PENDING_PAYMENT',
      dropbuy_sync: {
        status: 'SUCCESS',
        order_id: dropbuyOrderId,
        relay_mode: 'SIMULATION',
        synced_at: new Date().toISOString()
      },
      payment: qrData
    });

    console.log(`[Relay] Đã tạo mã QR VietQR realtime cho #${orderId} (Mã DropBuy: ${dropbuyOrderId})`);

    // Bắn realtime QR về màn hình hoangminh.com của khách
    if (io) {
      io.to(orderId).emit('ORDER_QR_READY', {
        orderId,
        dropbuyOrderId,
        qr: qrData,
        message: 'Mã QR thanh toán đã sẵn sàng!'
      });
    }

    return { success: true, mode: 'SIMULATION', qr: qrData };
  }

  // Chế độ LIVE AUTOMATION: Dùng Headless Browser điều khiển Dropbuy
  const executablePath = getBrowserExecutable();
  if (!executablePath) {
    throw new Error('Không tìm thấy trình duyệt Chrome hoặc Edge để thực thi automation!');
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 1. Nạp session cookie đã đăng nhập nếu có
    if (config.dropbuy?.cookies && config.dropbuy.cookies.length > 0) {
      console.log(`[Relay] Đang sử dụng session Dropbuy đã đăng nhập (${config.dropbuy.username || 'Active User'})...`);
      await page.setCookie(...config.dropbuy.cookies);
    } else if (config.dropbuy?.username && config.dropbuy?.password) {
      console.log(`[Relay] Đang đăng nhập tài khoản Dropbuy (${config.dropbuy.username})...`);
      const auth = require('./dropbuyAuth');
      await auth.loginDropbuy(config.dropbuy.username, config.dropbuy.password);
      const updatedCfg = getConfig();
      if (updatedCfg.dropbuy?.cookies) {
        await page.setCookie(...updatedCfg.dropbuy.cookies);
      }
    }

    // 2. Thêm từng sản phẩm vào giỏ Dropbuy
    for (const item of order.items) {
      const dropbuyUrl = item.dropbuy_url || `https://dropbuy.vn/san-pham_p${item.id}`;
      console.log(`[Relay] Thêm SP vào giỏ: ${item.name} (${item.quantity} cái) -> ${dropbuyUrl}`);
      await page.goto(dropbuyUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      // Chọn số lượng
      if (item.quantity > 1) {
        for (let q = 1; q < item.quantity; q++) {
          const plusBtn = await page.$('button:has-text("+"), button.ant-input-number-handler-up');
          if (plusBtn) await plusBtn.click();
        }
      }

      // Bấm "Mua ngay" hoặc "Thêm vào giỏ"
      const buyBtn = await page.$('button:has-text("Mua ngay"), button.btn-buy-now');
      if (buyBtn) {
        await buyBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    // 3. Tiến hành Checkout trên Dropbuy
    console.log(`[Relay] Điều hướng sang giỏ hàng & thanh toán Dropbuy...`);
    await page.goto('https://dropbuy.vn/gio-hang', { waitUntil: 'networkidle2', timeout: 30000 });

    // Điền thông tin người nhận của khách hàng
    await page.waitForSelector('input[name="name"], input[placeholder*="Tên"], input[name="receiver_name"]', { timeout: 10000 });
    await page.type('input[name="name"], input[placeholder*="Tên"], input[name="receiver_name"]', order.customer.name);
    await page.type('input[name="phone"], input[placeholder*="thoại"], input[name="receiver_phone"]', order.customer.phone);
    await page.type('input[name="address"], input[placeholder*="chỉ"], input[name="receiver_address"]', order.customer.address);

    // 4. Bấm "Xác nhận đặt hàng" để Dropbuy sinh mã QR
    const confirmBtn = await page.$('button:has-text("Đặt hàng"), button:has-text("Thanh toán"), button.btn-checkout');
    if (confirmBtn) {
      await confirmBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    }

    // 5. Bắt mã QR thanh toán trên Dropbuy
    await page.waitForSelector('img[src*="vietqr"], img[src*="qr"], canvas', { timeout: 15000 });
    const qrInfo = await page.evaluate(() => {
      const img = document.querySelector('img[src*="vietqr"], img[src*="qr"], img[alt*="QR"]');
      const orderEl = document.querySelector('[class*="order-code"], [class*="order_id"], strong');
      return {
        qr_url: img ? img.src : null,
        order_code: orderEl ? orderEl.innerText.trim() : null
      };
    });

    const dropbuyOrderId = qrInfo.order_code || `DB${Date.now().toString().slice(-7)}`;
    const qrData = {
      qr_image_url: qrInfo.qr_url,
      order_code: dropbuyOrderId,
      amount: order.total_amount,
      transfer_content: `DROPBUY ${dropbuyOrderId}`,
      expires_in_seconds: 900
    };

    orderStore.updateOrder(orderId, {
      status: 'PENDING_PAYMENT',
      dropbuy_sync: {
        status: 'SUCCESS',
        order_id: dropbuyOrderId,
        relay_mode: 'LIVE_AUTOMATION',
        synced_at: new Date().toISOString()
      },
      payment: qrData
    });

    console.log(`[Relay LIVE] Đã bắt thành công QR DropBuy cho #${orderId}: ${qrData.qr_image_url}`);

    if (io) {
      io.to(orderId).emit('ORDER_QR_READY', {
        orderId,
        dropbuyOrderId,
        qr: qrData,
        message: 'Mã QR thanh toán DropBuy đã được đồng bộ realtime!'
      });
    }

    await browser.close();
    return { success: true, mode: 'LIVE_AUTOMATION', qr: qrData };

  } catch (err) {
    if (browser) await browser.close();
    console.error(`[Relay LIVE ERROR] Lỗi khi thao tác trên Dropbuy:`, err.message);

    // Fallback: Tự động chuyển sang VietQR của shop để khách không bị gián đoạn đơn hàng
    console.log(`[Relay] Chuyển fallback sang VietQR cửa hàng cho #${orderId}`);
    const qrData = vietqrHelper.generateVietQR({
      bankId: config.bank?.bankId || '970422',
      bankName: config.bank?.bankName || 'MBBank',
      accountNo: config.bank?.accountNo || '0386888999',
      accountName: config.bank?.accountName || 'HOANG MINH STORE',
      amount: order.total_amount,
      orderCode: orderId,
      description: `HOANGMINH ${orderId}`
    });

    orderStore.updateOrder(orderId, {
      status: 'PENDING_PAYMENT',
      dropbuy_sync: {
        status: 'FALLBACK_LOCAL_QR',
        error: err.message,
        order_id: `HM-${orderId}`,
        relay_mode: 'FALLBACK',
        synced_at: new Date().toISOString()
      },
      payment: qrData
    });

    if (io) {
      io.to(orderId).emit('ORDER_QR_READY', {
        orderId,
        dropbuyOrderId: `HM-${orderId}`,
        qr: qrData,
        message: 'Mã QR thanh toán đã sẵn sàng!'
      });
    }

    return { success: true, mode: 'FALLBACK', qr: qrData };
  }
}

/**
 * Giả lập hoặc kích hoạt xác nhận thanh toán thành công
 */
function confirmPayment(orderId, io) {
  const order = orderStore.updateOrder(orderId, {
    status: 'PAID',
    paid_at: new Date().toISOString()
  });

  if (order && io) {
    io.to(orderId).emit('PAYMENT_CONFIRMED', {
      orderId,
      status: 'PAID',
      message: 'Thanh toán thành công! DropBuy đang tiến hành đóng gói và giao hàng cho bạn.'
    });
  }

  return order;
}

module.exports = {
  processOrderFulfillment,
  confirmPayment
};
