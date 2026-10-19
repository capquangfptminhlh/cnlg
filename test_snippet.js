const fs = require('fs');

const raw = fs.readFileSync('C:/Users/nskka/.gemini/antigravity/brain/c8b6add3-b58c-440f-a084-bf5ef0323cb7/scratch/rsc_raw.txt', 'utf8');
const unescaped = raw.replace(/\\"/g, '"');

// Search for JSON objects containing robot-mova
const idx = unescaped.indexOf('robot-mova');
if (idx !== -1) {
  console.log('Snippet around robot-mova:');
  console.log(unescaped.substring(Math.max(0, idx - 100), Math.min(unescaped.length, idx + 300)));
} else {
  console.log('robot-mova not found in unescaped');
}
