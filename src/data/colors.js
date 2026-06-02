export function parseLfcColors(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const map = new Map();
  for (const entry of doc.querySelectorAll('Entry')) {
    const code = entry.querySelector('Code')?.textContent?.trim();
    const raw = entry.querySelector('Colour')?.textContent?.trim();
    if (!code || !raw) continue;
    const parts = raw.split(/\s+/).map(Number);
    if (parts.length < 3 || parts.some(isNaN)) continue;
    const r = Math.round(parts[0] * 255);
    const g = Math.round(parts[1] * 255);
    const b = Math.round(parts[2] * 255);
    map.set(code, { r, g, b, css: `rgb(${r},${g},${b})` });
  }
  return map;
}

export function serializeColorMap(map) {
  return [...map.entries()].map(([code, c]) => ({ code, r: c.r, g: c.g, b: c.b }));
}

export function deserializeColorMap(rows) {
  const map = new Map();
  for (const row of (rows ?? [])) {
    map.set(row.code, { r: row.r, g: row.g, b: row.b, css: `rgb(${row.r},${row.g},${row.b})` });
  }
  return map;
}
