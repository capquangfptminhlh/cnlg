const fs = require('fs');

const file = 'C:/Users/nskka/.gemini/antigravity/scratch/hoangminh-dropbuy-relay/data/products.json';
let text = fs.readFileSync(file, 'utf8');

// Replace all _512x512 with _256x256
text = text.replaceAll('_512x512', '_256x256');

fs.writeFileSync(file, text, 'utf8');

const prods = JSON.parse(text);
console.log('Fixed products count:', prods.length);
console.log('Sample image 0:', prods[0].image);
console.log('Sample image 1:', prods[1].image);
