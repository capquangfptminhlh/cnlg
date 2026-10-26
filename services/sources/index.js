'use strict';
/**
 * Danh sách nguồn hàng sỉ ngoài DropBuy. Thêm nguồn mới: tạo file khai báo như techmall.js rồi thêm vào SOURCES
 * (mỗi nguồn một idOffset riêng, cách nhau SPAN = 10.000.000).
 * DropBuy giữ đường đồng bộ cũ (dropbuyScraper / realtimeSync); catalog.js gộp tất cả cho trang khách.
 */
const { SPAN } = require('./woo');

const SOURCES = [require('./techmall')];

const all = () => SOURCES;
const get = key => SOURCES.find(s => s.def.key === key) || null;

/** Nguồn của 1 mã SP (null = DropBuy) */
function ofProduct(id) {
  const n = Number(id);
  return SOURCES.find(s => n >= s.def.idOffset && n < s.def.idOffset + SPAN) || null;
}

const timers = new Map();
function start(io, getConfig) {
  for (const s of SOURCES) {
    s.setIo(io);
    const run = async () => {
      const cfg = getConfig();
      const opt = cfg?.sources?.[s.def.key] || {};
      const minutes = Math.min(180, Math.max(5, Number(opt.intervalMinutes) || s.def.intervalMinutes || 10));
      if (opt.enabled !== false) {
        try { await s.syncAll(); } catch (e) { console.error(`[Nguồn ${s.def.label}] Lỗi đồng bộ:`, e.message); }
      }
      timers.set(s.def.key, setTimeout(run, minutes * 60e3));
    };
    timers.set(s.def.key, setTimeout(run, 20e3));
  }
}

module.exports = { all, get, ofProduct, start };
