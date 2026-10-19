// Tích hợp phần mềm bán hàng của shop (KiotViet / Nhanh / Pancake): cấu hình, map SKU, tra tồn, đẩy đơn, webhook.
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { E } from '../lib/http.js';
import { route, body, arr, type Req } from '../lib/router.js';
import { requireShop } from '../lib/auth.js';
import { paging, paged, opt } from '../lib/paging.js';
import { shippingFee } from '../lib/shipping.js';
import { getConfig, searchProducts, createOrder, orderDetail, kvInvoice, kvWebhooks, nhanhAccessToken, REQUIRED, type Provider } from '../lib/integrations.js';

const mask = (cfg: Record<string, string>) => Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, /secret|key|token|password/i.test(k) && v ? `${String(v).slice(0, 3)}***` : v]));

export default function integrations(app: FastifyInstance) {
  for (const provider of ['kiotviet', 'nhanh', 'pancake'] as Provider[]) {
    const base = `/bff/${provider}/:fx_hash`;
    const ctx = async (req: Req) => {
      const { shop } = await requireShop(req);
      return { shop, c: await getConfig(shop.id, provider) };
    };

    route(app, 'GET', `${base}/app-config/detail`, async (req) => {
      const { shop } = await requireShop(req);
      const c = await prisma.integrationConfig.findUnique({ where: { shop_id_provider: { shop_id: shop.id, provider } } });
      return c ? { provider, shop_id: shop.id, config: mask(JSON.parse(c.config)), has_access_token: !!c.access_token, token_expired_at: c.token_expired_at, updated_at: c.updated_at } : null;
    });
    const upsert = async (req: Req) => {
      const { shop } = await requireShop(req);
      const b = body(req);
      const input = (b.config ?? b) as Record<string, unknown>;
      const cur = await prisma.integrationConfig.findUnique({ where: { shop_id_provider: { shop_id: shop.id, provider } } });
      const merged: Record<string, string> = { ...(cur ? JSON.parse(cur.config) : {}) };
      for (const [k, v] of Object.entries(input)) if (v != null && v !== '' && !String(v).endsWith('***')) merged[k] = String(v);
      const missing = REQUIRED[provider].filter((k) => !merged[k]);
      if (missing.length) throw E.invalid(`Thiếu cấu hình: ${missing.join(', ')}`);
      const c = await prisma.integrationConfig.upsert({ where: { shop_id_provider: { shop_id: shop.id, provider } }, create: { shop_id: shop.id, provider, config: JSON.stringify(merged) }, update: { config: JSON.stringify(merged), access_token: null, token_expired_at: null } });
      return { provider, shop_id: shop.id, config: mask(merged), updated_at: c.updated_at };
    };
    route(app, 'POST', `${base}/app-config/${provider === 'kiotviet' ? 'ensure' : 'upsert'}`, upsert);

    // Tra sản phẩm/tồn trên phần mềm của shop
    route(app, 'POST', `${base}/search`, async (req) => {
      const { c } = await ctx(req);
      const b = body(req);
      const rows = await searchProducts(c, String(b.keyword ?? ''));
      const codes = arr<string>(b.inventory_codes);
      return codes.length ? rows.filter((r) => codes.includes(r.external_code)) : rows;
    });

    // Map SKU DropBuy ↔ mã hàng bên đối tác
    route(app, 'POST', `${base}/product-mapping/list`, async (req) => {
      const { shop } = await requireShop(req);
      const b = body(req);
      const p = paging(b);
      const where = { shop_id: shop.id, provider, ...(opt(b.keyword) ? { external_code: { contains: String(b.keyword) } } : {}) };
      const [total, rows] = await Promise.all([prisma.integrationProductMapping.count({ where }), prisma.integrationProductMapping.findMany({ where, orderBy: { id: 'desc' }, skip: p.skip, take: p.take })]);
      const vs = await prisma.variation.findMany({ where: { id: { in: rows.map((r) => r.variation_id) } } });
      return paged(p, total, rows.map((r) => ({ ...r, sku: vs.find((v) => v.id === r.variation_id)?.sku, variation_name: vs.find((v) => v.id === r.variation_id)?.name })));
    });
    route(app, 'POST', `${base}/product-mapping/bulk-upsert`, async (req) => {
      const { shop } = await requireShop(req);
      const items = arr<{ sku?: string; variation_id?: string; external_code: string; external_name?: string }>(body(req).items);
      const out = [];
      for (const it of items) {
        const v = it.variation_id ? await prisma.variation.findUnique({ where: { id: it.variation_id } }) : await prisma.variation.findUnique({ where: { sku: String(it.sku ?? '') } });
        const p = v ? await prisma.product.findUnique({ where: { id: v.product_id } }) : null;
        if (!v || p?.shop_id !== shop.id) throw E.notFound(`SKU ${it.sku ?? it.variation_id}`);
        if (!it.external_code) throw E.invalid('Thiếu external_code');
        out.push(await prisma.integrationProductMapping.upsert({ where: { shop_id_provider_variation_id: { shop_id: shop.id, provider, variation_id: v.id } }, create: { shop_id: shop.id, provider, variation_id: v.id, external_code: it.external_code, external_name: it.external_name ?? null }, update: { external_code: it.external_code, external_name: it.external_name ?? null } }));
      }
      return out;
    });
    route(app, 'POST', `${base}/product-mapping/delete`, async (req) => {
      const { shop } = await requireShop(req);
      const b = body(req);
      const r = await prisma.integrationProductMapping.deleteMany({ where: { shop_id: shop.id, provider, OR: [{ id: { in: arr<number>(b.ids).map(Number) } }, { variation_id: { in: arr<string>(b.variation_ids) } }] } });
      return { deleted: r.count };
    });

    // Phí ship (dùng bảng phí nội bộ, theo kho giao của shop)
    route(app, 'POST', `${base}/get-shipping-fee`, async (req) => {
      const { shop } = await requireShop(req);
      const b = body(req);
      const depot = b.sender_depot_code ? await prisma.shopDepot.findUnique({ where: { depot_code: String(b.sender_depot_code) } }) : await prisma.shopDepot.findFirst({ where: { shop_id: shop.id, status: 'A' } });
      return { shipping_method: b.shipping_method ?? 'V', shipping_amount: shippingFee({ weight_gram: Number(b.weight_gram ?? 500), from_province_id: depot?.province_id ?? 0, to_province_id: Number(b.receiver?.province_id ?? b.receiver_province_id ?? 0), method: b.shipping_method }) };
    });

    // Đẩy đơn DropBuy sang phần mềm của shop (cần map SKU trước)
    const pushOrder = async (shop_id: number, order_id: number, c: Awaited<ReturnType<typeof getConfig>>) => {
      const o = await prisma.order.findUnique({ where: { id: order_id } });
      if (!o || o.shop_id !== shop_id) throw E.notFound(`Đơn ${order_id}`);
      const exist = await prisma.integrationOrderLink.findFirst({ where: { shop_id, provider, order_id: o.id } });
      if (exist) return { order_id: o.id, order_code: o.code, external_code: exist.external_code, already_created: true };
      const its = await prisma.orderItem.findMany({ where: { order_id: o.id } });
      const maps = await prisma.integrationProductMapping.findMany({ where: { shop_id, provider, variation_id: { in: its.map((i) => i.variation_id) } } });
      const missing = its.filter((i) => !maps.some((m) => m.variation_id === i.variation_id));
      if (missing.length) throw E.business(`Chưa map SKU: ${missing.map((m) => m.sku).join(', ')}`);
      const r = await createOrder(c, { code: o.code, receiver_fullname: o.receiver_fullname, receiver_phone: o.receiver_phone, receiver_address_line: o.receiver_address_line, cod_amount: Number(o.cod_amount), notes: o.notes, items: its.map((i) => ({ external_code: maps.find((m) => m.variation_id === i.variation_id)!.external_code, quantity: i.quantity, price: Number(i.price) })) });
      await prisma.integrationOrderLink.create({ data: { shop_id, provider, order_id: o.id, external_code: r.external_code } });
      return { order_id: o.id, order_code: o.code, external_code: r.external_code, already_created: false };
    };
    if (provider !== 'nhanh') {
      route(app, 'POST', `${base}/create-order`, async (req) => {
        const { shop, c } = await ctx(req);
        return pushOrder(shop.id, Number(body(req).order_id), c);
      });
      route(app, 'POST', `${base}/detail`, async (req) => {
        const { shop, c } = await ctx(req);
        const b = body(req);
        const link = b.order_id ? await prisma.integrationOrderLink.findFirst({ where: { shop_id: shop.id, provider, order_id: Number(b.order_id) } }) : null;
        const ext = String(b.external_code ?? link?.external_code ?? '');
        if (!ext) throw E.notFound('Liên kết đơn');
        return { external_code: ext, data: await orderDetail(c, ext) };
      });
    }
    if (provider === 'pancake') {
      route(app, 'POST', `${base}/create-orders`, async (req) => {
        const { shop, c } = await ctx(req);
        const out = [];
        for (const id of arr<number>(body(req).order_ids)) {
          try {
            out.push(await pushOrder(shop.id, Number(id), c));
          } catch (e) {
            out.push({ order_id: Number(id), error: (e as Error).message });
          }
        }
        return out;
      });
    }
    if (provider === 'kiotviet') {
      route(app, 'POST', `${base}/fetch-invoice`, async (req) => {
        const { c } = await ctx(req);
        return kvInvoice(c, String(body(req).invoice_code ?? body(req).code ?? ''));
      });
      route(app, 'GET', `${base}/webhook/list`, async (req) => {
        const { shop, c } = await ctx(req);
        return { local: await prisma.integrationWebhook.findMany({ where: { shop_id: shop.id, provider } }), remote: await kvWebhooks(c, 'list') };
      });
      route(app, 'POST', `${base}/webhook/register`, async (req) => {
        const { shop, c } = await ctx(req);
        const b = body(req);
        const event = String(b.event ?? 'stock.update');
        const url = String(b.url ?? `${process.env.PUBLIC_BASE_URL ?? 'http://localhost:4000'}/webhooks/kiotviet/${shop.id}`);
        await kvWebhooks(c, 'register', { event, url });
        return prisma.integrationWebhook.upsert({ where: { shop_id_provider_event: { shop_id: shop.id, provider, event } }, create: { shop_id: shop.id, provider, event, url }, update: { url } });
      });
      route(app, 'POST', `${base}/webhook/unregister`, async (req) => {
        const { shop, c } = await ctx(req);
        const b = body(req);
        if (b.id) await kvWebhooks(c, 'unregister', { id: String(b.id) });
        await prisma.integrationWebhook.deleteMany({ where: { shop_id: shop.id, provider, ...(b.event ? { event: String(b.event) } : {}) } });
        return null;
      });
    }
    if (provider === 'nhanh') {
      route(app, 'POST', `${base}/get-access-token`, async (req) => {
        const { c } = await ctx(req);
        const r = await nhanhAccessToken(c, String(body(req).access_code ?? ''));
        await prisma.integrationConfig.update({ where: { id: c.id }, data: { access_token: r.accessToken, token_expired_at: r.expiredDateTime ? new Date(r.expiredDateTime) : null } });
        return { code: 1, message: 'OK', accessToken: '***', businessId: r.businessId, expiredDateTime: r.expiredDateTime };
      });
    }
  }
}
