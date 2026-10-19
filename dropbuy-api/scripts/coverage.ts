// Đối chiếu route đã cài đặt với contract (378 endpoint trích từ dropbuy.vn).
import { readFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { registry } from '../src/lib/router.js';

const contract = JSON.parse(readFileSync(new URL('../contract/endpoints.json', import.meta.url), 'utf8')) as { method: string; url: string }[];
await buildApp();
const norm = (u: string) => u.replace(/:[a-z_]+/g, '{}');
const have = new Set(registry.map((r) => `${r.method} ${norm(r.path)}`));
const missing = contract.filter((e) => !have.has(`${e.method} ${e.url}`));
const extra = registry.filter((r) => !contract.some((e) => e.method === r.method && e.url === norm(r.path)));
console.log(`contract: ${contract.length} | đã cài: ${contract.length - missing.length} | thiếu: ${missing.length} | route bổ sung ngoài contract: ${extra.length}`);
for (const m of missing) console.log('  THIẾU', m.method, m.url);
for (const x of extra) console.log('  THÊM ', x.method, x.path);
process.exit(missing.length ? 1 : 0);
