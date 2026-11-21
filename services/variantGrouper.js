'use strict';

/**
 * services/variantGrouper.js
 *
 * Gom các sản phẩm có nhiều thuộc tính (màu sắc, chiều dài, dung lượng, kích thước)
 * hoặc các sản phẩm trùng lặp từ nhiều kho/nhà cung cấp khác nhau thành 1 sản phẩm cha
 * duy nhất với các phân loại (variants & variation_options).
 */

const COLOR_WORDS = [
  'dark gray', 'dark grey', 'space gray', 'space grey', 'rose gold', 'midnight green', 'deep purple',
  'deep grey', 'deep gray', 'sierra blue', 'natural titanium', 'blue titanium', 'black titanium',
  'white titanium', 'silver-black', 'silver black', 'black-red', 'red-black', 'white-black', 'white+black', 'red+black',
  'xanh dương', 'xanh lá', 'xanh rêu', 'xám không gian', 'vàng hồng', 'trong suốt', 'trắng bạc', 'xanh navy', 'tím nhạt',
  'black', 'white', 'red', 'blue', 'green', 'yellow', 'purple', 'pink', 'grey', 'gray', 'orange', 'brown', 'silver', 'gold', 'beige', 'transparent', 'clear', 'tarnish',
  'đen', 'trắng', 'đỏ', 'xanh', 'vàng', 'tím', 'hồng', 'xám', 'cam', 'nâu', 'bạc'
];

// Tiền tố kho hàng DropBuy cần gỡ bỏ trước khi gom và hiển thị (chống lộ mã kho, tăng tính chuyên nghiệp)
const WAREHOUSE_PREFIX = /^(\s*(\[[^\]]+\]|\([^\)]*(?:kho|hà đông|ha dong|long biên|long bien|hcm|hn|sg|s\d+|lb|mđ|md)[^\)]*\))\s*)+/i;

const LENGTH_REGEX_STR = '(?:\\d+(?:\\.\\d+)?\\s*(?:m|mét|cm|mm|inch))';
const CAP_REGEX_STR = '(?:\\d+(?:\\.\\d+)?\\s*(?:gb|tb|mah|w|a|ml|lít|lit|l|kg|g|oz))';
const COLOR_REGEX_STR = '(?:' + COLOR_WORDS.map(w => w.replace(/\+/g, '\\+')).join('|') + ')';

const LENGTH_REGEX = new RegExp('\\b' + LENGTH_REGEX_STR + '\\b', 'i');
const CAPACITY_REGEX = new RegExp('\\b' + CAP_REGEX_STR + '\\b', 'i');

const PKG_REGEX = /\s*(?:[\(（]\s*([a-zA-Z0-9_-]{2,15})\s*[\)）]\s*)?[-–—]\s*(PE Bag|Kraft Box|Retail Box|Color box|Color Box|Blister|Gift Box|Folding Carton|Bulk|Kraft Box\+Color Sleeve|Polybag|Zipper Bag)\s*$/i;
const MODEL_PAREN_REGEX = /\s*[\(（]\s*([a-zA-Z0-9_-]{3,15})\s*[\)）]\s*$/;

function isColor(str) {
  const l = String(str || '').toLowerCase().trim();
  if (COLOR_WORDS.includes(l)) return true;
  const parts = l.split(/[\s+/&,-]+/).filter(Boolean);
  return parts.length > 0 && parts.every(p => COLOR_WORDS.includes(p));
}

function cleanVariantLabel(str) {
  return String(str || '')
    .replace(/^[-–—/:\s,]+|[-–—/:\s,]+$/g, '')
    .replace(/^màu\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chuẩn hoá tên gốc để gom nhóm chính xác */
function normalizeBaseTitle(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Tách tên sản phẩm thành:
 * - base: Tên gốc (không chứa màu sắc / kích thước ở đuôi)
 * - variant: Tên phân loại (ví dụ: "Black", "1m Red+Black", "60mm", "128GB")
 */
function parseVariant(name) {
  let text = String(name || '').trim();
  if (!text) return { base: '', variant: null };

  // 0. Bỏ tiền tố kho hàng DropBuy
  text = text.replace(WAREHOUSE_PREFIX, '').trim();
  text = text.replace(/[\(（]([^\)）]*(?:kho|hà đông|long biên|hn|hcm|sg)[^\)）]*)[\)）]/ig, '').trim();

  // Chuẩn hoá ngoặc không có khoảng trắng sát chữ cái
  text = text.replace(/([\)）\]])([a-zA-Z0-9])/g, '$1 $2');
  text = text.replace(/([^\s])([\(（\[])/g, '$1 $2');

  // Đọc bao bì và mã model phụ ở cuối
  let packaging = '';
  let modelCode = '';
  const pkgMatch = text.match(PKG_REGEX);
  if (pkgMatch) {
    if (pkgMatch[1]) modelCode = pkgMatch[1];
    packaging = pkgMatch[2];
    text = text.slice(0, pkgMatch.index).trim();
  }

  const modelMatch = text.match(MODEL_PAREN_REGEX);
  if (modelMatch) {
    const inM = modelMatch[1].toLowerCase();
    if (!new RegExp('^' + COLOR_REGEX_STR + '$', 'i').test(inM) &&
        !new RegExp('^' + LENGTH_REGEX_STR + '$', 'i').test(inM) &&
        !new RegExp('^' + CAP_REGEX_STR + '$', 'i').test(inM)) {
      modelCode = modelMatch[1];
      text = text.slice(0, modelMatch.index).trim();
    }
  }

  // Dạng 1: Xm after water filling [Color] (vd: 7.5m after water filling Black)
  const waterFilling = text.match(/\s+(\d+(?:\.\d+)?m\s+after\s+water\s+filling)(?:\s+([\p{L}\p{N}\s.,+-]+))?$/iu);
  if (waterFilling) {
    const base = text.slice(0, waterFilling.index).trim();
    let v = cleanVariantLabel((waterFilling[1] + ' ' + (waterFilling[2] || '')).trim());
    if (modelCode) v += ` (${modelCode})`;
    if (packaging) v += ` [${packaging}]`;
    return { base, variant: v };
  }

  // Dạng 2: Chiều dài và màu ở giữa tên sản phẩm (thường gặp ở cáp Vention, vd: '... 0.5M Black Zinc Alloy Type')
  const midLenCol = text.match(new RegExp('\\s+(' + LENGTH_REGEX_STR + ')(?:\\s+(' + COLOR_REGEX_STR + '))?\\s+(.*?)$', 'i'));
  if (midLenCol) {
    const prefix = text.slice(0, midLenCol.index).trim();
    const len = midLenCol[1];
    const col = midLenCol[2] || '';
    const suffix = midLenCol[3].trim();
    if (/^(zinc|aluminum|metal|alloy|flat|round|braided|pvc|cotton|tpe|abs|optical|male|female|type|series)/i.test(suffix)) {
      const base = (prefix + ' ' + suffix).trim();
      let v = [len, col].filter(Boolean).join(' ');
      if (modelCode) v += ` (${modelCode})`;
      if (packaging) v += ` [${packaging}]`;
      return { base, variant: v };
    }
  }

  // Dạng 3: Đuôi ngăn cách bởi dấu gạch ngang hoặc xiên: ' - WHITE+BLACK', ' – Đen', ' - 1m'
  const dashEnd = text.match(/(?:\s+[-–—]\s+|\s*[\u2013\u2014]\s*|\s+[/]\s*)([\p{L}\p{N}\s.,+&/-]{1,30})\s*$/u);
  if (dashEnd) {
    const after = cleanVariantLabel(dashEnd[1]);
    const afterLower = after.toLowerCase();
    const isCol = isColor(after) || new RegExp('^' + COLOR_REGEX_STR + '$', 'i').test(afterLower);
    const isLen = new RegExp('^' + LENGTH_REGEX_STR + '$', 'i').test(afterLower);
    const isCap = new RegExp('^' + CAP_REGEX_STR + '$', 'i').test(afterLower);

    if (isCol || isLen || isCap || /^(pe bag|kraft box|retail box|set|combo)/i.test(after)) {
      let base = text.slice(0, dashEnd.index).replace(/[-–—/\s]+$/, '').trim();
      let v = after;
      // Nếu ngay trước dấu gạch ngang có ngoặc dung tích/chiều dài: Bình Giữ Nhiệt RTIC (1.8L) - Màu Đen
      const prevParen = base.match(/\s*[\(（]([^\)）]+)[\)）]\s*$/);
      if (prevParen) {
        const inside = cleanVariantLabel(prevParen[1]);
        const insideLower = inside.toLowerCase();
        if (new RegExp('^' + CAP_REGEX_STR + '$', 'i').test(insideLower) ||
            new RegExp('^' + LENGTH_REGEX_STR + '$', 'i').test(insideLower) ||
            isColor(inside)) {
          base = base.slice(0, prevParen.index).trim();
          v = inside + ' ' + after;
        }
      }
      if (modelCode) v += ` (${modelCode})`;
      if (packaging) v += ` [${packaging}]`;
      return { base, variant: v };
    }
  }

  // Dạng 4: Chiều dài + Màu ở cuối chuỗi: ' 1M Black', ' 10M Black', ' 1m Red+Black'
  const lenColMatch = text.match(new RegExp('\\s+(' + LENGTH_REGEX_STR + ')\\s+(' + COLOR_REGEX_STR + ')\\s*$', 'i'));
  if (lenColMatch) {
    const base = text.slice(0, lenColMatch.index).replace(/[-–—/\s]+$/, '').trim();
    let v = lenColMatch[1] + ' ' + lenColMatch[2];
    if (modelCode) v += ` (${modelCode})`;
    if (packaging) v += ` [${packaging}]`;
    return { base, variant: v };
  }

  // Dạng 5: Đuôi ngoặc đơn/vuông: ( Black ), ( 1m ), ( 1.8L ), ( AACBF )
  const parenEnd = text.match(/\s*[\(（]([^\)）]+)[\)）](?:\s*[-–—]\s*(PE Bag|Kraft Box|Retail Box|Color box))?\s*([a-zA-Z]*)$/i);
  if (parenEnd) {
    const inside = cleanVariantLabel(parenEnd[1]);
    const pkg = parenEnd[2] ? ` [${parenEnd[2]}]` : '';
    const trailingColor = parenEnd[3] ? cleanVariantLabel(parenEnd[3]) : '';
    const insideLower = inside.toLowerCase();
    const isCol = isColor(inside) || (trailingColor && isColor(trailingColor));
    const isLen = new RegExp('^' + LENGTH_REGEX_STR + '$', 'i').test(insideLower);
    const isCap = new RegExp('^' + CAP_REGEX_STR + '$', 'i').test(insideLower);

    // Không tách các tính năng kỹ thuật dài như (Detachable Microphone...) hay (with Magic...)
    if ((isCol || isLen || isCap || inside.length < 15) &&
        !/^with\b/i.test(inside) &&
        !insideLower.includes('microphone') &&
        !insideLower.includes('driver')) {
      const base = text.slice(0, parenEnd.index).trim();
      let v = cleanVariantLabel([inside, trailingColor].filter(Boolean).join(' ')) + pkg;
      if (modelCode) v += ` (${modelCode})`;
      if (packaging && !pkg) v += ` [${packaging}]`;
      return { base, variant: v };
    }
  }

  // Dạng 6: Từ chỉ chiều dài hoặc màu đứng cuối
  const lenOnlyMatch = text.match(new RegExp('\\s+(' + LENGTH_REGEX_STR + ')\\s*$', 'i'));
  if (lenOnlyMatch) {
    const base = text.slice(0, lenOnlyMatch.index).replace(/[-–—/\s]+$/, '').trim();
    let v = lenOnlyMatch[1];
    if (modelCode) v += ` (${modelCode})`;
    if (packaging) v += ` [${packaging}]`;
    return { base, variant: v };
  }

  const colOnlyMatch = text.match(new RegExp('\\s+(' + COLOR_REGEX_STR + ')\\s*$', 'i'));
  if (colOnlyMatch) {
    const base = text.slice(0, colOnlyMatch.index).replace(/[-–—/\s]+$/, '').trim();
    let v = colOnlyMatch[1];
    if (modelCode) v += ` (${modelCode})`;
    if (packaging) v += ` [${packaging}]`;
    return { base, variant: v };
  }

  return { base: text, variant: null };
}

/**
 * Gom danh sách sản phẩm phẳng thành danh sách sản phẩm có biến thể
 * Tự động gộp các sản phẩm trùng lặp (từ nhiều kho hoặc nhà cung cấp)
 */
function groupProducts(products = []) {
  if (!Array.isArray(products) || products.length === 0) return [];

  const groups = new Map();

  for (const p of products) {
    const { base, variant } = parseVariant(p.name);
    const normBase = normalizeBaseTitle(base);
    // Nhóm theo thương hiệu + tên gốc (không nhóm theo category_id để gộp sản phẩm trùng giữa các danh mục do NCC gán sai)
    const key = (p.brand ? (p.brand.toLowerCase() + ':::') : '') + normBase;

    if (!groups.has(key)) {
      groups.set(key, {
        baseTitle: base,
        brand: p.brand,
        category_id: p.category_id,
        category_name: p.category_name,
        items: []
      });
    }

    groups.get(key).items.push({
      item: p,
      variantName: variant || 'Tiêu chuẩn'
    });
  }

  const result = [];

  for (const group of groups.values()) {
    if (group.items.length === 1) {
      const single = group.items[0].item;
      const cleanName = single.name
        .replace(WAREHOUSE_PREFIX, '')
        .replace(/[\(（]([^\)）]*(?:kho|hà đông|long biên|hn|hcm|sg)[^\)）]*)[\)）]/ig, '')
        .trim();
      result.push({ ...single, name: cleanName });
      continue;
    }

    // Nhiều hơn 1 sản phẩm:
    // Bước 1: Nhóm các phân loại trùng tên lại với nhau (vd: nhiều kho cùng có bản 'Tiêu chuẩn' hoặc 'Đen')
    // Chọn bản còn hàng và giá rẻ nhất cho phân loại đó
    const variantMap = new Map();
    for (const { item, variantName } of group.items) {
      const vKey = variantName.toLowerCase();
      if (!variantMap.has(vKey)) {
        variantMap.set(vKey, { name: variantName, best: item, all: [item] });
      } else {
        const cur = variantMap.get(vKey);
        cur.all.push(item);
        const curInStock = cur.best.in_stock !== false;
        const newInStock = item.in_stock !== false;
        if (!curInStock && newInStock) {
          cur.best = item;
        } else if (curInStock === newInStock) {
          if ((item.price || 0) < (cur.best.price || 0)) {
            cur.best = item;
          }
        }
      }
    }

    // Bước 2: Tạo danh sách variants
    const sortedVariants = [...variantMap.values()].map(vGroup => {
      const it = vGroup.best;
      const anyInStock = vGroup.all.some(x => x.in_stock !== false);
      return {
        id: String(it.variation_id || it.id),
        product_id: it.id,
        source_id: it.source_id ?? (it.id >= 10000000 ? it.id % 10000000 : it.id),
        sku: it.sku || String(it.id),
        name: vGroup.name,
        is_default: false,
        in_stock: anyInStock,
        price: it.price || 0,
        original_price: it.original_price || null,
        dealer_price: it.dealer_price || 0,
        supplier_cost: it.supplier_cost || 0,
        dropbuy_cost: it.dropbuy_cost || it.supplier_cost || 0,
        pricing_rule: it.pricing_rule,
        profit_margin: it.profit_margin,
        weight_gram: it.weight_gram || 0,
        warranty: it.warranty || 'Bảo hành chính hãng',
        image: it.image || '',
        image_hd: it.image_hd || '',
        source_url: it.source_url,
        all_ids: vGroup.all.map(x => x.id)
      };
    }).sort((a, b) => {
      if (a.in_stock !== b.in_stock) return b.in_stock ? 1 : -1;
      return (a.price || 0) - (b.price || 0);
    });

    if (sortedVariants.length > 0) {
      sortedVariants[0].is_default = true;
    }

    // Primary item đại diện cha
    const primary = sortedVariants[0];
    const originalPrimary = group.items.find(x => x.item.id === primary.product_id)?.item || group.items[0].item;

    const sharedImage = primary.image || group.items.find(x => x.item.image)?.item.image || '';
    const sharedImageHd = primary.image_hd || group.items.find(x => x.item.image_hd)?.item.image_hd || '';
    const sharedGallery = (originalPrimary.gallery && originalPrimary.gallery.length)
      ? originalPrimary.gallery
      : (group.items.find(x => x.item.gallery && x.item.gallery.length)?.item.gallery || []);

    const allColors = sortedVariants.every(v => COLOR_WORDS.some(c => v.name.toLowerCase().includes(c)));
    const allLengths = sortedVariants.every(v => LENGTH_REGEX.test(v.name));
    const displayLabel = allColors ? 'Màu sắc' : (allLengths ? 'Chiều dài' : 'Phân loại');

    const hasMultiVariants = sortedVariants.length > 1;

    const variation_options = hasMultiVariants ? [{
      display: displayLabel,
      options: sortedVariants.map(v => v.name)
    }] : [];

    const parent = {
      ...originalPrimary,
      id: originalPrimary.id,
      brand: group.brand || originalPrimary.brand,
      name: group.baseTitle || originalPrimary.name,
      variant_count: sortedVariants.length,
      variation_id: sortedVariants[0].id,
      image: sharedImage,
      image_hd: sharedImageHd,
      gallery: sharedGallery,
      in_stock: sortedVariants.some(v => v.in_stock),
      price: sortedVariants.find(v => v.in_stock)?.price || sortedVariants[0].price,
      original_price: sortedVariants.find(v => v.in_stock)?.original_price || sortedVariants[0].original_price,
      variants: sortedVariants,
      variation_options
    };

    result.push(parent);
  }

  return result;
}

// ───────────── Gộp "cùng dòng, khác kiểu" (bước 2, cho nguồn sỉ khác DropBuy) ─────────────
// Nguồn đăng mỗi kiểu thành 1 sản phẩm riêng, tên chỉ khác 1 cụm ở giữa:
//   Baseus Enjoyment Series Type-C to VGA+PD HUB Convertor Deep gray
//   Baseus Enjoyment Series Type-C to Mini DP + PD HUB Convertor Deep gray
// → 1 bài "Baseus Enjoyment Series Type-C HUB Convertor Deep gray", phân loại: VGA + PD / Mini DP + PD / …
// Mỗi phân loại giữ nguyên mã SP gốc (product_id/source_id) nên đặt hàng vẫn đúng món.
const FAMILY_MIN_PREFIX = 3;   // ≥ 3 từ chung ở đầu (thương hiệu + dòng + …)
const FAMILY_MIN_KEPT = 5;     // ≥ 5 từ chung tổng cộng
const FAMILY_MAX_WINDOW = 3;   // cụm khác nhau ≤ 3 từ
const FAMILY_MAX_PRICE_RATIO = 2; // chênh giá > 2 lần thường là mẫu khác hẳn (Air Mini vs Air Pro) → không gộp
const FAMILY_MAX_MEMBERS = 12;
const FAMILY_MAX_VARIANTS = 24; // nhiều hơn: thường là trộn nhiều loại cáp khác nhau → không gộp
const DANGLING = new Set(['to', 'for', 'with', 'and', 'sang', 'cho', 'và', 'cùng', '-', '–', '/', '+']);

// "Mini DP + PD" → "Mini", "DP+PD": dấu + / & dính vào từ để 1 cụm không bị đếm thành nhiều từ
const familyTokens = name => String(name || '').replace(/\s*([+&])\s*/g, '$1').trim().split(/\s+/).filter(Boolean);
const tokKey = t => normalizeBaseTitle(t) || t.toLowerCase();
const spaced = s => s.replace(/([+&])/g, ' $1 ').replace(/\s+/g, ' ').trim();
// Độ sâu ngoặc sau mỗi từ: chỉ cắt cụm khác nhau ở chỗ KHÔNG nằm trong ngoặc và cụm phải đủ cặp ngoặc
// (tránh nhãn kiểu "(EU · BLACK" hay "Audio) · WHITE")
function bracketDepths(toks) {
  const out = [];
  let d = 0;
  for (const t of toks) {
    for (const ch of t) {
      if ('([（【'.includes(ch)) d++;
      else if (')]）】'.includes(ch)) d--;
    }
    out.push(d);
  }
  return out;
}
const HAS_WORD = /[\p{L}\p{N}]/u;

function mergeFamilies(list = []) {
  if (!Array.isArray(list) || list.length < 2) return list;
  const info = list.map((p, idx) => ({ p, idx, toks: familyTokens(p.name) }));
  const sigs = new Map();
  for (const it of info) {
    const n = it.toks.length;
    if (!it.p.brand || n < FAMILY_MIN_KEPT + 1) continue;
    const keys = it.toks.map(tokKey);
    const depth = bracketDepths(it.toks);
    if (depth[n - 1] !== 0) continue; // tên lệch ngoặc: không đoán
    for (let w = 1; w <= FAMILY_MAX_WINDOW; w++) {
      if (n - w < FAMILY_MIN_KEPT) continue;
      for (let i = FAMILY_MIN_PREFIX; i + w <= n; i++) {
        if (depth[i - 1] !== 0 || depth[i + w - 1] !== 0) continue;
        let inside = false;
        for (let k = i; k < i + w - 1; k++) if (depth[k] < 0) inside = true;
        if (inside || !HAS_WORD.test(it.toks.slice(i, i + w).join(''))) continue;
        const sig = `${String(it.p.brand).toLowerCase()}|${keys.slice(0, i).join(' ')}|_|${keys.slice(i + w).join(' ')}`;
        let s = sigs.get(sig);
        if (!s) sigs.set(sig, (s = { kept: n - w, members: [] }));
        s.members.push({ it, i, w });
      }
    }
  }

  // Cụm lớn + phần chung dài trước; mỗi SP chỉ vào 1 cụm
  const cands = [...sigs.values()].filter(s => s.members.length >= 2)
    .sort((a, b) => b.members.length - a.members.length || b.kept - a.kept);
  const used = new Set();
  const merged = new Map(); // idx nhỏ nhất của cụm → SP cha; các idx khác → null (bỏ)
  for (const s of cands) {
    const seen = new Set();
    const members = s.members.filter(m => {
      if (used.has(m.it.idx) || seen.has('#' + m.it.idx)) return false;
      const k = m.it.toks.slice(m.i, m.i + m.w).map(tokKey).join(' ');
      if (seen.has(k)) return false;
      seen.add(k); seen.add('#' + m.it.idx);
      return true;
    });
    if (members.length < 2 || members.length > FAMILY_MAX_MEMBERS) continue;
    const prices = members.map(m => Number(m.it.p.price) || 0).filter(x => x > 0);
    if (!prices.length || Math.max(...prices) / Math.min(...prices) > FAMILY_MAX_PRICE_RATIO) continue;
    const parent = buildFamily(members);
    if (!parent) continue;
    members.forEach(m => used.add(m.it.idx));
    const first = Math.min(...members.map(m => m.it.idx));
    for (const m of members) merged.set(m.it.idx, m.it.idx === first ? parent : null);
  }
  if (!merged.size) return list;
  const out = [];
  list.forEach((p, idx) => {
    if (!merged.has(idx)) out.push(p);
    else if (merged.get(idx)) out.push(merged.get(idx));
  });
  return out;
}

function familyVariantOf(it, name) {
  return {
    id: String(it.variation_id || it.id),
    product_id: it.id,
    source_id: it.source_id ?? (it.id >= 10000000 ? it.id % 10000000 : it.id),
    sku: it.sku || String(it.id),
    name,
    is_default: false,
    in_stock: it.in_stock !== false,
    price: it.price || 0,
    original_price: it.original_price || null,
    dealer_price: it.dealer_price || 0,
    supplier_cost: it.supplier_cost || 0,
    dropbuy_cost: it.dropbuy_cost || it.supplier_cost || 0,
    pricing_rule: it.pricing_rule,
    profit_margin: it.profit_margin,
    weight_gram: it.weight_gram || 0,
    warranty: it.warranty || 'Bảo hành chính hãng',
    image: it.image || '',
    image_hd: it.image_hd || '',
    source_url: it.source_url,
    category_id: it.category_id,
    all_ids: [it.id]
  };
}

function buildFamily(members) {
  const variants = [];
  for (const { it, i, w } of members) {
    const label = cleanVariantLabel(spaced(it.toks.slice(i, i + w).join(' ')));
    const p = it.p;
    if (Array.isArray(p.variants) && p.variants.length > 1) {
      for (const v of p.variants) variants.push({ ...v, name: `${label} · ${v.name}`, category_id: v.category_id || p.category_id, is_default: false });
    } else if (Array.isArray(p.variants) && p.variants.length === 1) {
      variants.push({ ...p.variants[0], name: label, category_id: p.category_id, is_default: false });
    } else {
      variants.push(familyVariantOf(p, label));
    }
  }
  if (variants.length > FAMILY_MAX_VARIANTS) return null;
  const ids = new Set();
  for (const v of variants) { if (ids.has(v.id)) return null; ids.add(v.id); } // trùng mã phân loại → không gộp
  variants.sort((a, b) => (a.in_stock !== b.in_stock ? (b.in_stock ? 1 : -1) : (a.price || 0) - (b.price || 0)));
  variants[0].is_default = true;

  const { it: first, i, w } = members[0];
  let prefix = first.toks.slice(0, i);
  const suffix = first.toks.slice(i + w);
  while (prefix.length > FAMILY_MIN_PREFIX && DANGLING.has(prefix[prefix.length - 1].toLowerCase())) prefix = prefix.slice(0, -1);
  const name = spaced([...prefix, ...suffix].join(' ')).replace(/[\s,;:–—/-]+$/, '');

  const def = variants[0];
  const items = members.map(m => m.it.p);
  const primary = items.find(p => p.id === def.product_id || (p.variants || []).some(v => v.id === def.id)) || first.p;
  const inStock = variants.find(v => v.in_stock);
  const gallery = (primary.gallery && primary.gallery.length) ? primary.gallery : (items.find(p => p.gallery && p.gallery.length)?.gallery || []);
  return {
    ...primary,
    name,
    slug: normalizeBaseTitle(name).replace(/ /g, '-'),
    family_merged: true,
    category_ids: [...new Set(items.map(p => p.category_id).filter(x => x != null))],
    variant_count: variants.length,
    variation_id: def.id,
    image: def.image || primary.image,
    image_hd: def.image_hd || primary.image_hd,
    gallery,
    in_stock: !!inStock,
    price: (inStock || def).price,
    original_price: (inStock || def).original_price,
    variants,
    variation_options: [{ display: 'Phân loại', options: variants.map(v => v.name) }]
  };
}

/**
 * Tìm sản phẩm theo id cha hoặc id của bất kỳ biến thể nào
 */
function findInGrouped(groupedProducts = [], id) {
  const n = Number(id);
  const s = String(id);
  for (const p of groupedProducts) {
    if (p.id === n) return p;
    if (Array.isArray(p.variants)) {
      if (p.variants.some(v => String(v.id) === s || Number(v.product_id) === n || (Array.isArray(v.all_ids) && v.all_ids.includes(n)))) {
        return p;
      }
    }
  }
  return null;
}

module.exports = {
  parseVariant,
  groupProducts,
  mergeFamilies,
  findInGrouped,
  COLOR_WORDS,
  WAREHOUSE_PREFIX
};
