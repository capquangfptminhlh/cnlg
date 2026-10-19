const fs = require('fs');

const text = fs.readFileSync('C:/Users/nskka/.gemini/antigravity/scratch/hoangminh-dropbuy-relay/sample_product_rsc.txt', 'utf8');

const idx = text.indexOf('1792227958219');
console.log('Found 1792227958219 at index:', idx);
if (idx !== -1) {
  console.log(text.substring(Math.max(0, idx - 200), Math.min(text.length, idx + 500)));
} else {
  // Search for 141008
  console.log('Search 141008:');
  const matches = [];
  let p = 0;
  while ((p = text.indexOf('141008', p)) !== -1) {
    matches.push(p);
    p += 6;
  }
  console.log('Occurrences of 141008:', matches.length);
  if (matches.length > 0) {
    console.log(text.substring(matches[0] - 100, matches[0] + 300));
  }
}
