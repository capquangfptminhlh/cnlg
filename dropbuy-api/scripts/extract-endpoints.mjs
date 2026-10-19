// Extracts endpoint definitions from Orval-style generated client code.
// Usage: node extract.mjs <chunksDir> <out.json>
import fs from 'node:fs';
import path from 'node:path';

const [dir, outFile] = process.argv.slice(2);
const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
const eps = new Map();

// Each call looks like: NAME=(args)=>s({url:EXPR,method:"M",...},x)
const callRe = /()()\(\{url:((?:"[^"]*"(?:\.concat\([^)]*\))*)|`[^`]*`),method:"([A-Z]+)"((?:[^()]|\([^()]*\)){0,240}?)\}(?:,[\w$]+)?\)/g;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes('/bff/')) continue;
  for (const m of src.matchAll(callRe)) {
    const [, fn, args, urlExpr, method, rest] = m;
    let url;
    if (urlExpr.startsWith('`')) {
      url = urlExpr.slice(1, -1).replace(/\$\{([^}]+)\}/g, '{$1}');
    } else {
      const parts = [...urlExpr.matchAll(/"([^"]*)"|\.concat\(([^)]*)\)/g)];
      url = '';
      for (const p of parts) {
        if (p[1] !== undefined) url += p[1];
        else url += p[2].split(',').map((a) => (/^".*"$/.test(a.trim()) ? a.trim().slice(1, -1) : `{${a.trim()}}`)).join('');
      }
    }
    if (!url.includes('/bff/')) continue;
    const hasData = /\bdata:/.test(rest);
    const hasParams = /\bparams:/.test(rest);
    const multipart = /multipart|FormData/.test(rest);
    const key = `${method} ${url.replace(/\{[^}]+\}/g, '{}')}`;
    if (!eps.has(key)) eps.set(key, { method, url, args, body: hasData, query: hasParams, multipart, file: path.basename(f) });
  }
}

const list = [...eps.values()].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
fs.writeFileSync(outFile, JSON.stringify(list, null, 1));
console.log('endpoints', list.length);
