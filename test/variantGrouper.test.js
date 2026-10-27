'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVariant, groupProducts, findInGrouped } = require('../services/variantGrouper');

test('parseVariant: tách chính xác màu sắc và kích thước', () => {
  // Ngoặc đơn
  assert.deepEqual(parseVariant('Loa Bluetooth USAMS US-YX012 ( black )'), {
    base: 'Loa Bluetooth USAMS US-YX012',
    variant: 'black'
  });

  // Ngoặc đơn có đóng gói & chiều dài + màu
  const vention = parseVariant('Vention HDMI Cable 1M Black ( AACBF) – PE Bag');
  assert.equal(vention.base, 'Vention HDMI Cable');
  assert.ok(vention.variant.includes('1M') && vention.variant.includes('Black'));

  // Gạch ngang
  assert.deepEqual(parseVariant('Tai nghe Bluetooth SoundPEATS Clear - Đen'), {
    base: 'Tai nghe Bluetooth SoundPEATS Clear',
    variant: 'Đen'
  });

  // Màu đứng cuối (không bị lỗi nuốt chữ)
  assert.deepEqual(parseVariant('Baseus Premium Car Ashtray Dark gray'), {
    base: 'Baseus Premium Car Ashtray',
    variant: 'Dark gray'
  });
  assert.deepEqual(parseVariant('Baseus Premium Car Ashtray Black'), {
    base: 'Baseus Premium Car Ashtray',
    variant: 'Black'
  });

  // Chiều dài + màu đứng cuối
  assert.deepEqual(parseVariant('Cáp sạc Baseus Cafule USB to Type-C 3A 1m Red+Black'), {
    base: 'Cáp sạc Baseus Cafule USB to Type-C 3A',
    variant: '1m Red+Black'
  });

  // Dạng vòi xịt xe: Xm after water filling [Color]
  assert.deepEqual(parseVariant('Baseus Simple Life Car Wash Spray Nozzle (with Magic Telescopic Water Pipe) 7.5m after water filling Black'), {
    base: 'Baseus Simple Life Car Wash Spray Nozzle (with Magic Telescopic Water Pipe)',
    variant: '7.5m after water filling Black'
  });

  // Tiền tố kho hàng DropBuy được bóc tách sạch sẽ
  assert.deepEqual(parseVariant('[LB] Củ sạc nhanh 35W VOLTME Revo 35 Duo - Đen'), {
    base: 'Củ sạc nhanh 35W VOLTME Revo 35 Duo',
    variant: 'Đen'
  });
  assert.deepEqual(parseVariant('( Kho Hà Đông ) Bình Giữ Nhiệt RTIC Insulated Jug (1.8L)'), {
    base: 'Bình Giữ Nhiệt RTIC Insulated Jug',
    variant: '1.8L'
  });

  // Tai nghe gaming có thông số kỹ thuật trong ngoặc đơn
  const havit = parseVariant('Tai Nghe Chụp Tai Gaming Có Dây HAVIT Fuxi H5D (Detachable Microphone, 50mm Driver, 2.1m) - WHITE+BLACK');
  assert.equal(havit.base, 'Tai Nghe Chụp Tai Gaming Có Dây HAVIT Fuxi H5D (Detachable Microphone, 50mm Driver, 2.1m)');
  assert.equal(havit.variant, 'WHITE+BLACK');

  // Củ sạc Anker
  const anker = parseVariant('Củ Sạc Nhanh 2C+1A ANKER PowerPort III A2667 65W (GaN II Charger) – Đen');
  assert.equal(anker.base, 'Củ Sạc Nhanh 2C+1A ANKER PowerPort III A2667 65W (GaN II Charger)');
  assert.equal(anker.variant, 'Đen');

  // Không có phân loại
  assert.deepEqual(parseVariant('Pin sạc dự phòng Baseus Blade'), {
    base: 'Pin sạc dự phòng Baseus Blade',
    variant: null
  });
});

test('groupProducts: gộp nhiều biến thể vào một sản phẩm cha', () => {
  const items = [
    { id: 10001, name: 'Tai nghe Bluetooth Pro ( Đen )', brand: 'Havit', category_id: 5, price: 200000, in_stock: true, image: 'img-black.jpg' },
    { id: 10002, name: 'Tai nghe Bluetooth Pro ( Trắng )', brand: 'Havit', category_id: 5, price: 210000, in_stock: true, image: 'img-white.jpg' },
    { id: 10003, name: 'Cáp sạc đơn lẻ', brand: 'Havit', category_id: 5, price: 50000, in_stock: true, image: 'cable.jpg' }
  ];

  const grouped = groupProducts(items);
  assert.equal(grouped.length, 2);

  const parent = grouped.find(p => p.name === 'Tai nghe Bluetooth Pro');
  assert.ok(parent);
  assert.equal(parent.variant_count, 2);
  assert.equal(parent.variants.length, 2);
  assert.equal(parent.variation_options[0].display, 'Màu sắc');
  assert.deepEqual(parent.variation_options[0].options, ['Đen', 'Trắng']);

  const single = grouped.find(p => p.name === 'Cáp sạc đơn lẻ');
  assert.ok(single);
  assert.equal(single.id, 10003);
});

test('groupProducts: gộp cáp nhiều độ dài và màu sắc (Vention / Baseus / Anker)', () => {
  const items = [
    { id: 20001, name: 'Vention HDMI Cable 1M Black', brand: 'Vention', price: 50000, in_stock: true },
    { id: 20002, name: 'Vention HDMI Cable 1.5M Black', brand: 'Vention', price: 65000, in_stock: true },
    { id: 20003, name: 'Vention HDMI Cable 2M Black', brand: 'Vention', price: 80000, in_stock: true },
    { id: 20004, name: 'Vention HDMI Cable 5M Black', brand: 'Vention', price: 120000, in_stock: true }
  ];

  const grouped = groupProducts(items);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].name, 'Vention HDMI Cable');
  assert.equal(grouped[0].variant_count, 4);
  assert.equal(grouped[0].variants.length, 4);
  assert.equal(grouped[0].price, 50000);
});

test('groupProducts: gộp sản phẩm trùng giữa các kho DropBuy và chọn giá tốt nhất', () => {
  const items = [
    { id: 141073, name: 'Bàn là hơi nước mini cầm tay Bizond / STMR-010116', price: 1150000, in_stock: false, category_id: 4 },
    { id: 141328, name: 'Bàn là hơi nước mini cầm tay Bizond / STMR-010116', price: 298000, in_stock: true, category_id: 4 },
    { id: 140202, name: '[LB] Bình Giữ Nhiệt RTIC (1.8L) - Màu Đen', price: 275000, in_stock: true, category_id: 59 },
    { id: 137780, name: '( Kho Hà Đông ) Bình Giữ Nhiệt RTIC (1.8L)', price: 298000, in_stock: true, category_id: 1 }
  ];

  const grouped = groupProducts(items);
  // Bizond 2 kho gộp thành 1, RTIC 2 kho gộp thành 1
  assert.equal(grouped.length, 2);

  const bizond = grouped.find(p => p.name.includes('Bizond'));
  assert.ok(bizond);
  // Ưu tiên kho còn hàng và giá rẻ nhất (298k thay vì 1150k hết hàng)
  assert.equal(bizond.price, 298000);
  assert.equal(bizond.in_stock, true);

  const rtic = grouped.find(p => p.name.includes('RTIC'));
  assert.ok(rtic);
  assert.equal(rtic.variant_count, 2);
});

test('findInGrouped: tìm sản phẩm cha qua ID cha, ID biến thể hoặc ID các kho trùng', () => {
  const items = [
    { id: 10001, name: 'Loa Mini ( Đỏ )', brand: 'Anker', category_id: 1, price: 300000, in_stock: true },
    { id: 10002, name: 'Loa Mini ( Xanh )', brand: 'Anker', category_id: 1, price: 300000, in_stock: true },
    { id: 20001, name: 'Cáp C-C 100W', price: 100000, in_stock: false },
    { id: 20002, name: 'Cáp C-C 100W', price: 80000, in_stock: true } // trùng kho 20001
  ];
  const grouped = groupProducts(items);

  // Tìm bằng ID cha (10001)
  assert.equal(findInGrouped(grouped, 10001)?.name, 'Loa Mini');
  // Tìm bằng ID biến thể con (10002)
  assert.equal(findInGrouped(grouped, 10002)?.name, 'Loa Mini');
  // Tìm bằng ID kho phụ đã gộp (20001)
  assert.equal(findInGrouped(grouped, 20001)?.name, 'Cáp C-C 100W');
  // ID không tồn tại
  assert.equal(findInGrouped(grouped, 99999), null);
});
