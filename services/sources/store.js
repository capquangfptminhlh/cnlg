const fs = require('fs');
const path = require('path');

/**
 * Lưu trữ riêng của 1 nguồn hàng (TechMall, …) – tách khỏi data/products.json của DropBuy để mỗi nguồn
 * đồng bộ độc lập, không ghi đè nhau:
 *   data/source-<key>-products.json    sản phẩm đã quy đổi về dạng của cửa hàng
 *   data/source-<key>-categories.json  danh mục (đã cộng mã nguồn)
 *   data/source-<key>-session.json     cookie phiên đăng nhập đại lý (bí mật, .gitignore)
 * Đọc có bộ nhớ đệm theo thời điểm sửa file; ghi bằng file tạm + đổi tên.
 */
function createStore(key, dir = process.env.HM_SOURCES_DIR || path.join(__dirname, '..', '..', 'data')) {
  const file = name => path.join(dir, `source-${key}-${name}.json`);
  const cache = {};

  function read(name, fallback) {
    const f = file(name);
    try {
      if (!fs.existsSync(f)) return fallback;
      const mtime = fs.statSync(f).mtimeMs;
      if (!cache[name] || cache[name].mtime !== mtime) cache[name] = { mtime, value: JSON.parse(fs.readFileSync(f, 'utf8')) };
      return cache[name].value;
    } catch (e) {
      return cache[name] ? cache[name].value : fallback;
    }
  }

  function write(name, value) {
    const f = file(name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(value));
    fs.renameSync(`${f}.tmp`, f);
    cache[name] = { mtime: fs.statSync(f).mtimeMs, value };
  }

  return {
    getProducts: () => read('products', []),
    saveProducts: list => write('products', list),
    getCategories: () => read('categories', []),
    saveCategories: list => write('categories', list),
    getSession: () => read('session', null),
    saveSession: s => write('session', s),
    clearSession: () => { try { fs.unlinkSync(file('session')); } catch (e) {} delete cache.session; },
    getMeta: () => read('meta', {}),
    saveMeta: m => write('meta', m)
  };
}

module.exports = { createStore };
