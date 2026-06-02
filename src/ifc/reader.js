/**
 * IFC 4.3 STEP reader — extracts borehole data from an IFC STEP file.
 * Supports: IFCBOREHOLE, IFCGEOTECHNICALSTRATUM, IFCPOLYLINE, IFCCARTESIANPOINT,
 *           IFCPROPERTYSINGLEVALUE, IFCPROPERTYSET, IFCRELDEFINESBYPROPERTIES
 */

// ─── STEP Tokenizer ──────────────────────────────────────────────────────────

function* parseEntities(text) {
  // Extract the DATA section
  const dataMatch = text.match(/DATA;\r?\n([\s\S]*?)\r?\nENDSEC/i);
  if (!dataMatch) return;

  // Join continuation lines (lines that are part of multi-line entities)
  const data = dataMatch[1].replace(/\r?\n\s*/g, ' ');

  // Match each entity: #id=TYPE(params);
  const re = /#(\d+)\s*=\s*(\w+)\s*\(([^;]*)\)\s*;/g;
  let m;
  while ((m = re.exec(data)) !== null) {
    yield { id: parseInt(m[1]), type: m[2].toUpperCase(), rawParams: m[3].trim() };
  }
}

function splitParams(raw) {
  // Split top-level comma-separated params, respecting nested parens and strings
  const parts = [];
  let depth = 0, inStr = false, cur = '';

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && raw[i - 1] !== '\\') { inStr = !inStr; cur += ch; continue; }
    if (inStr) { cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseString(v) {
  const m = v?.match(/^'(.*)'$/s);
  return m ? m[1].replace(/''/g, "'") : '';
}

function parseRef(v) {
  const m = v?.trim().match(/^#(\d+)$/);
  return m ? parseInt(m[1]) : null;
}

function parseRefs(v) {
  return (v?.match(/#(\d+)/g) ?? []).map((r) => parseInt(r.slice(1)));
}

function parseNumber(v) {
  const n = parseFloat(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseCoordList(raw) {
  // Parses ((x,y,z)) or (x,y,z)
  const inner = raw.replace(/^\(+/, '').replace(/\)+$/, '');
  return inner.split(',').map(parseNumber).filter((v) => v !== null);
}

// ─── Main parser ─────────────────────────────────────────────────────────────

export function importFromIfc(text) {
  const entities = new Map();

  for (const entity of parseEntities(text)) {
    const p = splitParams(entity.rawParams);
    entities.set(entity.id, { ...entity, p });
  }

  // Index by type
  const byType = new Map();
  for (const [id, ent] of entities) {
    const list = byType.get(ent.type) ?? [];
    list.push(id);
    byType.set(ent.type, list);
  }

  // --- CartesianPoints ---
  const points3d = new Map(); // id → [x, y, z]
  for (const id of byType.get('IFCCARTESIANPOINT') ?? []) {
    const { p } = entities.get(id);
    const coords = parseCoordList(p[0] ?? '');
    if (coords.length >= 2) points3d.set(id, coords);
  }

  // --- Polylines ---
  const polylines = new Map(); // id → [[x,y,z], ...]
  for (const id of byType.get('IFCPOLYLINE') ?? []) {
    const { p } = entities.get(id);
    const refs = parseRefs(p[0] ?? '');
    const pts  = refs.map((r) => points3d.get(r)).filter(Boolean);
    polylines.set(id, pts);
  }

  // --- ShapeRepresentations: find Axis/Curve3D reps ---
  const axisReps = new Map(); // id → polyline points
  for (const id of byType.get('IFCSHAPEREPRESENTATION') ?? []) {
    const { p } = entities.get(id);
    const ident = parseString(p[1]);
    if (ident !== 'Axis') continue;
    const items = parseRefs(p[3] ?? '');
    for (const ref of items) {
      if (polylines.has(ref)) axisReps.set(id, polylines.get(ref));
    }
  }

  // --- ProductDefinitionShapes → collect reps ---
  const shapeToRep = new Map(); // prodShapeId → axisPoints
  for (const id of byType.get('IFCPRODUCTDEFINITIONSHAPE') ?? []) {
    const { p } = entities.get(id);
    const repRefs = parseRefs(p[2] ?? '');
    for (const ref of repRefs) {
      if (axisReps.has(ref)) { shapeToRep.set(id, axisReps.get(ref)); break; }
    }
  }

  // --- LocalPlacement → 3D position of collar ---
  const placements = new Map(); // id → {x, y, z}
  for (const id of byType.get('IFCAXIS2PLACEMENT3D') ?? []) {
    const { p } = entities.get(id);
    const ptRef = parseRef(p[0]);
    if (ptRef != null && points3d.has(ptRef)) {
      placements.set(id, points3d.get(ptRef));
    }
  }

  const localPlacements = new Map(); // id → [x,y,z]
  for (const id of byType.get('IFCLOCALPLACEMENT') ?? []) {
    const { p } = entities.get(id);
    const axRef = parseRef(p[1]);
    if (axRef != null && placements.has(axRef)) {
      localPlacements.set(id, placements.get(axRef));
    }
  }

  // --- Property sets ---
  const propValues = new Map(); // id → {name, value}
  for (const id of byType.get('IFCPROPERTYSINGLEVALUE') ?? []) {
    const { p } = entities.get(id);
    const name  = parseString(p[0]);
    let value   = p[2] ?? '';
    // Extract value from measure wrapper, e.g. IFCLENGTHMEASURE(57.49)
    const measM = value.match(/\w+\(([^)]+)\)/);
    const raw   = measM ? measM[1] : value;
    const num   = parseFloat(raw);
    propValues.set(id, { name, value: Number.isFinite(num) ? num : parseString(raw) });
  }

  const psets = new Map(); // setId → Map<name, value>
  for (const id of byType.get('IFCPROPERTYSET') ?? []) {
    const { p } = entities.get(id);
    const propRefs = parseRefs(p[4] ?? '');
    const props = new Map();
    for (const ref of propRefs) {
      const pv = propValues.get(ref);
      if (pv) props.set(pv.name, pv.value);
    }
    psets.set(id, props);
  }

  // IFCRELDEFINESBYPROPERTIES: elementIds → psetId
  const elemProps = new Map(); // elementId → Map<name,value>
  for (const id of byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
    const { p } = entities.get(id);
    const elems  = parseRefs(p[4] ?? '');
    const psetRef = parseRef(p[5]);
    if (!psets.has(psetRef)) continue;
    const props = psets.get(psetRef);
    for (const eid of elems) {
      const existing = elemProps.get(eid) ?? new Map();
      for (const [k, v] of props) existing.set(k, v);
      elemProps.set(eid, existing);
    }
  }

  // --- Extract IFCBOREHOLE ---
  const collarRows = [];
  const surveyRows = [];

  for (const bhId of byType.get('IFCBOREHOLE') ?? []) {
    const { p } = entities.get(bhId);
    const name  = parseString(p[2]) || `BH_${bhId}`;
    const placRef = parseRef(p[5]);
    const shapeRef = parseRef(p[6]);
    const props = elemProps.get(bhId) ?? new Map();

    // Collar position from local placement
    const collarXYZ = (placRef != null && localPlacements.has(placRef))
      ? localPlacements.get(placRef)
      : null;

    // Trajectory from shape representation
    const trajectory = shapeRef != null ? shapeToRep.get(shapeRef) : null;

    const x     = collarXYZ?.[0] ?? (trajectory?.[0]?.[0] ?? 0);
    const y     = collarXYZ?.[1] ?? (trajectory?.[0]?.[1] ?? 0);
    const z     = collarXYZ?.[2] ?? (trajectory?.[0]?.[2] ?? 0);
    const depth = props.get('TotalDepth') ?? (trajectory
      ? estimateDepth(trajectory)
      : 0);

    collarRows.push({
      BHID:  name,
      x:     String(x),
      y:     String(y),
      z:     String(z),
      depth: String(depth),
      class: parseString(p[3]) || ''
    });

    // Survey: derive from trajectory points
    if (trajectory && trajectory.length > 1) {
      let md = 0;
      for (let i = 0; i < trajectory.length; i++) {
        const pt = trajectory[i];
        if (i > 0) {
          const prev = trajectory[i - 1];
          md += Math.hypot(pt[0] - prev[0], pt[1] - prev[1], (pt[2] ?? 0) - (prev[2] ?? 0));
        }
        const { dip, az } = pointToDipAz(trajectory, i);
        surveyRows.push({ BHID: name, at: String(md.toFixed(4)), dip: String(dip), az: String(az) });
      }
    } else {
      surveyRows.push({ BHID: name, at: '0', dip: '90', az: '0' });
    }
  }

  // --- Extract IFCGEOTECHNICALSTRATUM ---
  const intervalRows = [];
  for (const stratId of byType.get('IFCGEOTECHNICALSTRATUM') ?? []) {
    const { p } = entities.get(stratId);
    const bhid  = findParentBoreholeId(stratId, entities, byType);
    const props = elemProps.get(stratId) ?? new Map();
    intervalRows.push({
      'Location ID': bhid,
      'Depth Top':   String(props.get('DepthFrom') ?? ''),
      'Depth Base':  String(props.get('DepthTo')   ?? ''),
      'Geol_SubUnit_VASYD': String(props.get('SubUnit') ?? ''),
      'Geol_Units_VASYD':   String(props.get('Unit')    ?? ''),
      'Geology Code':       String(props.get('GeologyCode')  ?? parseString(p[7] ?? '$')),
      Description:          String(props.get('Description') ?? parseString(p[3] ?? '$'))
    });
  }

  return {
    collarRows,
    surveyRows,
    intervalRows,
    boreholeCount: collarRows.length,
    intervalCount: intervalRows.length
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function estimateDepth(trajectory) {
  if (!trajectory.length) return 0;
  const first = trajectory[0];
  const last  = trajectory[trajectory.length - 1];
  return Math.hypot(
    last[0] - first[0], last[1] - first[1], (last[2] ?? 0) - (first[2] ?? 0)
  );
}

function pointToDipAz(traj, i) {
  const a = traj[Math.max(0, i - 1)];
  const b = traj[Math.min(traj.length - 1, i + 1)];
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = (b[2] ?? 0) - (a[2] ?? 0);
  const horiz = Math.hypot(dx, dy);
  const total = Math.hypot(dx, dy, dz);
  if (total === 0) return { dip: 90, az: 0 };
  const dip = Math.round(Math.asin(Math.abs(dz) / total) * (180 / Math.PI));
  const az  = ((Math.atan2(dx, dy) * (180 / Math.PI)) + 360) % 360;
  return { dip, az: Math.round(az) };
}

function findParentBoreholeId(stratId, entities, byType) {
  // Look through IFCRELCONTAINEDINSPATIALSTRUCTURE or check placements
  for (const relId of byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
    const { p } = entities.get(relId);
    // Not directly useful; try other approach
  }
  // Fallback: return empty (stratigraphic assignment is complex in STEP)
  return '';
}
