/**
 * IFC 4.3 ADD2 (IFC4X3_ADD2) STEP Writer - Borehole Export
 *
 * Spatial structure:
 *   IfcProject
 *     IfcRelAggregates -> IfcSite
 *       IfcRelAggregates -> IfcFacility (one per borehole)
 *         IfcRelContainedInSpatialStructure -> borehole + intervals
 */

import { findColorEntry } from '../domain/color-match.js';

const _GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

function newGuid() {
  const hex = crypto.randomUUID().replace(/-/g, '');
  let n = BigInt('0x' + hex), g = '';
  for (let i = 0; i < 22; i++) {
    g = _GUID_CHARS[Number(n % 64n)] + g;
    n /= 64n;
  }
  return `'${g}'`;
}

function num(v) {
  if (!Number.isFinite(v)) return '0.';
  const s = v.toFixed(8).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
  return s;
}

function str(v) {
  if (v == null || v === '') return '$';
  const encoded = String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/[^\x20-\x7E]/g, (ch) => {
      const cp = ch.codePointAt(0);
      return '\\X2\\' + cp.toString(16).toUpperCase().padStart(4, '0') + '\\X0\\';
    });
  return `'${encoded}'`;
}

function ref(id) { return `#${id}`; }
function refList(ids) { return `(${ids.map(ref).join(',')})`; }

class StepWriter {
  constructor() {
    this._next = 1;
    this._lines = [];
  }

  add(type, params) {
    const id = this._next++;
    this._lines.push(`#${id}=${type}(${params});`);
    return id;
  }

  comment(text) {
    this._lines.push(`/* ${text} */`);
  }

  toStep(filename = 'boreholes.ifc') {
    const ts = new Date().toISOString().slice(0, 19);
    return [
      'ISO-10303-21;',
      'HEADER;',
      `FILE_DESCRIPTION(('IFC4X3_ADD2 Borehole Export','InfraCore GEO'),'2;1');`,
      `FILE_NAME(${str(filename)},${str(ts)},(''),(''),'','InfraCore GEO','');`,
      `FILE_SCHEMA(('IFC4X3_ADD2'));`,
      'ENDSEC;',
      'DATA;',
      ...this._lines,
      'ENDSEC;',
      'END-ISO-10303-21;'
    ].join('\n');
  }
}

function pt3(w, x, y, z) {
  return w.add('IFCCARTESIANPOINT', `(${num(x)},${num(y)},${num(z)})`);
}

function dir3(w, x, y, z) {
  return w.add('IFCDIRECTION', `(${num(x)},${num(y)},${num(z)})`);
}

function ax3(w, ptId, zId = null, xId = null) {
  return w.add('IFCAXIS2PLACEMENT3D',
    `${ref(ptId)},${zId ? ref(zId) : '$'},${xId ? ref(xId) : '$'}`);
}

function localPlace(w, ax3Id, parentId = null) {
  return w.add('IFCLOCALPLACEMENT',
    `${parentId ? ref(parentId) : '$'},${ref(ax3Id)}`);
}

function polyline3D(w, ptIds) {
  return w.add('IFCPOLYLINE', refList(ptIds));
}

function shapeRepr(w, ctxId, ident, type, itemIds) {
  return w.add('IFCSHAPEREPRESENTATION',
    `${ref(ctxId)},${str(ident)},${str(type)},${refList(itemIds)}`);
}

function prodShape(w, reprIds) {
  return w.add('IFCPRODUCTDEFINITIONSHAPE', `$,$,${refList(reprIds)}`);
}

function applySolidStyle(w, geomItemId, color) {
  const { r, g, b } = color;
  const colorId = w.add('IFCCOLOURRGB', `$,${num(r)},${num(g)},${num(b)}`);
  const renderingId = w.add('IFCSURFACESTYLERENDERING',
    `${ref(colorId)},$,$,$,$,$,$,.NOTDEFINED.`);
  const surfStyleId = w.add('IFCSURFACESTYLE', `$,.BOTH.,(${ref(renderingId)})`);
  w.add('IFCSTYLEDITEM', `${ref(geomItemId)},(${ref(surfStyleId)}),$`);
}

function applyCurveStyle(w, geomItemId, color, width = 0) {
  const { r, g, b } = color;
  const colorId = w.add('IFCCOLOURRGB', `$,${num(r)},${num(g)},${num(b)}`);
  const widthStr = width > 0 ? `IFCNONNEGATIVELENGTHMEASURE(${num(width)})` : '$';
  const styleId = w.add('IFCCURVESTYLE', `$,$,${widthStr},${ref(colorId)},.T.`);
  w.add('IFCSTYLEDITEM', `${ref(geomItemId)},(${ref(styleId)}),$`);
}

function resolveColor(value, colorColumn, colorFiles) {
  if (!value || value === '$' || value === '-') return null;

  const entry = findColorEntry(value, colorColumn, colorFiles);
  if (entry) return { r: entry.r / 255, g: entry.g / 255, b: entry.b / 255 };

  let h = 0;
  for (const ch of value) {
    h = (h << 5) - h + ch.charCodeAt(0);
    h |= 0;
  }
  return _hslToRgb(Math.abs(h) % 360, 0.52, 0.72);
}

function _hslToRgb(hDeg, s, l) {
  const h = hDeg / 360;
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    const tt = ((t % 1) + 1) % 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return { r: hue(h + 1 / 3), g: hue(h), b: hue(h - 1 / 3) };
}

function _interpAbs(points, targetMd) {
  if (!points.length) return { x: 0, y: 0, z: 0 };
  if (targetMd <= points[0].md) return points[0];
  const last = points[points.length - 1];
  if (targetMd >= last.md) return last;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (targetMd <= b.md) {
      const t = b.md === a.md ? 0 : (targetMd - a.md) / (b.md - a.md);
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t
      };
    }
  }
  return last;
}

function interpLocal(points, targetMd, collar) {
  const abs = _interpAbs(points, targetMd);
  return { x: abs.x - collar.x, y: abs.y - collar.y, z: abs.z - collar.z };
}

const _NUMERIC_TYPES = new Set([
  'IFCREAL', 'IFCINTEGER', 'IFCLENGTHMEASURE', 'IFCPOSITIVELENGTHMEASURE',
  'IFCAREAMEASURE', 'IFCVOLUMEMEASURE', 'IFCMASSMEASURE',
  'IFCPLANEANGLEMEASURE', 'IFCCOUNTMEASURE', 'IFCNORMALISEDRATIOMEASURE',
]);

function propSingleValue(w, name, value, type = 'IFCLABEL') {
  const t = type.toUpperCase();
  let encoded;
  if (_NUMERIC_TYPES.has(t)) {
    const v = Number.isFinite(Number(value)) ? Number(value) : 0;
    if (t === 'IFCINTEGER' || t === 'IFCCOUNTMEASURE') {
      encoded = `${t}(${Math.max(0, Math.round(v))})`;
    } else {
      const out = t === 'IFCPOSITIVELENGTHMEASURE' ? Math.max(1e-9, v) : v;
      encoded = `${t}(${num(out)})`;
    }
  } else {
    const s = String(value ?? '');
    encoded = s === '' ? '$' : `${t}(${str(s)})`;
  }
  return w.add('IFCPROPERTYSINGLEVALUE', `${str(name)},$,${encoded},$`);
}

function makePset(w, name, propIds) {
  return w.add('IFCPROPERTYSET', `${newGuid()},$,${str(name)},$,${refList(propIds)}`);
}

function relDefinesByProps(w, elemId, psetId) {
  w.add('IFCRELDEFINESBYPROPERTIES',
    `${newGuid()},$,$,$,(${ref(elemId)}),${ref(psetId)}`);
}

function inferMappedIfcType(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'IFCTEXT';
  return /^[-+]?\d+(?:[.,]\d+)?$/.test(text) ? 'IFCREAL' : 'IFCTEXT';
}

function addMappedPropertySets(w, elemId, propertySets = []) {
  for (const group of propertySets) {
    const psetName = String(group?.name ?? '').trim();
    const properties = (group?.properties ?? []).filter((prop) => String(prop?.name ?? '').trim());
    if (!psetName || !properties.length) continue;

    const propIds = properties.map((prop) =>
      propSingleValue(w, prop.name, prop.value ?? '', prop.type || inferMappedIfcType(prop.value))
    );
    relDefinesByProps(w, elemId, makePset(w, psetName, propIds));
  }
}

function buildGeomReprs(w, axisCtx, bodyCtx, ptIds, color, radius) {
  const reprIds = [];

  const polylineId = polyline3D(w, ptIds);
  applyCurveStyle(w, polylineId, color, 0);
  reprIds.push(shapeRepr(w, axisCtx, 'Axis', 'Curve3D', [polylineId]));

  if (radius > 0 && ptIds.length >= 2) {
    const solidId = w.add('IFCSWEPTDISKSOLID', `${ref(polylineId)},${num(radius)},$,$,$`);
    applySolidStyle(w, solidId, color);
    reprIds.push(shapeRepr(w, bodyCtx, 'Body', 'AdvancedSweptSolid', [solidId]));
  }

  return reprIds;
}

function createBoreholeElement(w, entityName, { name, description = '', placementId, shapeRef, tag }) {
  if (entityName === 'IFCBUILDINGELEMENTPROXY') {
    return w.add('IFCBUILDINGELEMENTPROXY',
      `${newGuid()},$,${str(name)},${str(description)},${str('Borehole')},${ref(placementId)},${shapeRef},${str(tag)},.USERDEFINED.`);
  }

  return w.add('IFCBOREHOLE',
    `${newGuid()},$,${str(name)},${str(description)},$,${ref(placementId)},${shapeRef},${str(tag)},$`);
}

function createIntervalElement(w, entityName, { name, description = '', placementId, shapeId, tag }) {
  if (entityName === 'IFCGEOGRAPHICELEMENT') {
    return w.add('IFCGEOGRAPHICELEMENT',
      `${newGuid()},$,${str(name)},${str(description)},${str('GeoSolidStratum')},${ref(placementId)},${ref(shapeId)},${str(tag)},.USERDEFINED.`);
  }

  if (entityName === 'IFCGEOTECHNICALSTRATUM') {
    return w.add('IFCGEOTECHNICALSTRATUM',
      `${newGuid()},$,${str(name)},${str(description)},${str('GeoSolidStratum')},${ref(placementId)},${ref(shapeId)},${str(tag)},.SOLID.`);
  }

  if (entityName === 'IFCSOLIDSTRATUM') {
    return w.add('IFCSOLIDSTRATUM',
      `${newGuid()},$,${str(name)},${str(description)},${str('GeoSolidStratum')},${ref(placementId)},${ref(shapeId)},${str(tag)},.SOLID.`);
  }

  return w.add('IFCBUILDINGELEMENTPROXY',
    `${newGuid()},$,${str(name)},${str(description)},${str('GeoSolidStratum')},${ref(placementId)},${ref(shapeId)},${str(tag)},.USERDEFINED.`);
}

function createFacilityElement(w, { name, description = '', placementId }) {
  return w.add('IFCFACILITY',
    `${newGuid()},$,${str(name)},${str(description)},${str('BoreholeFacility')},${ref(placementId)},$,$,.ELEMENT.,.NOTDEFINED.`);
}

export function exportToIfc(boreholes, geologyById = new Map(), options = {}) {
  const {
    includeIntervals = true,
    filename = 'boreholes.ifc',
    diameter = 0,
    colorColumn = '',
    colorFiles = [],
    boreholeGeometry = true,
    includeStratumPset = true,
    boreholeIfcClass = 'IFCBOREHOLE',
    intervalIfcClass = 'IFCBUILDINGELEMENTPROXY',
    boreholePropertySetsById = {},
    intervalAttributeMappings = [],
    projectName = 'InfraCore GEO Boreholes',
    siteName = 'Borehole Site',
    facilityPrefix = ''
  } = options;

  if (!boreholes.length) throw new Error('Keine Bohrungen zum Exportieren.');

  const radius = diameter / 2;
  const w = new StepWriter();

  const refX = boreholes.reduce((s, bh) => s + bh.collar.x, 0) / boreholes.length;
  const refY = boreholes.reduce((s, bh) => s + bh.collar.y, 0) / boreholes.length;
  const refZ = boreholes.reduce((s, bh) => s + bh.collar.z, 0) / boreholes.length;

  w.comment('=== UNITS ===');
  const uLen = w.add('IFCSIUNIT', '*,.LENGTHUNIT.,$,.METRE.');
  const uAng = w.add('IFCSIUNIT', '*,.PLANEANGLEUNIT.,$,.RADIAN.');
  const uTime = w.add('IFCSIUNIT', '*,.TIMEUNIT.,$,.SECOND.');
  const units = w.add('IFCUNITASSIGNMENT', refList([uLen, uAng, uTime]));

  w.comment('=== GEOMETRIC CONTEXT ===');
  const gcOrigin = pt3(w, 0, 0, 0);
  const gcAxisZ = dir3(w, 0, 0, 1);
  const gcAxisX = dir3(w, 1, 0, 0);
  const gcAx3 = ax3(w, gcOrigin, gcAxisZ, gcAxisX);
  const gcNorth = dir3(w, 0, 1, 0);
  const geomCtx = w.add('IFCGEOMETRICREPRESENTATIONCONTEXT',
    `$,${str('Model')},3,1.E-5,${ref(gcAx3)},${ref(gcNorth)}`);

  const bodyCtx = w.add('IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
    `${str('Body')},${str('Model')},*,*,*,*,${ref(geomCtx)},$,.MODEL_VIEW.,$`);
  const axisCtx = w.add('IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
    `${str('Axis')},${str('Model')},*,*,*,*,${ref(geomCtx)},$,.MODEL_VIEW.,$`);

  w.comment('=== PROJECT ===');
  const project = w.add('IFCPROJECT',
    `${newGuid()},$,${str(projectName)},$,$,$,$,(${ref(geomCtx)}),${ref(units)}`);

  w.comment('=== SITE ===');
  const sitePt = pt3(w, refX, refY, refZ);
  const siteAx = ax3(w, sitePt, null, null);
  const sitePl = localPlace(w, siteAx, null);
  const site = w.add('IFCSITE',
    `${newGuid()},$,${str(siteName)},$,$,${ref(sitePl)},$,$,.ELEMENT.,$,$,${num(refZ)},$,$`);

  w.add('IFCRELAGGREGATES',
    `${newGuid()},$,$,$,${ref(project)},(${ref(site)})`);

  const facilityIds = [];
  const facilityContents = [];

  for (const bh of boreholes) {
    w.comment(`=== BOREHOLE: ${bh.id} ===`);

    const collarPt = pt3(w, bh.collar.x - refX, bh.collar.y - refY, bh.collar.z - refZ);
    const collarAx = ax3(w, collarPt, null, null);
    const facilityPl = localPlace(w, collarAx, sitePl);
    // Name of the parent spatial container; every contained IfcElement
    // (borehole + intervals) inherits this as its own Name.
    const facilityName = `${facilityPrefix}${bh.id}`;
    const facilityId = createFacilityElement(w, {
      name: facilityName,
      description: `Facility for borehole ${bh.id}`,
      placementId: facilityPl
    });
    facilityIds.push(facilityId);

    const bhOriginPt = pt3(w, 0, 0, 0);
    const bhOriginAx = ax3(w, bhOriginPt, null, null);
    const bhPl = localPlace(w, bhOriginAx, facilityPl);

    const trajPtIds = bh.points.map((p) =>
      pt3(w, p.x - bh.collar.x, p.y - bh.collar.y, p.z - bh.collar.z));

    let bhShapeRef = '$';
    if (boreholeGeometry) {
      const bhColor = { r: 0.15, g: 0.47, b: 0.83 };
      const bhReprIds = buildGeomReprs(w, axisCtx, bodyCtx, trajPtIds, bhColor, radius);
      bhShapeRef = ref(prodShape(w, bhReprIds));
    }

    const bhId = createBoreholeElement(w, boreholeIfcClass, {
      name: facilityName,
      description: bh.className || '',
      placementId: bhPl,
      shapeRef: bhShapeRef,
      tag: bh.id
    });
    const containedIds = [bhId];

    const bhPsetProps = [
      propSingleValue(w, 'TotalDepth', bh.totalDepth, 'IFCPOSITIVELENGTHMEASURE'),
      propSingleValue(w, 'NominalDiameter', diameter > 0 ? diameter : 0, 'IFCLENGTHMEASURE'),
      propSingleValue(w, 'Status', bh.className || '', 'IFCLABEL'),
    ];
    const bhCustomProps = [
      propSingleValue(w, 'CollarX', bh.collar.x, 'IFCLENGTHMEASURE'),
      propSingleValue(w, 'CollarY', bh.collar.y, 'IFCLENGTHMEASURE'),
      propSingleValue(w, 'CollarZ', bh.collar.z, 'IFCLENGTHMEASURE'),
      propSingleValue(w, 'LateralDisplacement', bh.lateralDisplacement, 'IFCLENGTHMEASURE'),
      propSingleValue(w, 'SurveyStationCount', bh.stations.length, 'IFCCOUNTMEASURE'),
    ];

    relDefinesByProps(w, bhId, makePset(w, 'Pset_BoreholeCommon', bhPsetProps));
    relDefinesByProps(w, bhId, makePset(w, 'Pset_InfraCoreBoreholeAttributes', bhCustomProps));
    addMappedPropertySets(
      w,
      bhId,
      boreholePropertySetsById[bh.id] ?? boreholePropertySetsById[bh.normalizedId] ?? []
    );

    if (!includeIntervals) {
      facilityContents.push({ facilityId, elementIds: containedIds });
      continue;
    }

    const intervals = geologyById.get(bh.normalizedId) ?? [];

    for (const iv of intervals) {
      if (iv.from >= iv.to) continue;

      const colValue = colorColumn ? String(iv.raw?.[colorColumn] ?? '').trim() : '';
      const color = colValue
        ? (resolveColor(colValue, colorColumn, colorFiles) ?? { r: 0.72, g: 0.72, b: 0.72 })
        : { r: 0.72, g: 0.72, b: 0.72 };

      const fromLocal = interpLocal(bh.points, iv.from, bh.collar);
      const toLocal = interpLocal(bh.points, iv.to, bh.collar);
      const segPtIds = [
        pt3(w, fromLocal.x, fromLocal.y, fromLocal.z),
        pt3(w, toLocal.x, toLocal.y, toLocal.z),
      ];

      const sOriginPt = pt3(w, 0, 0, 0);
      const sOriginAx = ax3(w, sOriginPt, null, null);
      const stratPl = localPlace(w, sOriginAx, facilityPl);
      const stratReprIds = buildGeomReprs(w, axisCtx, bodyCtx, segPtIds, color, radius);
      const stratShape = prodShape(w, stratReprIds);

      // Geological label stays available via the stratum PropertySet
      // (GeolUnit / GeolSubUnit / GeologyCode); the element Name itself
      // inherits the parent container (facility) name.
      const stratTag = `${bh.id}@${iv.from}-${iv.to}`;
      const stratId = createIntervalElement(w, intervalIfcClass, {
        name: facilityName,
        description: iv.description || '',
        placementId: stratPl,
        shapeId: stratShape,
        tag: stratTag
      });
      containedIds.push(stratId);

      const hexColor = '#'
        + Math.round(color.r * 255).toString(16).padStart(2, '0')
        + Math.round(color.g * 255).toString(16).padStart(2, '0')
        + Math.round(color.b * 255).toString(16).padStart(2, '0');

      const ivProps = [
        propSingleValue(w, 'BHID', bh.id, 'IFCIDENTIFIER'),
        propSingleValue(w, 'DepthTop', iv.from, 'IFCLENGTHMEASURE'),
        propSingleValue(w, 'DepthBase', iv.to, 'IFCLENGTHMEASURE'),
        propSingleValue(w, 'Thickness', iv.thickness, 'IFCLENGTHMEASURE'),
        propSingleValue(w, 'GeolSubUnit', iv.subUnit || '', 'IFCLABEL'),
        propSingleValue(w, 'GeolUnit', iv.unit || '', 'IFCLABEL'),
        propSingleValue(w, 'GeologyCode', iv.geologyCode || '', 'IFCIDENTIFIER'),
        propSingleValue(w, 'Description', iv.description || '', 'IFCTEXT'),
        propSingleValue(w, 'ColourHex', hexColor, 'IFCLABEL'),
        propSingleValue(w, 'ColourValue', colValue || '', 'IFCLABEL'),
      ];
      if (iv.geologyCode2) ivProps.push(propSingleValue(w, 'GeologyCode2', iv.geologyCode2, 'IFCIDENTIFIER'));
      if (iv.lexicon) ivProps.push(propSingleValue(w, 'BGSLexicon', iv.lexicon, 'IFCLABEL'));
      if (iv.formation) ivProps.push(propSingleValue(w, 'GeoFormation', iv.formation, 'IFCLABEL'));
      if (iv.classification) ivProps.push(propSingleValue(w, 'Classification', iv.classification, 'IFCLABEL'));
      if (iv.remarks1) ivProps.push(propSingleValue(w, 'Remarks1', iv.remarks1, 'IFCTEXT'));
      if (iv.remarks2) ivProps.push(propSingleValue(w, 'Remarks2', iv.remarks2, 'IFCTEXT'));

      if (includeStratumPset) {
        relDefinesByProps(w, stratId, makePset(w, 'Pset_GeotechnicalStratumCommon', ivProps));
      }

      if (intervalAttributeMappings.length) {
        const mappedBySet = new Map();
        for (const mapping of intervalAttributeMappings) {
          const propertySetName = String(mapping?.propertySetName ?? '').trim();
          const propertyName = String(mapping?.propertyName ?? '').trim();
          const column = String(mapping?.column ?? '').trim();
          const value = String(iv.raw?.[column] ?? '').trim();
          if (!propertySetName || !propertyName || !column || !value) continue;
          if (!mappedBySet.has(propertySetName)) mappedBySet.set(propertySetName, []);
          mappedBySet.get(propertySetName).push({
            name: propertyName,
            value,
            type: inferMappedIfcType(value)
          });
        }

        addMappedPropertySets(w, stratId, [...mappedBySet.entries()].map(([name, properties]) => ({
          name,
          properties
        })));
      }
    }

    facilityContents.push({ facilityId, elementIds: containedIds });
  }

  w.comment('=== AGGREGATION: Site -> Facilities ===');
  if (facilityIds.length) {
    w.add('IFCRELAGGREGATES',
      `${newGuid()},$,${str('Borehole Facilities')},${str('One facility per borehole')},${ref(site)},${refList(facilityIds)}`);
  }

  w.comment('=== SPATIAL CONTAINMENT: Facility -> Borehole + Intervals ===');
  for (const { facilityId, elementIds } of facilityContents) {
    for (let i = 0; i < elementIds.length; i += 200) {
      w.add('IFCRELCONTAINEDINSPATIALSTRUCTURE',
        `${newGuid()},$,${str('Facility Contents')},${str('Borehole and associated intervals')}` +
        `,${refList(elementIds.slice(i, i + 200))},${ref(facilityId)}`);
    }
  }

  return w.toStep(filename);
}
