const fs = require('fs');

const filePath = process.argv[2];
if (!filePath) {
  throw new Error('Usage: node inspect_evolution_runtime.js <file>');
}

const source = fs.readFileSync(filePath, 'utf8');
const needles = [
  'status@broadcast',
  'allContacts',
  'remoteJid:{not:{endsWith:"@g.us"}}',
  'remoteJid:{endsWith:"@s.whatsapp.net"}',
  'Contacts not found',
  'StatusJidList is required',
];

for (const needle of needles) {
  let from = 0;
  let hits = 0;
  while (true) {
    const index = source.indexOf(needle, from);
    if (index < 0) {
      if (!hits) {
        console.log(`NEEDLE ${needle} INDEX -1`);
      }
      break;
    }
    hits += 1;
    console.log(`NEEDLE ${needle} INDEX ${index}`);
    console.log(source.slice(Math.max(0, index - 400), index + 1200));
    console.log('\n---\n');
    from = index + needle.length;
  }
}
