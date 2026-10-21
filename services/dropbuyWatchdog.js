const scraper = require('./dropbuyScraper');
const orderStore = require('./orderStore');
const dropbuySession = require('./dropbuySession');
const fulfillment = require('./dropbuyOrderFulfillment');
const { notify } = require('./notify');
const { vnDate } = require('./backup');
const vault = require('./credentialVault');
const dropbuyAuth = require('./dropbuyAuth');

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
const RELOGIN_BEFORE_MS = 3 * 3600 * 1000; // còn < 3 giờ thì đăng nhập lại
const RELOGIN_GAP_MS = 30 * 60 * 1000;      // tối đa 1 lần / 30 phút
const RELOGIN_MAX_FAILS = 3;                // lỗi liên tiếp → dừng, chờ đăng nhập tay

const sent = new Map(); // khoá cảnh báo → thời điểm gửi
const relogin = { lastTry: 0, fails: 0, stopped: false, lastError: null, lastOk: null };
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

/**
 * Tự đăng nhập lại bằng tài khoản đã lưu khi phiên hết / sắp hết. Không thử dồn dập (khoá tài khoản),
 * dừng hẳn khi DropBuy báo sai mật khẩu / cần mã 2 bước hoặc lỗi 3 lần liên tiếp.
 */
async function maybeRelogin(io, session, { force = false } = {}) {
  const needs = !session || Date.parse(session.expiresAt) - Date.now() < RELOGIN_BEFORE_MS;
  if (!needs || relogin.stopped) return null;
  if (!force && Date.now() - relogin.lastTry < RELOGIN_GAP_MS) return null;
  const cred = vault.load();
  if (!cred) return null;
  relogin.lastTry = Date.now();
  try {
    await dropbuyAuth.loginDropbuy(cred.username, cred.password);
    relogin.fails = 0;
    relogin.lastError = null;
    relogin.lastOk = new Date().toISOString();
    console.log('[Watchdog] Đã tự đăng nhập lại DropBuy.');
    notify.info('Đã tự đăng nhập lại DropBuy – tự đặt đơn tiếp tục bình thường.');
    if (io) io.emit('DROPBUY_AUTH_CHANGED', { authenticated: true });
    return dropbuySession.ensureSession(scraper.getConfig(), { force: true }).catch(() => null);
  } catch (e) {
    relogin.fails++;
    relogin.lastError = e.message;
    const fatal = /Sai mật khẩu|không tồn tại|2 bước|OTP/i.test(e.message);
    if (fatal || relogin.fails >= RELOGIN_MAX_FAILS) {
      relogin.stopped = true;
      alertOnce(`relogin-stop:${relogin.lastTry}`, `Không tự đăng nhập lại DropBuy được (${e.message}). Đã dừng tự đăng nhập – vào admin đăng nhập tay.`);
    }
    console.warn('[Watchdog] Tự đăng nhập lại DropBuy lỗi:', e.message);
    return null;
  }
}

/** Gọi khi chủ shop đăng nhập tay thành công: mở lại cơ chế tự đăng nhập */
function resetRelogin() {
  relogin.fails = 0;
  relogin.stopped = false;
  relogin.lastError = null;
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

    if (!cfg.dropbuy?.cookieHeader && vault.info().saved && !relogin.stopped) {
      session = await maybeRelogin(io, null);
    }
    if (!scraper.getConfig().dropbuy?.cookieHeader) {
      alerts.push('Chưa đăng nhập DropBuy.');
      if (rules.enabled) alertOnce('nologin', `Tự đặt đơn đang BẬT nhưng chưa đăng nhập DropBuy${waiting ? ` – ${waiting} đơn đang chờ` : ''}. Vào admin → Đăng nhập DropBuy.`);
    } else {
      session = await dropbuySession.ensureSession(cfg, { force: true }).catch(() => null);
      session = (await maybeRelogin(io, session)) || session;
      if (!session) {
        alerts.push('Phiên DropBuy đã hết hạn – đăng nhập lại.');
        alertOnce(`expired:${cfg.dropbuy.authenticatedAt || ''}`, `Phiên DropBuy đã HẾT HẠN – đơn mới sẽ chờ, không tự đặt được${waiting ? ` (${waiting} đơn đang chờ)` : ''}. Vào admin đăng nhập lại; đơn chờ sẽ tự đặt ngay sau đó.`);
      } else {
        sent.delete('nologin');
        const left = Date.parse(session.expiresAt) - Date.now();
        if (left < EXPIRING_MS && !vault.info().saved) {
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
    if (relogin.stopped) alerts.push(`Tự đăng nhập lại đã dừng: ${relogin.lastError || 'lỗi'}.`);
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
  return { ...state, waiting: waitingOrders().length, relogin: { ...vault.info(), stopped: relogin.stopped, last_error: relogin.lastError, last_ok: relogin.lastOk } };
}

module.exports = { startWatchdog, tick, retryWaiting, waitingOrders, getState, maybeRelogin, resetRelogin };
