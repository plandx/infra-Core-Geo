import { test } from "node:test";
import assert from "node:assert/strict";
import { exportToIfc, sanitizeLayerName } from "../src/ifc/writer.js";

function sampleBorehole() {
  return {
    id: "BH-01",
    normalizedId: "BH-01",
    className: "Cat-A",
    collar: { x: 100, y: 200, z: 50 },
    totalDepth: 10,
    lateralDisplacement: 0,
    stations: [{ at: 0, dip: 90, az: 0 }],
    points: [
      { md: 0, x: 100, y: 200, z: 50 },
      { md: 10, x: 100, y: 200, z: 40 }
    ],
    endPoint: { md: 10, x: 100, y: 200, z: 40 }
  };
}

test("export throws without boreholes", () => {
  assert.throws(() => exportToIfc([], new Map()), /Keine Bohrungen/);
});

test("export emits an IFC4X3_ADD2 STEP file", () => {
  const step = exportToIfc([sampleBorehole()], new Map(), { diameter: 0.2 });
  assert.match(step, /ISO-10303-21;/);
  assert.match(step, /FILE_SCHEMA\(\('IFC4X3_ADD2'\)\)/);
  assert.match(step, /IFCBOREHOLE\(/);
});

test("contained elements inherit the parent facility name", () => {
  const geo = new Map([
    ["BH-01", [
      { from: 0, to: 5, thickness: 5, unit: "Sand", subUnit: "S1", geologyCode: "SA", description: "x", raw: {} }
    ]]
  ]);
  const step = exportToIfc([sampleBorehole()], geo, {
    facilityPrefix: "GW-",
    diameter: 0.2
  });

  const nameOf = (re) => step.split("\n").find((l) => re.test(l))?.match(/,'([^']*)'/)?.[1];
  assert.equal(nameOf(/IFCFACILITY\(/), "GW-BH-01");
  assert.equal(nameOf(/IFCBOREHOLE\(/), "GW-BH-01");
  // Interval name = container prefix + geological unit (keeps layer/colour
  // differentiation in layer-by-name importers such as BricsCAD).
  assert.equal(nameOf(/IFCBUILDINGELEMENTPROXY\(/), "GW-BH-01 - Sand");
});

test("sanitizeLayerName strips characters invalid in CAD layer names", () => {
  assert.equal(sanitizeLayerName("Sand, silty"), "Sand_ silty");
  assert.equal(sanitizeLayerName("a/b:c*d|e"), "a_b_c_d_e");
  assert.equal(sanitizeLayerName("  Clay  "), "Clay");
  assert.equal(sanitizeLayerName(""), "Layer");
});

test("each colour-column value yields its own coloured layer (colour <-> layer 1:1)", () => {
  const colorFiles = [{ columns: ["code"], colorMap: new Map([
    ["RED", { r: 255, g: 0, b: 0, css: "rgb(255,0,0)" }],
    ["BLUE", { r: 0, g: 0, b: 255, css: "rgb(0,0,255)" }]
  ]) }];
  const bh = sampleBorehole();
  // Same geological unit, but two different colour-column values.
  const geo = new Map([[bh.normalizedId, [
    { from: 0, to: 5, thickness: 5, unit: "Sand", description: "", raw: { code: "RED" } },
    { from: 5, to: 10, thickness: 5, unit: "Sand", description: "", raw: { code: "BLUE" } }
  ]]]);
  const step = exportToIfc([bh], geo, { diameter: 0.2, colorColumn: "code", colorFiles });
  const layers = [...step.matchAll(/IFCPRESENTATIONLAYERWITHSTYLE\('([^']*)'/g)].map((m) => m[1]);
  assert.ok(layers.includes("RED"), "distinct layer for colour value RED");
  assert.ok(layers.includes("BLUE"), "distinct layer for colour value BLUE");
});
