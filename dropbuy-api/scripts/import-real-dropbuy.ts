import { PrismaClient, Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();
const D = (n: number) => new Prisma.Decimal(n);

async function main() {
  console.log('--- BẮT ĐẦU IMPORT 100% SẢN PHẨM & HÌNH ẢNH DROPBUY VÀO D:\\dropbuy-api ---');

  // Đọc danh mục và sản phẩm đã cào
  const dataDir = 'C:/Users/nskka/.gemini/antigravity/scratch/hoangminh-dropbuy-relay/data';
  const productsFile = path.join(dataDir, 'products.json');
  const categoriesFile = path.join(dataDir, 'categories.json');

  if (!fs.existsSync(productsFile)) {
    throw new Error('Chưa tìm thấy products.json!');
  }

  const rawProducts = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
  const rawCategories = fs.existsSync(categoriesFile) ? JSON.parse(fs.readFileSync(categoriesFile, 'utf8')) : [];

  console.log(`Tìm thấy: ${rawCategories.length} danh mục và ${rawProducts.length} sản phẩm thực tế.`);

  // 1. Lấy hoặc tạo shop mặc định (Shop id = 1)
  let shop = await prisma.shop.findFirst({ where: { id: 1 } });
  if (!shop) {
    const shopUser = await prisma.user.findFirst({ where: { username: 'shopdemo' } }) ||
                     await prisma.user.findFirst();
    if (!shopUser) throw new Error('Cần chạy npm run seed trước để có user!');
    shop = await prisma.shop.create({
      data: {
        id: 1,
        user_id: shopUser.id,
        name: 'kho-tong-dropbuy',
        display_name: 'Kho Tổng DropBuy',
        fullname: 'DropBuy Fulfillment Center',
        phone: '19006868',
        address_line: 'Kho Tổng Sài Gòn & Hà Nội',
        is_mall: true,
        enable_virtual_depot: true
      }
    });
  }

  // 2. Lấy hoặc tạo depot mặc định
  let depot = await prisma.shopDepot.findFirst({ where: { shop_id: shop.id } });
  if (!depot) {
    depot = await prisma.shopDepot.create({
      data: {
        unique_id: randomUUID(),
        depot_code: `DP-1-1001-1`,
        shop_id: shop.id,
        name: 'Kho Tổng Hà Nội',
        fullname: 'Kho DropBuy 1'
      }
    });
  }

  // 3. Import Categories
  console.log('[1/3] Đang cập nhật 82 danh mục chuẩn DropBuy...');
  for (const cat of rawCategories) {
    await prisma.category.upsert({
      where: { id: cat.id },
      create: {
        id: cat.id,
        name: cat.name,
        slug: cat.slug || `category-${cat.id}`,
        parent_id: cat.parent_id || null,
        num: cat.id
      },
      update: {
        name: cat.name,
        slug: cat.slug || `category-${cat.id}`
      }
    });
  }

  // 4. Import 1,136 Products with Valid Images
  console.log(`[2/3] Đang import ${rawProducts.length} sản phẩm và album hình ảnh...`);
  let count = 0;

  for (const item of rawProducts) {
    // Đảm bảo URL ảnh chuẩn _256x256 (không dùng _512x512)
    let thumbUrl = item.image || '';
    if (thumbUrl.includes('_512x512')) thumbUrl = thumbUrl.replace('_512x512', '_256x256');

    let hdUrl = item.image_hd || thumbUrl;
    if (hdUrl.includes('_512x512')) hdUrl = hdUrl.replace('_512x512', '_1024x1024');

    const imagesJson = JSON.stringify([hdUrl]);

    // Upsert Product
    const p = await prisma.product.upsert({
      where: { id: item.id },
      create: {
        id: item.id,
        unique_id: randomUUID(),
        shop_id: shop.id,
        category_id: item.category_id || 1,
        name: item.name,
        slug: item.slug || `san-pham-${item.id}`,
        description: `<p>${item.name}</p>`,
        status: 'A',
        admin_status: 'A',
        is_mall: true,
        aff_enabled: true,
        aff_rate: D(10),
        weight_gram: 500,
        thumbnail_url: thumbUrl,
        images: imagesJson,
        sold_count: 50 + (item.id % 200),
        rate_avg: D(5.0),
        rate_count: 20
      },
      update: {
        name: item.name,
        slug: item.slug || `san-pham-${item.id}`,
        thumbnail_url: thumbUrl,
        images: imagesJson,
        status: 'A',
        admin_status: 'A'
      }
    });

    // Variation
    const varSku = item.sku || `DB-${item.id}`;
    let variation = await prisma.variation.findFirst({ where: { sku: varSku } });
    if (!variation) {
      variation = await prisma.variation.create({
        data: {
          id: randomUUID(),
          product_id: p.id,
          name: item.name,
          sku: varSku,
          price_public: D(item.price || 100000),
          price_f1: D(item.dropbuy_cost || item.price * 0.8),
          thumbnail_url: thumbUrl,
          status: 'A',
          num: 0
        }
      });
    } else {
      await prisma.variation.update({
        where: { id: variation.id },
        data: {
          price_public: D(item.price || 100000),
          price_f1: D(item.dropbuy_cost || item.price * 0.8),
          thumbnail_url: thumbUrl
        }
      });
    }

    // Set stock to 99 so it's always in-stock
    await prisma.stock.upsert({
      where: {
        variation_id_depot_id: {
          variation_id: variation.id,
          depot_id: depot.id
        }
      },
      create: {
        variation_id: variation.id,
        depot_id: depot.id,
        current_stock: item.stock_qty || 99
      },
      update: {
        current_stock: item.stock_qty || 99
      }
    });

    count++;
    if (count % 200 === 0) {
      console.log(`Đã nạp ${count}/${rawProducts.length} sản phẩm...`);
    }
  }

  console.log(`[3/3] HOÀN TẤT! Đã nạp thành công 100% (${count}) sản phẩm và hình ảnh DropBuy vào D:\\dropbuy-api.`);
}

main()
  .catch(err => {
    console.error('Lỗi import:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
