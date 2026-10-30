// Draws stand-in pictures for the date-night demo (photos/<place>-<n>.jpg): a dish and a room for each place still in
// the running, in flat colours. Real photos with credits in photos/credits.json can replace them under the same names.
// Run from the repository root: node examples/demo-date-night/make-illustrations.cjs (needs Playwright's Chromium).
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');
const data = JSON.parse(readFileSync(join(__dirname, 'places.json'), 'utf8'));
const W = 960, H = 640;
// One dish and the room for each place still in the running; the kind only picks a drawing, it is not the restaurant's menu.
const dishes = {
  hosokawa: [['#2b2b2b', '#8a3b2a', 'steak']], izakaya: [['#7a4a2a', '#c8743a', 'skewers']], delamer: [['#2b2b2b', '#e8d5b0', 'cod']],
  auberge: [['#f2efe8', '#b5652f', 'duck']], garcon: [['#efe6d2', '#d9b26a', 'cheese']], patanegra: [['#f3e9d6', '#c4612f', 'tapas']],
  salgorda: [['#f3e9d6', '#d98a3c', 'croquetas']], sagardi: [['#f2efe8', '#7b3b2a', 'steak']], afusion: [['#ffffff', '#f3e3c3', 'dimsum']],
  blauw: [['#efe7d6', '#5c8a3a', 'curry']],
};
const rooms = { hosokawa: ['#2d2522', '#f0b35a'], izakaya: ['#26302a', '#f4a259'], delamer: ['#22303b', '#e9d7a0'], auberge: ['#3b2a22', '#f6c56b'],
  garcon: ['#3a3330', '#e9c27a'], patanegra: ['#41312a', '#e7b05a'], salgorda: ['#2f2630', '#e8b86b'], sagardi: ['#3b2b1f', '#f29d38'],
  afusion: ['#4a1f1f', '#e8604a'], blauw: ['#1f2a3b', '#9cc3e8'] };
const dots = (n, cx, cy, r, color, size) => Array.from({ length: n }, (_, i) => { const a = i / n * Math.PI * 2 + i, d = r * (0.25 + (i * 37 % 70) / 100);
  return `<circle cx="${(cx + Math.cos(a) * d).toFixed(1)}" cy="${(cy + Math.sin(a) * d * 0.8).toFixed(1)}" r="${size}" fill="${color}"/>`; }).join('');
const dish = ([plate, food, kind], cuisine) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#6b4a33"/><rect width="${W}" height="${H}" fill="url(#g)"/>
  <defs><radialGradient id="g" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#a77a55" stop-opacity=".9"/><stop offset="1" stop-color="#3a2516" stop-opacity=".9"/></radialGradient>
  <radialGradient id="p" cx="45%" cy="40%" r="60%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${plate}"/></radialGradient></defs>
  <ellipse cx="480" cy="345" rx="300" ry="215" fill="#000" opacity=".25"/>
  <ellipse cx="480" cy="325" rx="290" ry="205" fill="url(#p)"/><ellipse cx="480" cy="325" rx="215" ry="150" fill="none" stroke="#000" stroke-opacity=".06" stroke-width="3"/>
  ${kind === 'skewers' ? [0, 1, 2].map(i => `<rect x="300" y="${255 + i * 50}" width="360" height="8" rx="4" fill="#d9c49a"/>${[0, 1, 2, 3, 4].map(j => `<rect x="${330 + j * 60}" y="${242 + i * 50}" width="46" height="34" rx="12" fill="${food}"/>`).join('')}`).join('')
    : kind === 'dimsum' ? [0, 1, 2, 3, 4].map(i => `<circle cx="${370 + (i % 3) * 110}" cy="${275 + Math.floor(i / 3) * 100}" r="48" fill="${food}" stroke="#e2cfa6" stroke-width="4"/><path d="M${345 + (i % 3) * 110},${270 + Math.floor(i / 3) * 100} q25,-30 50,0" stroke="#d8c39a" stroke-width="5" fill="none"/>`).join('')
    : kind === 'pho' || kind === 'curry' ? `<circle cx="480" cy="320" r="150" fill="${kind === 'pho' ? '#e3b77a' : '#7aa04a'}"/><circle cx="480" cy="320" r="150" fill="none" stroke="#fff" stroke-width="10"/>${dots(18, 480, 320, 120, kind === 'pho' ? '#8a5a35' : '#e8d9a8', 14)}${dots(12, 480, 320, 110, '#4f8a3a', 9)}`
    : kind === 'cheese' ? `<path d="M360,360 L480,250 L540,380 Z" fill="${food}"/><rect x="520" y="270" width="110" height="80" rx="10" fill="#efd79a"/><circle cx="410" cy="250" r="34" fill="#7c2f3c"/>${dots(10, 470, 330, 140, '#a24c3a', 8)}`
    : kind === 'croquetas' ? [0, 1, 2, 3, 4, 5].map(i => `<ellipse cx="${360 + (i % 3) * 120}" cy="${280 + Math.floor(i / 3) * 90}" rx="52" ry="30" fill="${food}"/>`).join('')
    : kind === 'tapas' ? `<circle cx="390" cy="300" r="80" fill="${food}"/><circle cx="580" cy="290" r="70" fill="#e7c06a"/><circle cx="480" cy="400" r="60" fill="#4f7a3a"/>${dots(14, 390, 300, 60, '#f2d7a0', 9)}${dots(10, 580, 290, 50, '#c25a2f', 8)}`
    : `<rect x="360" y="250" width="${kind === 'cod' ? 240 : 250}" height="130" rx="${kind === 'cod' ? 30 : 18}" fill="${food}"/><rect x="360" y="250" width="${kind === 'cod' ? 240 : 250}" height="38" rx="18" fill="#000" opacity=".12"/>${dots(9, 600, 360, 70, '#4f8a3a', 10)}${kind === 'steak' ? [0, 1, 2, 3, 4, 5, 6].map(i => `<rect x="${600 + i * 9}" y="${230 + (i % 3) * 22}" width="14" height="90" rx="5" fill="#e9b65a" transform="rotate(${-20 + i * 6} 640 300)"/>`).join('') : ''}`}
  <rect x="${W - 220}" y="${H - 54}" width="200" height="34" rx="17" fill="#000" opacity=".45"/><text x="${W - 120}" y="${H - 31}" fill="#fff" font-family="Inter, Arial" font-size="15" text-anchor="middle">Illustration, not a photo</text>
</svg>`;
const room = ([wall, light]) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${wall}"/>
  <defs><radialGradient id="l" cx="50%" cy="20%" r="65%"><stop offset="0" stop-color="${light}" stop-opacity=".55"/><stop offset="1" stop-color="${light}" stop-opacity="0"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#l)"/>
  <rect x="80" y="90" width="230" height="260" rx="8" fill="#1d2a38"/><rect x="80" y="90" width="230" height="260" rx="8" fill="none" stroke="#5b4636" stroke-width="12"/><line x1="195" y1="90" x2="195" y2="350" stroke="#5b4636" stroke-width="8"/>
  ${dots(8, 195, 220, 90, '#f3d38a', 4)}
  ${[260, 480, 700].map(x => `<line x1="${x}" y1="0" x2="${x}" y2="120" stroke="#111" stroke-width="3"/><path d="M${x - 40},120 q40,-50 80,0 z" fill="${light}"/><ellipse cx="${x}" cy="128" rx="46" ry="10" fill="${light}" opacity=".7"/>`).join('')}
  <rect x="0" y="470" width="${W}" height="${H - 470}" fill="#000" opacity=".25"/>
  ${[300, 560].map(x => `<rect x="${x - 110}" y="430" width="220" height="16" rx="6" fill="#7a5235"/><rect x="${x - 6}" y="446" width="12" height="110" fill="#4a3322"/>
    <rect x="${x - 40}" y="400" width="10" height="30" rx="4" fill="#f4ecd8"/><circle cx="${x - 35}" cy="396" r="6" fill="${light}"/><circle cx="${x + 30}" cy="420" r="16" fill="#f4ecd8"/>
    <rect x="${x - 170}" y="420" width="50" height="120" rx="10" fill="#5e3d2a"/><rect x="${x + 120}" y="420" width="50" height="120" rx="10" fill="#5e3d2a"/>`).join('')}
  <rect x="770" y="250" width="140" height="300" rx="10" fill="#000" opacity=".3"/>${[0, 1, 2, 3].map(i => `<rect x="785" y="${270 + i * 60}" width="110" height="10" rx="4" fill="#6b4a33"/>${dots(5, 840, 255 + i * 60, 40, '#8c2f3a', 7)}`).join('')}
  <rect x="${W - 220}" y="${H - 54}" width="200" height="34" rx="17" fill="#000" opacity=".45"/><text x="${W - 120}" y="${H - 31}" fill="#fff" font-family="Inter, Arial" font-size="15" text-anchor="middle">Illustration, not a photo</text>
</svg>`;
(async () => {
  mkdirSync(join(__dirname, 'photos'), { recursive: true });
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: W, height: H } });
  const shoot = async (svg, name) => { await page.setContent(`<body style="margin:0">${svg}</body>`); writeFileSync(join(__dirname, 'photos', name), await page.screenshot({ type: 'jpeg', quality: 78, clip: { x: 0, y: 0, width: W, height: H } })); };
  for (const [id, list] of Object.entries(dishes)) {
    let n = 1;
    for (const item of list) await shoot(dish(item), `${id}-${n++}.jpg`);
    await shoot(room(rooms[id]), `${id}-${n}.jpg`);
  }
  await browser.close();
})();
