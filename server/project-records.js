function normalizeScalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function clipText(value, maxLength = 6000) {
  const text = String(value ?? "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function jsonDocument(label, payload) {
  return `${label}\n${JSON.stringify(payload, null, 2)}`;
}

export function buildProjectRecords(snapshot) {
  const records = [];
  const projectId = snapshot.projectId ?? "infracore-geo";
  const counts = {
    collar: snapshot.collarRows?.length ?? 0,
    survey: snapshot.surveyRows?.length ?? 0,
    geology: snapshot.geologyRows?.length ?? 0,
    colorFiles: snapshot.colorFiles?.length ?? 0,
    boreholes: snapshot.boreholes?.length ?? 0
  };

  records.push({
    id: `${projectId}:summary`,
    document: clipText(
      jsonDocument("Projektzusammenfassung", {
        projectId,
        generatedAt: snapshot.generatedAt,
        loadStatus: snapshot.loadStatus ?? {},
        counts
      })
    ),
    metadata: {
      projectId,
      kind: "project-summary",
      boreholeId: "",
      rowIndex: -1
    }
  });

  for (const [rowIndex, row] of (snapshot.collarRows ?? []).entries()) {
    const boreholeId = String(row.BHID ?? row["Location ID"] ?? row["Hole ID"] ?? "").trim();
    records.push({
      id: `${projectId}:collar:${rowIndex}`,
      document: clipText(jsonDocument("Collar-Zeile", row)),
      metadata: {
        projectId,
        kind: "collar-row",
        dataset: "collar",
        boreholeId,
        rowIndex
      }
    });
  }

  for (const [rowIndex, row] of (snapshot.surveyRows ?? []).entries()) {
    const boreholeId = String(row.BHID ?? row["Location ID"] ?? row["Hole ID"] ?? "").trim();
    records.push({
      id: `${projectId}:survey:${rowIndex}`,
      document: clipText(jsonDocument("Survey-Zeile", row)),
      metadata: {
        projectId,
        kind: "survey-row",
        dataset: "survey",
        boreholeId,
        rowIndex
      }
    });
  }

  for (const [rowIndex, row] of (snapshot.geologyRows ?? []).entries()) {
    const boreholeId = String(row["Location ID"] ?? row.BHID ?? row["Hole ID"] ?? "").trim();
    records.push({
      id: `${projectId}:geology:${rowIndex}`,
      document: clipText(jsonDocument("Geologie-Zeile", row)),
      metadata: {
        projectId,
        kind: "geology-row",
        dataset: "geology",
        boreholeId,
        rowIndex
      }
    });
  }

  for (const [fileIndex, colorFile] of (snapshot.colorFiles ?? []).entries()) {
    records.push({
      id: `${projectId}:colors:${fileIndex}`,
      document: clipText(jsonDocument("Farbdatei", colorFile)),
      metadata: {
        projectId,
        kind: "color-file",
        dataset: "colors",
        boreholeId: "",
        rowIndex: fileIndex,
        filename: normalizeScalar(colorFile.filename)
      }
    });
  }

  for (const borehole of snapshot.boreholes ?? []) {
    records.push({
      id: `${projectId}:borehole:${borehole.id}`,
      document: clipText(
        jsonDocument("Verknuepfte Bohrung", {
          id: borehole.id,
          normalizedId: borehole.normalizedId,
          className: borehole.className,
          totalDepth: borehole.totalDepth,
          collar: borehole.collar,
          endPoint: borehole.endPoint,
          lateralDisplacement: borehole.lateralDisplacement,
          stationCount: borehole.stations?.length ?? 0,
          pointCount: borehole.points?.length ?? 0,
          stations: borehole.stations ?? [],
          points: borehole.points ?? [],
          geology: borehole.geology ?? [],
          colorAssignments: borehole.colorAssignments ?? []
        })
      ),
      metadata: {
        projectId,
        kind: "borehole",
        dataset: "derived",
        boreholeId: normalizeScalar(borehole.id),
        rowIndex: 0,
        className: normalizeScalar(borehole.className),
        totalDepth: Number.isFinite(Number(borehole.totalDepth)) ? Number(borehole.totalDepth) : 0,
        geologyCount: borehole.geology?.length ?? 0,
        stationCount: borehole.stations?.length ?? 0
      }
    });
  }

  return records;
}

export function buildProjectCounts(snapshot, records) {
  return {
    projectId: snapshot.projectId ?? "infracore-geo",
    generatedAt: snapshot.generatedAt ?? new Date().toISOString(),
    records: records.length,
    collarRows: snapshot.collarRows?.length ?? 0,
    surveyRows: snapshot.surveyRows?.length ?? 0,
    geologyRows: snapshot.geologyRows?.length ?? 0,
    colorFiles: snapshot.colorFiles?.length ?? 0,
    boreholes: snapshot.boreholes?.length ?? 0
  };
}
