const fs = require('fs');
const path = require('path');

/**
 * Sao lưu dữ liệu không thể lấy lại từ DropBuy (đơn hàng, cấu hình, giao dịch ngân hàng) mỗi ngày.
 * data/backups/YYYY-MM-DD/<file>.json – giữ BACKUP_KEEP_DAYS ngày gần nhất (mặc định 14).
 */
const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = process.env.HM_BACKUP_DIR || path.join(DATA_DIR, 'backups');
const FILES = () => [
  process.env.HM_ORDERS_FILE || path.join(DATA_DIR, 'orders.json'),
  process.env.HM_PAYMENTS_FILE || path.join(DATA_DIR, 'payments.json'),
  path.join(DATA_DIR, 'config.json')
];

// Ngày theo giờ Việt Nam (UTC+7) để mỗi bản sao lưu khớp với một ngày bán hàng
function vnDate(d = new Date()) {
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function runBackup({ force = false } = {}) {
  const day = vnDate();
  const dir = path.join(BACKUP_DIR, day);
  if (!force && fs.existsSync(dir)) return { skipped: true, dir };
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const f of FILES()) {
    if (!fs.existsSync(f)) continue;
    fs.copyFileSync(f, path.join(dir, path.basename(f)));
    copied.push(path.basename(f));
  }
  prune();
  return { skipped: false, dir, copied };
}

function prune() {
  const keep = Math.max(1, parseInt(process.env.BACKUP_KEEP_DAYS || '14', 10) || 14);
  if (!fs.existsSync(BACKUP_DIR)) return;
  const days = fs.readdirSync(BACKUP_DIR).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
  for (const old of days.slice(0, Math.max(0, days.length - keep))) {
    fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
  }
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse()
    .map(day => ({ day, files: fs.readdirSync(path.join(BACKUP_DIR, day)) }));
}

/** Sao lưu ngay khi khởi động (nếu hôm nay chưa có) rồi kiểm tra mỗi giờ */
function startBackups() {
  const tick = () => {
    try {
      const r = runBackup();
      if (!r.skipped) console.log(`[Backup] Đã sao lưu ${r.copied.join(', ')} → ${r.dir}`);
    } catch (e) {
      console.error('[Backup] Lỗi sao lưu:', e.message);
    }
  };
  tick();
  return setInterval(tick, 60 * 60 * 1000).unref();
}

module.exports = { runBackup, listBackups, startBackups, vnDate, BACKUP_DIR };
