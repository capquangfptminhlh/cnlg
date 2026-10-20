const scraper = require('./dropbuyScraper');
const orderStore = require('./orderStore');
const dropbuySession = require('./dropbuySession');
const fulfillment = require('./dropbuyOrderFulfillment');
const { notify } = require('./notify');
const { vnDate } = require('./backup');

/**
 * Canh chừng để tự đặt đơn chạy được khi không ai trông (mỗi 15 phút + ngay sau khi đăng nhập):
 *  - phiên DropBuy đã hết / sắp hết (< 12 giờ) → báo Telegram + hiện trong admin
 *  - quỹ khả dụng dưới ngưỡng autoOrder.lowBalanceAlert → báo (1 lần/ngày)
 *  - đơn sẵn sàng nhưng chưa sang DropBuy (chờ đăng nhập, hoặc server dừng giữa chừng) → đặt lại
 * Mỗi cảnh báo chỉ gửi 1 lần cho tới khi tình trạng đổi.
 */
const TICK_MS = 15 * 60 * 1000;
const EXPIRING_MS = 12 * 3600 * 1000;
const STUCK_MS = 3 * 60 * 1000; // đơn tạo > 3 phút mà vẫn chưa chuyển sang DropBuy
const RETRY_STATUSES = new Set(['WAITING_DROPBUY_LOGIN', 'INITIATING']);

const sent = new Map(); // khoá cảnh báo → thời điểm gửi
let state = { checkedAt: null, session: null, balance: null, alerts: [], waiting: 0 };
let running = null;

function alertOnce(key, text) {
  if (sent.has(key)) return;
  sent.set(key, Date.now());
  notify.alert(text);
}

function isReady(o) {
  return o.payment_method === 'COD' ? o.status === 'CONFIRMED' : o.status === 'PAID';
}

/** Đơn sẵn sàng đặt kho mà chưa sang DropBuy */
function waitingOrders(orders = orderStore.getOrders(), now = Date.now()) {
  return orders.filter(o => {
    if (!isReady(o)) return false;
    const st = o.dropbuy_sync?.status;
    if (st === 'WAITING_DROPBUY_LOGIN') return true;
    return st === 'INITIATING' && now - Date.parse(o.created_at) > STUCK_MS;
  });
}

/** Đặt lại các đơn đang chờ (tuần tự). Chỉ chạy khi bật tự đặt và phiên còn hiệu lực. */
async function retryWaiting(io) {
  const cfg = scraper.getConfig();
  if (!fulfillment.normalizeAutoOrder(cfg.autoOrder).enabled) return { retried: 0, placed: 0, skipped: 'AUTO_OFF' };
  const s = await dropbuySession.ensureSession(cfg).catch(() => null);
  if (!s) return { retried: 0, placed: 0, skipped: 'NO_SESSION' };
  let retried = 0;
  let placed = 0;
  for (const o of waitingOrders()) {
    retried++;
    try {
      const r = await fulfillment.handOff(o.id, io);
      if (r?.success) placed++;
    } catch (e) {
      console.warn(`[Watchdog] Đơn ${o.id} chưa đặt lại được:`, e.message);
    }
  }
  if (retried) console.log(`[Watchdog] Đặt lại ${placed}/${retried} đơn đang chờ DropBuy.`);
  return { retried, placed };
}

async function tick(io) {
  if (running) return running;
  running = (async () => {
    const cfg = scraper.getConfig();
    const rules = fulfillment.normalizeAutoOrder(cfg.autoOrder);
    const alerts = [];
    const waiting = waitingOrders().length;
    let session = null;
    let balance = null;

    if (!cfg.dropbuy?.cookieHeader) {
      alerts.push('Chưa đăng nhập DropBuy.');
      if (rules.enabled) alertOnce('nologin', `Tự đặt đơn đang BẬT nhưng chưa đăng nhập DropBuy${waiting ? ` – ${waiting} đơn đang chờ` : ''}. Vào admin → Đăng nhập DropBuy.`);
    } else {
      session = await dropbuySession.ensureSession(cfg, { force: true }).catch(() => null);
      if (!session) {
        alerts.push('Phiên DropBuy đã hết hạn – đăng nhập lại.');
        alertOnce(`expired:${cfg.dropbuy.authenticatedAt || ''}`, `Phiên DropBuy đã HẾT HẠN – đơn mới sẽ chờ, không tự đặt được${waiting ? ` (${waiting} đơn đang chờ)` : ''}. Vào admin đăng nhập lại; đơn chờ sẽ tự đặt ngay sau đó.`);
      } else {
        sent.delete('nologin');
        const left = Date.parse(session.expiresAt) - Date.now();
        if (left < EXPIRING_MS) {
          const hours = Math.max(0, Math.round(left / 3600e3));
          alerts.push(`Phiên DropBuy hết hạn sau ~${hours} giờ.`);
          alertOnce(`expiring:${session.expiresAt}`, `Phiên DropBuy sẽ hết hạn sau khoảng ${hours} giờ (${new Date(session.expiresAt).toLocaleString('vi-VN')}). Đăng nhập lại trong admin để không gián đoạn tự đặt đơn.`);
        }
        try {
          const bal = await dropbuySession.bff('/balance/my-balance', { config: cfg });
          balance = Number(bal?.avail_balance_current ?? NaN);
          if (rules.enabled && Number.isFinite(balance) && balance < rules.lowBalanceAlert) {
            alerts.push(`Quỹ DropBuy thấp: ${balance.toLocaleString('vi-VN')} đ.`);
            alertOnce(`lowbal:${vnDate()}`, `Quỹ DropBuy còn ${balance.toLocaleString('vi-VN')} đ (dưới ngưỡng ${rules.lowBalanceAlert.toLocaleString('vi-VN')} đ). Nạp thêm để đơn COD không bị chặn.`);
          }
        } catch (e) {
          console.warn('[Watchdog] Không đọc được số dư quỹ:', e.message);
        }
        await retryWaiting(io);
      }
    }
    state = { checkedAt: new Date().toISOString(), session: session ? { expiresAt: session.expiresAt } : null, balance, alerts, waiting: waitingOrders().length };
    return state;
  })().finally(() => { running = null; });
  return running;
}

function startWatchdog(io) {
  setTimeout(() => tick(io).catch(e => console.warn('[Watchdog]', e.message)), 20 * 1000).unref();
  return setInterval(() => tick(io).catch(e => console.warn('[Watchdog]', e.message)), TICK_MS).unref();
}

function getState() {
  return { ...state, waiting: waitingOrders().length };
}

module.exports = { startWatchdog, tick, retryWaiting, waitingOrders, getState };
