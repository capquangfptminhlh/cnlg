// Compact view of an op's schemas: node scripts/show-op.mjs <opIndex...>
// or by endpoint:                    node scripts/show-op.mjs "POST /bff/carts/my-cart"
import fs from 'node:fs';
const ops = JSON.parse(fs.readFileSync(new URL('../contract/ops.json', import.meta.url)));
const eps = JSON.parse(fs.readFileSync(new URL('../contract/endpoints.json', import.meta.url)));
function show(s, ind = '') {
  if (!s) return '';
  if (s.type === 'object') {
    return Object.entries(s.properties || {}).map(([k, v]) => {
      const req = (s.required || []).includes(k) ? '*' : '';
      const d = v.description ? `  // ${v.description.slice(0, 70)}` : '';
      if (v.type === 'object') return `${ind}${k}${req}: {${d}\n${show(v, ind + '  ')}\n${ind}}`;
      if (v.type === 'array' && v.items?.type === 'object') return `${ind}${k}${req}: [{${d}\n${show(v.items, ind + '  ')}\n${ind}}]`;
      const t = v.type === 'array' ? `${v.items?.type}[]` : v.enum ? `enum(${v.enum.join('|')})` : v.type ?? 'any';
      return `${ind}${k}${req}: ${t}${v.format ? ' ' + v.format : ''}${v.nullable ? '?' : ''}${d}`;
    }).join('\n');
  }
  if (s.type === 'array') return `${ind}[\n${show(s.items, ind + '  ')}\n${ind}]`;
  return ind + JSON.stringify(s);
}
for (const a of process.argv.slice(2)) {
  let idx = Number(a);
  if (Number.isNaN(idx)) { const e = eps.find((x) => `${x.method} ${x.url.replace(/\{\}/g, '{}')}` === a); idx = e?.opIndex; console.log(`# ${a} -> op ${idx}`); }
  const op = ops[idx];
  if (!op) { console.log('not found'); continue; }
  op.pre.forEach((p, i) => console.log(`-- pre[${i}]\n${show(p, '  ')}`));
  const data = op.response.properties?.data;
  console.log(`-- response.data\n${data ? show(data, '  ') : show(op.response, '  ')}\n`);
}
