import { test } from "node:test";
import assert from "node:assert/strict";
import { exportToIfc } from "../src/ifc/writer.js";

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
