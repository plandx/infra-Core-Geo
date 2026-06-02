import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeologyIndex } from "../src/domain/geology.js";
import { normalizeBoreholeId } from "../src/domain/identifiers.js";

test("buildGeologyIndex groups by normalized borehole id and sorts by depth", () => {
  const { byId, normalizedRows } = buildGeologyIndex([
    { "Location ID": " b1 ", "Depth Top": "5", "Depth Base": "10" },
    { "Location ID": "B1", "Depth Top": "0", "Depth Base": "5" },
    { "Location ID": "B2", "Depth Top": "0", "Depth Base": "2" }
  ]);

  assert.equal(normalizedRows.length, 3);
  const b1 = byId.get(normalizeBoreholeId("B1"));
  assert.equal(b1.length, 2, "case/whitespace-insensitive grouping");
  assert.deepEqual(b1.map((r) => r.from), [0, 5], "sorted ascending by from");
  assert.equal(b1[0].thickness, 5);
});

test("buildGeologyIndex drops rows with non-finite depths", () => {
  const { normalizedRows } = buildGeologyIndex([
    { "Location ID": "B1", "Depth Top": "", "Depth Base": "5" },
    { "Location ID": "B1", "Depth Top": "0", "Depth Base": "5" }
  ]);
  assert.equal(normalizedRows.length, 1);
});
