import { normalizeBoreholeId } from "./identifiers.js";
import { toNumber } from "../data/csv.js";

function firstValue(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && String(value).trim() !== "") {
      return value;
    }
  }

  return "";
}

export function normalizeGeologyRow(row) {
  const boreholeId = String(firstValue(row, ["Location ID", "BHID", "Hole ID"])).trim();
  const from = toNumber(firstValue(row, ["Depth Top", "From", "Top"]), Number.NaN);
  const to = toNumber(firstValue(row, ["Depth Base", "To", "Base"]), Number.NaN);

  return {
    boreholeId,
    normalizedId: normalizeBoreholeId(boreholeId),
    from,
    to,
    thickness: Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : 0,
    subUnit: String(firstValue(row, ["Geol_SubUnit_VASYD"])).trim(),
    unit: String(firstValue(row, ["Geol_Units_VASYD"])).trim(),
    geologyCode: String(firstValue(row, ["Geology Code"])).trim(),
    description: String(firstValue(row, ["Description"])).trim(),
    geologyCode2: String(firstValue(row, ["Geology Code 2"])).trim(),
    lexicon: String(firstValue(row, ["BGS Lexicon"])).trim(),
    formation: String(firstValue(row, ["Geological formation"])).trim(),
    classification: String(firstValue(row, ["CityTunnelClassificationLimestone"])).trim(),
    remarks1: String(firstValue(row, ["CTCL_Remarks"])).trim(),
    remarks2: String(firstValue(row, ["CTCL_Remarks 2"])).trim(),
    raw: row
  };
}

export function buildGeologyIndex(rows) {
  const normalizedRows = rows
    .map(normalizeGeologyRow)
    .filter((row) => row.boreholeId && Number.isFinite(row.from) && Number.isFinite(row.to));

  const byId = new Map();
  for (const row of normalizedRows) {
    const entries = byId.get(row.normalizedId) ?? [];
    entries.push(row);
    byId.set(row.normalizedId, entries);
  }

  for (const entries of byId.values()) {
    entries.sort((left, right) => left.from - right.from || left.to - right.to);
  }

  return { normalizedRows, byId };
}
