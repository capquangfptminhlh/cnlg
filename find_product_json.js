const fs = require('fs');

const text = fs.readFileSync('C:/Users/nskka/.gemini/antigravity/scratch/hoangminh-dropbuy-relay/sample_product_rsc.txt', 'utf8');

// Look for product object keys: "product_id":141008 or "id":141008
const idx = text.indexOf('"id":141008');
console.log('Index of "id":141008:', idx);
if (idx !== -1) {
  // Find opening bracket before idx
  let start = text.lastIndexOf('{', idx);
  // Let's print 2000 chars from start
  console.log(text.substring(start, start + 3000));
}
