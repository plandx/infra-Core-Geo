import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBoreholes, getDatasetExtents } from "../src/domain/trajectory.js";

test("vertical borehole drops straight down by its depth", () => {
  const boreholes = buildBoreholes(
    [{ BHID: "B1", x: "10", y: "20", z: "0", depth: "5" }],
    []
  );
  assert.equal(boreholes.length, 1);
  const bh = boreholes[0];
  assert.equal(bh.id, "B1");
  assert.ok(Math.abs(bh.endPoint.z - -5) < 1e-6, "toe is 5 m below collar");
  assert.ok(bh.lateralDisplacement < 1e-6, "no lateral drift for a vertical hole");
  assert.equal(bh.totalDepth, 5);
});

test("a single zero coordinate is accepted (local CRS)", () => {
  const boreholes = buildBoreholes(
    [{ BHID: "B1", x: "0", y: "20", z: "0", depth: "5" }],
    []
  );
  assert.equal(boreholes.length, 1, "x=0 with valid y must not be discarded");
});

test("a (0,0) origin is rejected as unset", () => {
  const boreholes = buildBoreholes(
    [{ BHID: "B1", x: "0", y: "0", z: "0", depth: "5" }],
    []
  );
  assert.equal(boreholes.length, 0);
});

test("rows without a positive depth are rejected", () => {
  const boreholes = buildBoreholes(
    [{ BHID: "B1", x: "1", y: "2", z: "0", depth: "0" }],
    []
  );
  assert.equal(boreholes.length, 0);
});

test("getDatasetExtents spans all trajectory points", () => {
  const boreholes = buildBoreholes(
    [{ BHID: "B1", x: "10", y: "20", z: "0", depth: "5" }],
    []
  );
  const ext = getDatasetExtents(boreholes);
  assert.equal(ext.minX, 10);
  assert.equal(ext.maxZ, 0);
  assert.equal(ext.minZ, -5);
});
