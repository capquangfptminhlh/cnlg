// Tóm tắt nhanh field theo nhóm endpoint: node scripts/keys.mjs <prefix...>
import fs from 'node:fs';
const ops = JSON.parse(fs.readFileSync(new URL('../contract/ops.json', import.meta.url)));
const eps = JSON.parse(fs.readFileSync(new URL('../contract/endpoints.json', import.meta.url)));
const k = (s) => (s ? Object.keys(s.properties || {}).map((x) => ((s.required || []).includes(x) ? x + '*' : x)).join(',') : '');
const d = (r) => { const x = r?.properties?.data; if (!x) return '-'; if (x.type === 'array') return '[' + k(x.items) + ']'; const it = x.properties?.items; return it ? `page{${k(it.items)}}` : k(x); };
for (const e of eps) {
  if (!process.argv.slice(2).some((p) => e.url.startsWith('/bff/' + p))) continue;
  const op = ops[e.opIndex];
  console.log(`${e.method} ${e.url}  #${e.opIndex}\n   in: ${op.pre.map(k).join(' | ')}\n   out: ${d(op.response)}`);
}
