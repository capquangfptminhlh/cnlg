const fs = require('fs');

const raw = fs.readFileSync('C:/Users/nskka/.gemini/antigravity/brain/c8b6add3-b58c-440f-a084-bf5ef0323cb7/scratch/rsc_raw.txt', 'utf8');

// Unescape raw text if it has \"
const unescaped = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

// Find all product objects or product patterns
const productRegex = /\{"id":(\d+),"name":"([^"]+)",(?:.*?)?"regular_price":(\d+)/g;
let match;
let count = 0;
while ((match = productRegex.exec(unescaped)) !== null) {
  count++;
  if (count <= 5) {
    console.log(`Product ${count}: ID=${match[1]}, Name=${match[2]}, Price=${match[3]}`);
  }
}
console.log('Total products found by regex:', count);

// Also search for other keys like title, slug, price, banner
const slugMatches = unescaped.match(/"product_slug":"[^"]+"/g);
console.log('Product slug matches:', slugMatches ? slugMatches.length : 0);
if (slugMatches) {
  console.log('Sample slugs:', slugMatches.slice(0, 5));
}
