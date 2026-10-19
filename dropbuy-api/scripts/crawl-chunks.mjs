// Polite crawler: collects Next.js chunk files reachable from public page routes.
// Usage: node crawl.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const BASE = 'https://dropbuy.vn';
const UA = { 'user-agent': 'Mozilla/5.0 (research crawler)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(out, 'chunks'), { recursive: true });

const chunks = new Set();
const routes = new Set(['/']);
const seenRoutes = new Set();
const downloaded = new Set();

const routeRe = /["'`](\/(?:tai-khoan|gian-hang|quan-ly|admin|sa|shop|tenant|dashboard|kho|don-hang|vi|thanh-toan|gio-hang|dang-nhap|dang-ky|quen-mat-khau|flash-sale|affiliate|ctv|doi-tac|tra-cuu|verify-email|dat-hang-thanh-cong|cua-hang|nap-tien|rut-tien|khieu-nai|gioi-thieu)[a-z0-9\-\/]*)["'`]/g;
const chunkRe = /\/_next\/static\/chunks\/[A-Za-z0-9_\-\/()%\[\].]+?\.js/g;

async function get(url) {
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  return { status: r.status, url: r.url, text: await r.text() };
}

async function harvestChunk(c) {
  if (downloaded.has(c)) return;
  downloaded.add(c);
  const { text } = await get(BASE + c);
  const file = path.join(out, 'chunks', decodeURIComponent(c).replace(/[\/()\[\]%]/g, '_'));
  fs.writeFileSync(file, text);
  for (const m of text.matchAll(routeRe)) routes.add(m[1].replace(/\/$/, '') || '/');
  for (const m of text.matchAll(chunkRe)) chunks.add(m[0]);
  await sleep(80);
}

for (let round = 0; round < 6; round++) {
  for (const r of [...routes]) {
    if (seenRoutes.has(r) || seenRoutes.size > 120) continue;
    seenRoutes.add(r);
    try {
      const { text } = await get(BASE + r);
      for (const m of text.matchAll(chunkRe)) chunks.add(m[0]);
    } catch (e) { console.error('route fail', r, e.message); }
    await sleep(200);
  }
  for (const c of [...chunks]) {
    try { await harvestChunk(c); } catch (e) { console.error('chunk fail', c, e.message); }
  }
}

fs.writeFileSync(path.join(out, 'routes.json'), JSON.stringify([...seenRoutes].sort(), null, 1));
fs.writeFileSync(path.join(out, 'chunks.json'), JSON.stringify([...downloaded].sort(), null, 1));
console.log('routes', seenRoutes.size, 'chunks', downloaded.size);
