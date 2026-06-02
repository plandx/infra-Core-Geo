import { toNumber } from "../data/csv.js";
import { normalizeBoreholeId } from "./identifiers.js";

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function normalizeStation(station) {
  return {
    at: toNumber(station.at ?? station.AT ?? station.depth ?? station.Depth),
    dip: toNumber(station.dip ?? station.Dip, 90),
    az: toNumber(station.az ?? station.AZ ?? station.Azimuth, 0)
  };
}

function firstValue(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && String(value).trim() !== "") {
      return value;
    }
  }

  return "";
}

function normalizeCollar(collar) {
  return {
    id: String(firstValue(collar, ["BHID", "Location ID", "Hole ID", "holeid"])).trim(),
    x: toNumber(firstValue(collar, ["x", "X", "Easting", "east", "EASTING"]), Number.NaN),
    y: toNumber(firstValue(collar, ["y", "Y", "Northing", "north", "NORTHING"]), Number.NaN),
    z: toNumber(firstValue(collar, ["z", "Z", "Ground Level", "RL", "elevation"]), 0),
    depth: toNumber(firstValue(collar, ["depth", "Depth", "Final Depth", "EOH", "Length"]), 0),
    className: String(firstValue(collar, ["class", "Class", "OLM"])).trim()
  };
}

function isValidCollar(collar) {
  if (!collar.id) {
    return false;
  }

  if (collar.id === "BHID" || collar.id === "Location ID") {
    return false;
  }

  if (!Number.isFinite(collar.x) || !Number.isFinite(collar.y)) {
    return false;
  }

  if (collar.x === 0 || collar.y === 0) {
    return false;
  }

  if (collar.depth <= 0) {
    return false;
  }

  return true;
}

function projectStep(length, dip, az) {
  const dipRad = degreesToRadians(dip);
  const azRad = degreesToRadians(az);
  const horizontal = Math.cos(dipRad) * length;

  return {
    dx: horizontal * Math.sin(azRad),
    dy: horizontal * Math.cos(azRad),
    dz: -Math.sin(dipRad) * length
  };
}

export function buildBoreholes(collarRows, surveyRows) {
  const surveysById = new Map();

  for (const row of surveyRows) {
    const bhid = String(row.BHID ?? "").trim();
    if (!bhid) {
      continue;
    }

    const normalizedId = normalizeBoreholeId(bhid);
    const stations = surveysById.get(normalizedId) ?? [];
    stations.push(normalizeStation(row));
    surveysById.set(normalizedId, stations);
  }

  const boreholes = [];

  for (const rawCollar of collarRows) {
    const collar = normalizeCollar(rawCollar);
    if (!isValidCollar(collar)) {
      continue;
    }

    const id = collar.id;
    const normalizedId = normalizeBoreholeId(id);
    const origin = {
      x: collar.x,
      y: collar.y,
      z: collar.z
    };

    const totalDepth = collar.depth;
    const stations = (surveysById.get(normalizedId) ?? [{ at: 0, dip: 90, az: 0 }])
      .slice()
      .sort((left, right) => left.at - right.at);

    if (stations[0]?.at > 0) {
      stations.unshift({ at: 0, dip: stations[0].dip, az: stations[0].az });
    }

    const points = [{ md: 0, ...origin }];
    let current = { ...origin };
    let currentStation = stations[0];

    for (let index = 1; index < stations.length; index += 1) {
      const nextStation = stations[index];
      const segmentLength = Math.max(0, nextStation.at - currentStation.at);
      const step = projectStep(segmentLength, currentStation.dip, currentStation.az);

      current = {
        x: current.x + step.dx,
        y: current.y + step.dy,
        z: current.z + step.dz
      };

      points.push({ md: nextStation.at, ...current });
      currentStation = nextStation;
    }

    const effectiveDepth = Math.max(totalDepth, currentStation.at);
    if (effectiveDepth > currentStation.at) {
      const remaining = effectiveDepth - currentStation.at;
      const step = projectStep(remaining, currentStation.dip, currentStation.az);

      current = {
        x: current.x + step.dx,
        y: current.y + step.dy,
        z: current.z + step.dz
      };

      points.push({ md: effectiveDepth, ...current });
    }

    const endPoint = points[points.length - 1];

    boreholes.push({
      id,
      normalizedId,
      className: collar.className,
      collar: origin,
      totalDepth: effectiveDepth,
      stations,
      points,
      endPoint,
      lateralDisplacement: Math.hypot(endPoint.x - origin.x, endPoint.y - origin.y)
    });
  }

  return boreholes.sort((left, right) => left.id.localeCompare(right.id));
}

export function getDatasetExtents(boreholes) {
  const extents = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity
  };

  for (const borehole of boreholes) {
    for (const point of borehole.points) {
      extents.minX = Math.min(extents.minX, point.x);
      extents.maxX = Math.max(extents.maxX, point.x);
      extents.minY = Math.min(extents.minY, point.y);
      extents.maxY = Math.max(extents.maxY, point.y);
      extents.minZ = Math.min(extents.minZ, point.z);
      extents.maxZ = Math.max(extents.maxZ, point.z);
    }
  }

  return extents;
}
