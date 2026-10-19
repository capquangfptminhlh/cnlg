// Adapter kết nối phần mềm bán hàng của shop: KiotViet, Nhanh.vn, Pancake POS.
// Gọi API thật khi shop đã cấu hình khoá; INTEGRATION_MOCK=true trả dữ liệu giả lập (dev/test).
// LƯU Ý: endpoint/payload theo tài liệu công khai của từng bên – kiểm tra lại với tài khoản thật trước khi chạy production.
import type { IntegrationConfig } from '@prisma/client';
import { prisma } from './db.js';
import { E } from './http.js';

export type Provider = 'kiotviet' | 'nhanh' | 'pancake';
export type ExtProduct = { external_code: string; name: string; on_hand: number; price?: number };
export type ExtOrder = { code: string; receiver_fullname: string; receiver_phone: string; receiver_address_line: string; items: { external_code: string; quantity: number; price: number }[]; cod_amount: number; notes?: string | null };

const mock = () => process.env.INTEGRATION_MOCK === 'true';
const cfg = (c: IntegrationConfig) => JSON.parse(c.config) as Record<string, string>;

async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 15000);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const text = await r.text();
    const json = text ? JSON.parse(text) : null;
    if (!r.ok) throw E.business(`Đối tác trả lỗi HTTP ${r.status}: ${text.slice(0, 200)}`, 3500);
    return json;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw E.business('Đối tác không phản hồi (timeout)', 3501);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ───────────── KiotViet ─────────────
const KV_API = 'https://public.kiotapi.com';
async function kvToken(c: IntegrationConfig) {
  if (c.access_token && c.token_expired_at && c.token_expired_at > new Date(Date.now() + 60_000)) return c.access_token;
  const x = cfg(c);
  const r = await http('https://id.kiotviet.vn/connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ scopes: 'PublicApi.Access', grant_type: 'client_credentials', client_id: x.client_id, client_secret: x.client_secret }),
  });
  await prisma.integrationConfig.update({ where: { id: c.id }, data: { access_token: r.access_token, token_expired_at: new Date(Date.now() + Number(r.expires_in ?? 3600) * 1000) } });
  return r.access_token as string;
}
const kvHeaders = async (c: IntegrationConfig) => ({ Retailer: cfg(c).retailer, Authorization: `Bearer ${await kvToken(c)}`, 'content-type': 'application/json' });

// ───────────── Nhanh.vn (API v2, form-urlencoded + data JSON) ─────────────
async function nhanh(c: IntegrationConfig, path: string, data: unknown) {
  const x = cfg(c);
  const r = await http(`https://open.nhanh.vn/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ version: '2.0', appId: x.app_id, businessId: x.business_id, accessToken: c.access_token ?? x.access_token ?? '', data: JSON.stringify(data) }),
  });
  if (r?.code !== 1) throw E.business(`Nhanh.vn: ${JSON.stringify(r?.messages ?? r).slice(0, 200)}`, 3502);
  return r.data;
}

// ───────────── Pancake POS ─────────────
const pk = (c: IntegrationConfig, path: string) => {
  const x = cfg(c);
  return `https://pos.pages.fm/api/v1/shops/${x.shop_id}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(x.api_key)}`;
};

export async function getConfig(shop_id: number, provider: Provider) {
  const c = await prisma.integrationConfig.findUnique({ where: { shop_id_provider: { shop_id, provider } } });
  if (!c) throw E.business(`Chưa cấu hình kết nối ${provider}`, 3503);
  return c;
}

export const REQUIRED: Record<Provider, string[]> = {
  kiotviet: ['retailer', 'client_id', 'client_secret'],
  nhanh: ['app_id', 'business_id'],
  pancake: ['shop_id', 'api_key'],
};

export async function searchProducts(c: IntegrationConfig, keyword: string): Promise<ExtProduct[]> {
  const p = c.provider as Provider;
  if (mock()) return [1, 2, 3].map((i) => ({ external_code: `${p.toUpperCase()}-${keyword || 'SP'}-${i}`, name: `${keyword || 'Sản phẩm'} ${i} (${p})`, on_hand: 10 * i, price: 100000 * i }));
  if (p === 'kiotviet') {
    const r = await http(`${KV_API}/products?name=${encodeURIComponent(keyword)}&includeInventory=true&pageSize=50`, { headers: await kvHeaders(c) });
    return (r.data ?? []).map((x: any) => ({ external_code: x.code, name: x.fullName ?? x.name, on_hand: (x.inventories ?? []).reduce((a: number, i: any) => a + Number(i.onHand ?? 0), 0), price: x.basePrice }));
  }
  if (p === 'nhanh') {
    const d = await nhanh(c, '/product/search', { name: keyword, icpp: 50 });
    return Object.values(d.products ?? {}).map((x: any) => ({ external_code: String(x.code ?? x.idNhanh), name: x.name, on_hand: Number(x.inventory?.available ?? 0), price: Number(x.price ?? 0) }));
  }
  const r = await http(pk(c, `/products?search=${encodeURIComponent(keyword)}&page_size=50`));
  return (r.data ?? []).flatMap((x: any) => (x.variations ?? [x]).map((v: any) => ({ external_code: v.display_id ?? v.id, name: `${x.name}${v.fields?.length ? ' - ' + v.fields.map((f: any) => f.value).join('/') : ''}`, on_hand: Number(v.remain_quantity ?? 0), price: Number(v.retail_price ?? 0) })));
}

export async function createOrder(c: IntegrationConfig, o: ExtOrder): Promise<{ external_code: string; raw?: unknown }> {
  const p = c.provider as Provider;
  if (mock()) return { external_code: `${p.toUpperCase()}-${o.code}` };
  if (p === 'kiotviet') {
    const x = cfg(c);
    const r = await http(`${KV_API}/orders`, {
      method: 'POST', headers: await kvHeaders(c),
      body: JSON.stringify({ branchId: Number(x.branch_id), description: `DropBuy ${o.code}`, orderDetails: o.items.map((i) => ({ productCode: i.external_code, quantity: i.quantity, price: i.price })), customer: { name: o.receiver_fullname, contactNumber: o.receiver_phone, address: o.receiver_address_line }, orderDelivery: { receiver: o.receiver_fullname, contactNumber: o.receiver_phone, address: o.receiver_address_line } }),
    });
    return { external_code: r.code, raw: r };
  }
  if (p === 'nhanh') {
    const d = await nhanh(c, '/order/add', { id: o.code, customerName: o.receiver_fullname, customerMobile: o.receiver_phone, customerAddress: o.receiver_address_line, moneyTransfer: 0, description: o.notes ?? '', productList: o.items.map((i) => ({ id: i.external_code, quantity: i.quantity, price: i.price })) });
    return { external_code: String(d.orderId ?? o.code), raw: d };
  }
  const r = await http(pk(c, '/orders'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bill_full_name: o.receiver_fullname, bill_phone_number: o.receiver_phone, shipping_address: { full_address: o.receiver_address_line, full_name: o.receiver_fullname, phone_number: o.receiver_phone }, items: o.items.map((i) => ({ variation_id: i.external_code, quantity: i.quantity, variation_info: { retail_price: i.price } })), cod: o.cod_amount, note: o.notes ?? `DropBuy ${o.code}` }) });
  return { external_code: String(r.data?.id ?? r.id), raw: r };
}

export async function orderDetail(c: IntegrationConfig, external_code: string) {
  const p = c.provider as Provider;
  if (mock()) return { external_code, status: 'Completed', provider: p };
  if (p === 'kiotviet') return http(`${KV_API}/orders/code/${encodeURIComponent(external_code)}`, { headers: await kvHeaders(c) });
  if (p === 'nhanh') return nhanh(c, '/order/index', { id: external_code });
  return http(pk(c, `/orders/${encodeURIComponent(external_code)}`));
}

export async function kvInvoice(c: IntegrationConfig, code: string) {
  if (mock()) return { code, status: 1, total: 0 };
  return http(`${KV_API}/invoices/code/${encodeURIComponent(code)}`, { headers: await kvHeaders(c) });
}

export async function kvWebhooks(c: IntegrationConfig, action: 'list' | 'register' | 'unregister', arg?: { event?: string; url?: string; id?: string }) {
  if (mock()) return action === 'list' ? [] : { ok: true };
  const h = await kvHeaders(c);
  if (action === 'list') return (await http(`${KV_API}/webhooks`, { headers: h })).data ?? [];
  if (action === 'register') return http(`${KV_API}/webhooks`, { method: 'POST', headers: h, body: JSON.stringify({ Webhook: { Type: arg!.event, Url: arg!.url, IsActive: true } }) });
  return http(`${KV_API}/webhooks/${arg!.id}`, { method: 'DELETE', headers: h });
}

export async function nhanhAccessToken(c: IntegrationConfig, access_code: string) {
  const x = cfg(c);
  if (mock()) return { accessToken: `mock-${access_code}`, expiredDateTime: new Date(Date.now() + 365 * 86400_000).toISOString(), businessId: x.business_id };
  const r = await http('https://open.nhanh.vn/api/oauth/access_token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ version: '2.0', appId: x.app_id, accessCode: access_code, secretKey: x.secret_key ?? '' }),
  });
  if (r?.code !== 1) throw E.business(`Nhanh.vn: ${JSON.stringify(r?.messages ?? r).slice(0, 200)}`, 3502);
  return r;
}
