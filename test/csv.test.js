import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, detectDelimiter, toNumber } from "../src/data/csv.js";

test("detectDelimiter picks the most frequent candidate on the header row", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(detectDelimiter("a\tb\tc"), "\t");
});

test("parseCsv maps header columns to row objects", () => {
  const rows = parseCsv("BHID;x;y\nB1;10;20\nB2;30;40");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { BHID: "B1", x: "10", y: "20" });
  assert.equal(rows[1].BHID, "B2");
});

test("parseCsv honours quoted fields with embedded delimiters", () => {
  const rows = parseCsv('name,note\n"A","hello, world"');
  assert.equal(rows[0].note, "hello, world");
});

test("parseCsv respects a custom header row", () => {
  const rows = parseCsv("junk line\nBHID;x\nB1;5", { headerRow: 2 });
  assert.deepEqual(rows, [{ BHID: "B1", x: "5" }]);
});

test("parseCsv skips fully empty lines", () => {
  const rows = parseCsv("BHID\nB1\n\nB2\n");
  assert.deepEqual(rows.map((r) => r.BHID), ["B1", "B2"]);
});

test("toNumber accepts comma decimals and falls back", () => {
  assert.equal(toNumber("3,5"), 3.5);
  assert.equal(toNumber("12.25"), 12.25);
  assert.equal(toNumber("", 7), 7);
  assert.equal(toNumber("abc", -1), -1);
});
