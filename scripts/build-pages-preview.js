'use strict';
/* Build a public-safe GitHub Pages artifact containing only storefront assets.
   NEVER copy admin panels, .env, /data, server, cookies or real product data. */
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const dst=path.join(root,'.pages-preview-dist');
const pub=path.join(root,'public');
const allowed=[
  'styles.css','marketplace.css','marketplace-v3.css','motion.css',
  'app.js','marketplace-home.js','favorites.js','motion.js'
];
fs.rmSync(dst,{recursive:true,force:true});
fs.mkdirSync(dst,{recursive:true});
for(const name of allowed)fs.copyFileSync(path.join(pub,name),path.join(dst,name));
fs.copyFileSync(path.join(root,'scripts','pages-preview.js'),path.join(dst,'pages-preview.js'));
fs.writeFileSync(path.join(dst,'.nojekyll'),'');
let html=fs.readFileSync(path.join(pub,'index.html'),'utf8');
for(const name of allowed){
  html=html.replaceAll('="/'+name+'"','="./'+name+'"');
}
html=html.replace(/<script src="\/socket\.io\/socket\.io\.js"><\/script>/,'');
html=html.replaceAll('href="/"','href="./"');
html=html.replace('<script src="./app.js"></script>',
  '<script src="./pages-preview.js"></script>\n  <script src="./app.js"></script>');
html=html.replace('</head>','  <meta name="robots" content="noindex, nofollow">\n  <link rel="stylesheet" href="./pages-preview.css">\n</head>');
html=html.replace('<body>','<body data-demo-mode="true">\n'+
  '  <div class="pages-demo-ribbon" role="status" aria-label="Website demo">\n'+
  '    <strong>CHẾ ĐỘ DEMO</strong><span>Dữ liệu mô phỏng · Không đặt hàng hoặc thanh toán thật</span>\n'+
  '  </div>');
html=html.replace('<title>','<title>[DEMO] ');
assert.ok(!html.includes('src="/socket.io/'),'Socket.IO must not connect from preview');
assert.ok(!html.includes('src="/app.js"')&&!html.includes('href="/styles.css"'));
assert.ok(html.indexOf('pages-preview.js')<html.indexOf('src="./app.js"'),'mock must load before storefront');
assert.ok(html.includes('data-demo-mode="true"'));
fs.writeFileSync(path.join(dst,'index.html'),html);

let app=fs.readFileSync(path.join(dst,'app.js'),'utf8');
// The production server owns /sp/ URLs, while GitHub Pages uses /cnlg/#/sp/...
app=app.replace(
  "if (location.pathname !== url) history.pushState({ productId: prod.id }, '', url);",
  "if (location.hash !== '#/sp/' + prod.id) history.pushState({ productId: prod.id }, '', '#/sp/' + prod.id);"
);
app=app.replace(
  "history.pushState(null, '', '/');",
  "history.pushState(null, '', location.pathname);"
);
fs.writeFileSync(path.join(dst,'app.js'),app);

const demoCss=String.raw`
.pages-demo-ribbon {
  position:relative;z-index:1001;width:100%;display:flex;justify-content:center;align-items:center;
  gap:12px;text-align:center;padding:8px 12px;background:#1e293b;color:#fff;font:600 12px/1.5 system-ui,sans-serif;
}
.pages-demo-ribbon strong {background:#fde68a;color:#713f12;padding:3px 8px;border-radius:4px;white-space:nowrap;}
.pages-demo-ribbon span {font-weight:500;}
body[data-demo-mode="true"] .market-banner-label::after {content:" • DEMO";color:#ffebb8;}
.demo-checkout-note {
  padding:12px 14px;background:#fff3df;color:#86471e;border-radius:8px;
  border:1px solid #ffd5a0;font-size:12px;line-height:1.6;font-weight:700;
}
body[data-demo-mode="true"] .btn-confirm-transfer {display:none;}
@media(max-width:700px){
 .pages-demo-ribbon {gap:5px;flex-wrap:wrap;font-size:10px;}
 .pages-demo-ribbon strong {font-size:10px;}
}
`;
fs.writeFileSync(path.join(dst,'pages-preview.css'),demoCss);
const expected=['index.html','pages-preview.js','pages-preview.css','.nojekyll',...allowed];
assert.deepEqual(fs.readdirSync(dst).sort(),expected.sort(),'unexpected site contents');
const publicSite=fs.readFileSync(path.join(dst,'index.html'),'utf8');
for(const banned of ['ADMIN_PASSWORD','SEPAY_WEBHOOK_KEY','data/config.json','data/orders.json']){
  assert.ok(!publicSite.includes(banned),'sensitive reference: '+banned);
}
console.log('GitHub Pages demo prepared:',expected.filter(x=>x!=='.nojekyll').join(', '));
