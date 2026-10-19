// Checks alignment against endpoints whose real request/response shape we observed or can infer with certainty.
import fs from 'node:fs';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const has = (s, k) => JSON.stringify(s || {}).includes(`"${k}"`);
const A = [
  ['POST /bff/carts/my-cart', 'response', 'cart_items'],
  ['POST /bff/products/{}/get-stock-by-sku', 'response', 'stock_infos'],
  ['POST /bff/register', 'requestBody', 'username'],
  ['GET /bff/register/verify-email/{}', 'pathParams', 'activation_code'],
  ['GET /bff/register/forgot-password', 'queryParams', 'email'],
  ['POST /bff/register/reset-password', 'requestBody', 'token'],
  ['POST /bff/variations/in-stock', 'requestBody', 'product_ids'],
  ['POST /bff/variations/get-price', 'response', 'fe_price_group'],
  ['POST /bff/product-comments/{}/list', 'requestBody', 'product_id'],
  ['POST /bff/my-address', 'requestBody', 'fullname'],
  ['GET /bff/profile/me', 'response', 'username'],
  ['PUT /bff/profile/change-password', 'requestBody', 'new_password'],
  ['GET /bff/balance/my-balance', 'response', 'balance'],
  ['POST /bff/shop/register', 'requestBody', 'shop_name'],
  ['GET /bff/sa/users/list', 'response', 'user_id'],
  ['POST /bff/orders/guest-submit', 'requestBody', 'receiver_phone'],
  ['POST /bff/user-bank-info', 'requestBody', 'acc_number'],
  ['POST /bff/complain-requests', 'requestBody', 'complain_type'],
];
let ok = 0;
for (const [k, part, key] of A) {
  const e = spec.find((x) => `${x.method} ${x.url}` === k);
  const good = e && has(e[part], key);
  if (good) ok++; else console.log('  MISS', k, part, key, e ? Object.keys(e[part]?.properties || {}).slice(0, 6).join(',') : 'not found');
}
console.log(`anchors ${ok}/${A.length}`);
