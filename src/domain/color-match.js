// Shared colour lookup used by the canvas view, the 3D viewer and the IFC
// writer so the three renderers always resolve the SAME colour for a given
// value. Only the lookup/ordering lives here; each caller keeps its own
// fallback formatting (CSS hsla, three rgb, IFC 0..1 float).

export function orderColorFiles(colorFiles, logColumn) {
  if (!logColumn) return colorFiles;
  return [
    ...colorFiles.filter((cf) => cf.columns.includes(logColumn)),
    ...colorFiles.filter((cf) => cf.columns.length === 0)
  ];
}

// Returns the matching colour entry ({ r, g, b, css }) or null.
// Tries an exact key match first, then a substring match (both directions)
// for values longer than two characters.
export function findColorEntry(value, logColumn, colorFiles) {
  if (!value || !colorFiles?.length) return null;

  for (const cf of orderColorFiles(colorFiles, logColumn)) {
    const direct = cf.colorMap.get(value);
    if (direct) return direct;

    if (value.length > 2) {
      for (const [key, color] of cf.colorMap) {
        if (key.includes(value) || value.includes(key)) return color;
      }
    }
  }

  return null;
}
