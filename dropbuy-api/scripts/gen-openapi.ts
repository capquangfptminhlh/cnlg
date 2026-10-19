// Sinh contract/openapi.json từ các route đã cài + schema trích từ dropbuy.vn (contract/endpoints.json).
// Schema của contract là gợi ý (ghép tự động, xem contract/overrides.json); hành vi thật nằm trong src/modules.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { registry } from '../src/lib/router.js';

type Ep = { method: string; url: string; pathParams?: any; queryParams?: any; requestBody?: any; response?: any };
const contract = JSON.parse(readFileSync(new URL('../contract/endpoints.json', import.meta.url), 'utf8')) as Ep[];
await buildApp();

const norm = (u: string) => u.replace(/:[a-z_]+/g, '{}');
const strip = (s: any): any => {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(strip);
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'nullable' && v) continue;
    if (k === 'unknown') continue;
    out[k] = strip(v);
  }
  if (s.nullable && out.type) out.type = [out.type, 'null'];
  return out;
};
const tagOf = (p: string) => {
  const seg = p.replace('/bff/', '').split('/');
  return ['sa', 'tenant-owners', 'shop'].includes(seg[0]) && seg[1] && !seg[1].startsWith(':') ? `${seg[0]}/${seg[1]}` : seg[0];
};
const envelope = (data: any) => ({ type: 'object', properties: { success: { type: 'boolean' }, error_code: { type: 'number' }, message: { type: 'string' }, data: data ?? {} } });

const paths: Record<string, any> = {};
for (const r of registry) {
  const oaPath = r.path.replace(/:([a-z_]+)/g, '{$1}');
  const ep = contract.find((e) => e.method === r.method && e.url === norm(r.path));
  const params = [...r.path.matchAll(/:([a-z_]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' }, ...(m[1] === 'fx_hash' ? { description: 'fx_hash của website (tenant). Tenant gốc lấy từ DEFAULT_TENANT_FX_HASH' } : {}) }));
  if (ep?.queryParams?.properties) for (const [name, s] of Object.entries<any>(ep.queryParams.properties)) params.push({ name, in: 'query', required: false, schema: strip(s), ...(s.description ? { description: s.description } : {}) } as any);
  const op: any = {
    tags: [tagOf(r.path)],
    operationId: `${r.method.toLowerCase()}_${r.path.replace(/[/:{}-]+/g, '_').replace(/^_|_$/g, '')}`,
    parameters: params,
    security: [{ bearer: [] }],
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: ep?.response ? strip(ep.response) : envelope(null) } } }, '4XX': { description: 'Lỗi nghiệp vụ / quyền / dữ liệu vào', content: { 'application/json': { schema: envelope(null) } } } },
    ...(ep ? {} : { description: 'Route bổ sung (không có trong FE gốc)' }),
  };
  if (r.method !== 'GET' && r.method !== 'DELETE' || ep?.requestBody) op.requestBody = { required: false, content: { 'application/json': { schema: ep?.requestBody ? strip(ep.requestBody) : { type: 'object' } } } };
  (paths[oaPath] ??= {})[r.method.toLowerCase()] = op;
}

const doc = {
  openapi: '3.1.0',
  info: { title: 'DropBuy-compatible BFF API', version: '0.1.0', description: 'Backend clone tương thích bề mặt /bff/* của dropbuy.vn. Envelope: { success, error_code, message, data }. Xác thực: Bearer JWT từ POST /bff/auth/login.' },
  servers: [{ url: 'http://localhost:4000' }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  paths,
};
writeFileSync(new URL('../contract/openapi.json', import.meta.url), JSON.stringify(doc, null, 1));
console.log(`openapi.json: ${Object.keys(paths).length} path, ${registry.length} operation`);
process.exit(0);
