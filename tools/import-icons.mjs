// Import real icons: Lucide UI icons + official brand SVGs (Gmail, Google Calendar),
// and regenerate the `const I={...}` block in index.html.
// The Google "G" is already the official brand SVG and is preserved as-is.
import { readFileSync, writeFileSync } from 'fs';

const LUCIDE = 'https://cdn.jsdelivr.net/npm/lucide-static@1.48.0/icons';
const WIKI = 'https://upload.wikimedia.org/wikipedia/commons';

// key: [source, name, size]  source = 'lucide' | 'brand'
const ICONS = {
  home:    ['lucide', 'home', 22],
  chat:    ['lucide', 'message-circle', 22],
  pin:     ['lucide', 'map-pin', 22],
  user:    ['lucide', 'user', 22],
  mic:     ['lucide', 'mic', 20],
  plus:    ['lucide', 'plus', 20],
  cal:     ['brand', 'a/a5/Google_Calendar_icon_%282020%29.svg', 18],
  msg:     ['lucide', 'message-square', 18],
  bell:    ['lucide', 'bell', 18],
  search:  ['lucide', 'search', 20],
  spark:   ['lucide', 'sparkles', 16],
  chev:    ['lucide', 'chevron-right', 16],
  chevL:   ['lucide', 'chevron-left', 18],
  check:   ['lucide', 'check', 18],
  pinS:    ['lucide', 'map-pin', 14],
  food:    ['lucide', 'utensils', 16],
  cup:     ['lucide', 'coffee', 16],
  spark22: ['lucide', 'sparkles', 22],
  user18:  ['lucide', 'user', 18],
  users:   ['lucide', 'users', 22],
  mail:    ['brand', '7/7e/Gmail_icon_%282020%29.svg', 18],
  note:    ['lucide', 'music', 18],
  car:     ['lucide', 'car', 18],
  fork18:  ['lucide', 'utensils-crossed', 18],
  doc:     ['lucide', 'file-text', 18],
  moon:    ['lucide', 'moon', 16],
  vol:     ['lucide', 'volume-2', 20],
  volx:    ['lucide', 'volume-x', 20],
};

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ring-icon-import/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

function normalize(svg, size, brand) {
  let s = svg.replace(/<\?xml[^?]*\?>\s*/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  // collapse ALL whitespace (incl. single newlines) for a compact single-line string
  s = s.replace(/\s+/g, ' ');
  if (brand) {
    s = s.replace('<svg', `<svg width="${size}" height="${size}" aria-hidden="true"`);
  } else {
    // Lucide: enforce size + currentColor stroke, round caps (already round upstream)
    s = s.replace(/width="[^"]*"/, `width="${size}"`).replace(/height="[^"]*"/, `height="${size}"`);
    if (!/aria-hidden/.test(s)) s = s.replace('<svg', '<svg aria-hidden="true"');
  }
  return s;
}

const entries = [];
for (const [key, [src, name, size]] of Object.entries(ICONS)) {
  const url = src === 'lucide' ? `${LUCIDE}/${name}.svg` : `${WIKI}/${name}`;
  const raw = await fetchText(url);
  if (!raw.includes('<svg')) throw new Error(`no svg in ${url}`);
  const svg = normalize(raw, size, src === 'brand');
  const esc = svg.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  entries.push(`  ${key}:'${esc}'`);
  console.log('ok', key, '<-', url, `(${svg.length} chars)`);
}

// Preserve the existing official Google G entry verbatim.
const html = readFileSync('index.html', 'utf8');
const m = html.match(/  google:'(?:[^'\\]|\\.)*',\n/);
if (!m) throw new Error('google entry not found');
const googleEntry = m[0];

const block = 'const I={\n' + entries.join(',\n') + ',\n' + googleEntry + '};';
const next = html.replace(/const I=\{[\s\S]*?\n\};/, block);
if (next === html) throw new Error('replacement failed');
writeFileSync('index.html', next);
console.log('index.html updated:', entries.length, 'imported + google preserved');
