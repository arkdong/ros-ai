// Draws the date-night demo's map (map.png) from places.json: a simplified Amsterdam with every restaurant as a pin at its (approximate) address.
// Run from the repository root: node examples/demo-date-night/make-map.cjs (needs Playwright's Chromium).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');
const data = JSON.parse(readFileSync(join(__dirname, 'places.json'), 'utf8'));
const W = 1600, H = 1000, MAP = 1060, lon0 = 4.850, lon1 = 4.935, lat0 = 52.344, lat1 = 52.394;
const x = lon => (lon - lon0) / (lon1 - lon0) * MAP, y = lat => (lat1 - lat) / (lat1 - lat0) * H;
const pt = ([lon, lat]) => `${x(lon).toFixed(1)},${y(lat).toFixed(1)}`;
const poly = points => points.map(pt).join(' ');
const booked = place => Boolean(place.aside);
// The canal ring as arcs around Centraal (screen angles: 180° west, 90° south, 0° east).
const cx = x(4.9003), cy = y(52.3791);
const arc = (rx, ry, from, to) => { const p = a => [cx + rx * Math.cos(a * Math.PI / 180), cy + ry * Math.sin(a * Math.PI / 180)];
  const [a, b] = [p(from), p(to)]; return `M${a[0].toFixed(1)},${a[1].toFixed(1)} A${rx},${ry} 0 0 0 ${b[0].toFixed(1)},${b[1].toFixed(1)}`; };
const ring = [[95, 150], [140, 225], [185, 300], [228, 372], [330, 520]].map(([rx, ry], i) => `<path d="${arc(rx, ry, 195, 345)}" fill="none" stroke="#b9d6ea" stroke-width="${i === 4 ? 9 : 6}" stroke-linecap="round"/>`).join('');
const pins = data.places.map((place, index) => {
  const c = data.cuisines[place.cuisine].color, px = x(place.lon), py = y(place.lat), out = booked(place);
  // A pin with another just to its right carries its name above, so the two labels do not overlap.
  const above = data.places.some(other => other !== place && x(other.lon) > px && x(other.lon) - px < 120 && Math.abs(y(other.lat) - py) < 30);
  return `<g transform="translate(${px.toFixed(1)},${py.toFixed(1)})">
    <circle r="19" fill="${out ? '#ffffff' : c}" stroke="${c}" stroke-width="4"/>
    <text text-anchor="middle" dy="6" font-size="17" font-weight="700" fill="${out ? c : '#fff'}">${index + 1}</text>
    <text x="${above ? 0 : px > MAP - 220 ? -26 : 26}" text-anchor="${above ? 'middle' : px > MAP - 220 ? 'end' : 'start'}" dy="${above ? -28 : 6}" font-size="17" font-weight="600" fill="${out ? '#9a9a9a' : '#1d1d1d'}" stroke="#f6f4ee" stroke-width="5" paint-order="stroke">${place.name}</text></g>`;
}).join('');
const areas = [['Jordaan', 4.878, 52.3745], ['Centrum', 4.894, 52.3745], ['Oud-West', 4.866, 52.3665], ['Oud-Zuid', 4.866, 52.3495], ['De Pijp', 4.9045, 52.3535],
  ['Plantage', 4.913, 52.3705], ['Oost', 4.926, 52.3565]].map(([name, lon, lat]) =>
  `<text x="${x(lon)}" y="${y(lat)}" font-size="15" letter-spacing="2" fill="#a8a294" text-anchor="middle">${name.toUpperCase()}</text>`).join('');
const legend = data.places.map((place, index) => {
  const c = data.cuisines[place.cuisine].color, out = booked(place), top = 150 + index * 64;
  return `<g transform="translate(${MAP + 46},${top})"><circle cx="16" cy="0" r="15" fill="${out ? '#fff' : c}" stroke="${c}" stroke-width="3"/>
    <text x="16" dy="5" text-anchor="middle" font-size="14" font-weight="700" fill="${out ? c : '#fff'}">${index + 1}</text>
    <text x="44" dy="-2" font-size="18" font-weight="600" fill="${out ? '#9a9a9a' : '#1d1d1d'}">${place.name}</text>
    <text x="44" dy="20" font-size="14" fill="#7a7a7a">${data.cuisines[place.cuisine].title} · ${place.address}${out ? ' · set aside' : ''}</text></g>`;
}).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Inter, -apple-system, Helvetica, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <clipPath id="m"><rect width="${MAP}" height="${H}"/></clipPath>
  <g clip-path="url(#m)">
    <rect width="${MAP}" height="${H}" fill="#f6f4ee"/>
    <polygon points="${poly([[4.8585, 52.3557], [4.8600, 52.3572], [4.8700, 52.3597], [4.8795, 52.3617], [4.8815, 52.3606], [4.8720, 52.3578], [4.8620, 52.3550]])}" fill="#dcebd2"/>
    <polygon points="${poly([[4.917, 52.3618], [4.9245, 52.3625], [4.9265, 52.3585], [4.9185, 52.3575]])}" fill="#dcebd2"/>
    <polygon points="${poly([[4.850, 52.394], [4.935, 52.394], [4.935, 52.3785], [4.921, 52.3795], [4.9065, 52.3815], [4.894, 52.3838], [4.882, 52.3875], [4.868, 52.3905], [4.850, 52.391]])}" fill="#b9d6ea"/>
    ${ring}
    <polyline points="${poly([[4.9075, 52.344], [4.9045, 52.352], [4.9025, 52.3585], [4.9008, 52.3655], [4.8975, 52.3705]])}" fill="none" stroke="#b9d6ea" stroke-width="16" stroke-linecap="round"/>
    ${areas}
    <g transform="translate(${cx},${cy + 8})"><rect x="-13" y="-13" width="26" height="26" rx="6" fill="#1d1d1d"/><text dy="5" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">C</text>
      <text x="20" dy="5" font-size="15" font-weight="600" fill="#1d1d1d" stroke="#b9d6ea" stroke-width="5" paint-order="stroke">Centraal</text></g>
    ${pins}
    <text x="20" y="${H - 20}" font-size="13" fill="#a8a294">Simplified map for this demo; pins at the restaurants' addresses, approximate</text>
  </g>
  <text x="${MAP + 46}" y="62" font-size="26" font-weight="700" fill="#1d1d1d">Dinner, Friday 6 November</text>
  <text x="${MAP + 46}" y="94" font-size="15" fill="#7a7a7a">${Object.values(data.cuisines).map(c => c.title).join(' · ')} · hollow pin = set aside</text>
  <g transform="translate(${MAP + 46},112)">${Object.values(data.cuisines).map((c, i) => `<rect x="${i * 118}" y="0" width="110" height="6" rx="3" fill="${c.color}"/>`).join('')}</g>
  ${legend}
</svg>`;
(async () => {
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  writeFileSync(join(__dirname, 'map.png'), await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } }));
  await browser.close();
})();
