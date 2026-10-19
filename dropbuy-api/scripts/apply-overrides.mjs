// Gộp endpoints.aligned.json + overrides.json → contract/endpoints.json (nguồn sự thật cho docs/coverage).
import fs from 'node:fs';
const dir = new URL('../contract/', import.meta.url);
const ops = JSON.parse(fs.readFileSync(new URL('ops.json', dir)));
const eps = JSON.parse(fs.readFileSync(new URL('endpoints.aligned.json', dir)));
const ov = JSON.parse(fs.readFileSync(new URL('overrides.json', dir)));
let n = 0;
const out = eps.map((e) => {
  const key = `${e.method} ${e.url}`;
  const idx = ov[key] ?? e.opIndex;
  if (ov[key] !== undefined) n++;
  const pre = [...(ops[idx]?.pre ?? [])];
  const r = { method: e.method, url: e.url, nParams: e.nParams, opIndex: idx };
  if (e.nParams) r.pathParams = pre.shift();
  if (e.query) r.queryParams = pre.shift();
  if (e.body) r.requestBody = pre.shift();
  r.response = ops[idx]?.response;
  return r;
});
fs.writeFileSync(new URL('endpoints.json', dir), JSON.stringify(out, null, 1));
console.log(`endpoints.json: ${out.length} endpoint, ${n} override`);
