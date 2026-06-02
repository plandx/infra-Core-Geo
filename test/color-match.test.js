import { test } from "node:test";
import assert from "node:assert/strict";
import { findColorEntry, orderColorFiles } from "../src/domain/color-match.js";

function colorFile(columns, entries) {
  return { columns, colorMap: new Map(entries) };
}

const sand = { r: 1, g: 2, b: 3, css: "rgb(1,2,3)" };
const clay = { r: 9, g: 9, b: 9, css: "rgb(9,9,9)" };

test("exact key match wins", () => {
  const files = [colorFile(["unit"], [["Sand", sand]])];
  assert.equal(findColorEntry("Sand", "unit", files), sand);
});

test("substring match works in both directions for values > 2 chars", () => {
  const files = [colorFile(["unit"], [["Sand", sand]])];
  assert.equal(findColorEntry("Sandstone", "unit", files), sand, "value contains key");
  const files2 = [colorFile(["unit"], [["Sandstone", sand]])];
  assert.equal(findColorEntry("Sand", "unit", files2), sand, "key contains value");
});

test("substring matching is gated on the value length (> 2 chars)", () => {
  // Exact match works regardless of length.
  assert.equal(findColorEntry("AB", "unit", [colorFile(["unit"], [["AB", sand]])]), sand);
  // Value of 2 chars never substring-matches a longer key.
  assert.equal(findColorEntry("AB", "unit", [colorFile(["unit"], [["ABCD", sand]])]), null);
  // Value > 2 chars does substring-match.
  assert.equal(findColorEntry("ABC", "unit", [colorFile(["unit"], [["AB", sand]])]), sand);
});

test("files matching the log column are preferred over column-less files", () => {
  const matching = colorFile(["unit"], [["X", sand]]);
  const generic = colorFile([], [["X", clay]]);
  const files = [generic, matching];
  assert.equal(findColorEntry("X", "unit", files), sand);
  assert.deepEqual(orderColorFiles(files, "unit"), [matching, generic]);
});

test("missing value or empty files returns null", () => {
  assert.equal(findColorEntry("", "unit", [colorFile(["unit"], [["X", sand]])]), null);
  assert.equal(findColorEntry("X", "unit", []), null);
});
