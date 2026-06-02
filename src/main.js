import { parseCsv, detectDelimiter } from "./data/csv.js";
import { exportToIfc, applyNameTemplate, DEFAULT_BOREHOLE_NAME_TEMPLATE, DEFAULT_INTERVAL_NAME_TEMPLATE } from "./ifc/writer.js";
import { importFromIfc } from "./ifc/reader.js";
import { Viewer3D } from "./render/viewer3d.js";
import { buildBoreholes } from "./domain/trajectory.js";
import { buildGeologyIndex } from "./domain/geology.js";
import { normalizeBoreholeId } from "./domain/identifiers.js";
import { findColorEntry } from "./domain/color-match.js";
import { renderCanvas } from "./render/canvas-view.js";
import { saveDataset, loadAllCached, clearAll } from "./data/db.js";
import { parseLfcColors, serializeColorMap, deserializeColorMap } from "./data/colors.js";
import {
  listSavedProjects,
  loadSavedProject,
  loadWorkspaceProject,
  saveNamedProject,
  scheduleProjectDbSync,
  resetProjectDbSyncSignature,
  WORKSPACE_PROJECT_ID
} from "./data/project-db.js";

// =====================================================================
// COLLAR COLUMN MAPPING
// =====================================================================
const COLLAR_PATTERNS = {
  boreholeId: ["BHID", "BH_ID", "BH ID", "Hole", "HoleID", "Hole ID", "Location ID", "holeid", "ID", "Bohrung", "Name", "Point_ID"],
  x:          ["x", "X", "Easting", "EASTING", "east", "East", "X_Coord", "Rechtswert", "RW", "E"],
  y:          ["y", "Y", "Northing", "NORTHING", "north", "North", "Y_Coord", "Hochwert", "HW", "N"],
  z:          ["z", "Z", "Elevation", "ELEVATION", "RL", "Ground Level", "Höhe", "Height", "height", "elevation", "Elev"],
  depth:      ["depth", "Depth", "EOH", "Length", "Final Depth", "Total_Depth", "Teufe", "Tiefe", "Endtiefe", "MaxDepth", "DEPTH"],
  class:      ["class", "Class", "CLASS", "OLM", "Type", "type", "Category", "Kategorie", "Klasse"]
};

function autoDetectCollarMapping(headers) {
  const result = {};
  for (const [field, patterns] of Object.entries(COLLAR_PATTERNS)) {
    const hit = patterns.find((p) =>
      headers.some((h) => h.trim().toLowerCase() === p.toLowerCase())
    );
    result[field] = hit
      ? (headers.find((h) => h.trim().toLowerCase() === hit.toLowerCase()) ?? "")
      : "";
  }
  return result;
}

function applyCollarMapping(rows, mapping) {
  // Standard target column names and their mapping sources
  const fieldMap = [
    [mapping.boreholeId, "BHID"],
    [mapping.x,          "x"],
    [mapping.y,          "y"],
    [mapping.z,          "z"],
    [mapping.depth,      "depth"],
    [mapping.class,      "class"]
  ];

  // Collect source columns that will be renamed (src !== tgt and src is set)
  const remappedSources = new Set(
    fieldMap.filter(([src, tgt]) => src && src !== tgt).map(([src]) => src)
  );

  return rows.map((row) => {
    const out = {};
    // Copy original columns, but drop those being renamed to a standard name
    for (const [key, val] of Object.entries(row)) {
      if (!remappedSources.has(key)) out[key] = val;
    }
    // Write the standard column names with the mapped values
    for (const [src, tgt] of fieldMap) {
      if (src) out[tgt] = row[src] ?? "";
    }
    return out;
  });
}

function countValidCollarRows(rows, mapping) {
  const { toNumber } = { toNumber: (v) => parseFloat(String(v ?? "").replace(",", ".")) };
  return rows.filter((row) => {
    const bhid  = String(row[mapping.boreholeId] ?? "").trim();
    const x     = toNumber(row[mapping.x]);
    const y     = toNumber(row[mapping.y]);
    const depth = toNumber(row[mapping.depth]);
    return bhid && isFinite(x) && isFinite(y) && !(x === 0 && y === 0) && depth > 0;
  }).length;
}

function populateMappingSelect(selectId, headers, selectedValue, isRequired) {
  const sel = el(selectId);
  sel.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— nicht zugewiesen —";
  sel.append(blank);
  for (const header of headers) {
    const opt = document.createElement("option");
    opt.value = header;
    opt.textContent = header;
    if (header === selectedValue) opt.selected = true;
    sel.append(opt);
  }
  sel.className = "mapping-select" +
    (selectedValue ? " is-auto-detected" : (isRequired ? " is-missing" : ""));
}

function updateMappingPreview(pendingRows) {
  const mapping = readMappingSelects();
  const valid   = countValidCollarRows(pendingRows, mapping);
  const total   = pendingRows.length;
  const prev    = el("collar-mapping-preview");

  if (!total) {
    prev.textContent = "Keine Datenzeilen erkannt. Bitte Trennzeichen und Header-Zeile pruefen.";
    prev.className = "mapping-preview is-error";
    return;
  }

  if (!mapping.boreholeId && !mapping.x && !mapping.y) {
    prev.textContent = "Pflichtfelder auswählen (ID, X, Y, Tiefe)";
    prev.className = "mapping-preview is-warn";
    return;
  }

  prev.textContent = `${valid} von ${total} Zeilen erkennbar`;
  prev.className = "mapping-preview" + (valid === 0 ? " is-error" : valid < total ? " is-warn" : " is-ok");
}

function readMappingSelects() {
  return {
    boreholeId: el("map-bhid")?.value   ?? "",
    x:          el("map-x")?.value      ?? "",
    y:          el("map-y")?.value      ?? "",
    z:          el("map-z")?.value      ?? "",
    depth:      el("map-depth")?.value  ?? "",
    class:      el("map-class")?.value  ?? ""
  };
}

function showCollarMappingUI(rows, filename, shouldScroll = true) {
  const headers = Object.keys(rows[0] ?? {});
  const detected = autoDetectCollarMapping(headers);

  // Populate each select
  populateMappingSelect("map-bhid",  headers, detected.boreholeId, true);
  populateMappingSelect("map-x",     headers, detected.x,          true);
  populateMappingSelect("map-y",     headers, detected.y,          true);
  populateMappingSelect("map-z",     headers, detected.z,          false);
  populateMappingSelect("map-depth", headers, detected.depth,      true);
  populateMappingSelect("map-class", headers, detected.class,      false);

  // Header info
  el("collar-mapping-filename").textContent = filename;
  el("collar-mapping-cols").textContent     = headers.join(" · ");

  // Show and scroll
  const section = el("collar-mapping-section");
  section.hidden = false;
  if (shouldScroll) {
    setTimeout(() => section.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  }

  // Live preview
  updateMappingPreview(rows);
}

function reParseCollarImport() {
  const rows = parseCsv(state.pendingCollarText, getImportParseOptions("cmap"));
  state.pendingCollarRows = rows;
  updateImportHeaderPreview("cmap", state.pendingCollarText);
  showCollarMappingUI(rows, el("collar-mapping-filename").textContent || state.pendingCollarFilename || "", false);
}

function showCollarImportUI(text, filename) {
  state.pendingCollarText = text;
  state.pendingCollarFilename = filename;
  const headerInput = el("cmap-header-row");
  if (headerInput) headerInput.value = "1";
  const headerRow = 1;
  const delimSel = el("cmap-delimiter");
  if (delimSel) {
    delimSel.value = delimiterCharToValue(detectDelimiter(text, { headerRow }));
  }
  reParseCollarImport();
}

// =====================================================================
// SURVEY COLUMN MAPPING
// =====================================================================
const SURVEY_PATTERNS = {
  boreholeId: ["BHID", "BH_ID", "BH ID", "Hole", "HoleID", "Hole ID", "Location ID", "holeid", "ID", "Bohrung", "Name", "Point_ID"],
  at:         ["at", "AT", "MD", "Measured Depth", "MeasuredDepth", "depth", "Depth", "Teufe", "Tiefe", "From", "from"],
  dip:        ["dip", "Dip", "DIP", "Inclination", "Inc", "INC", "Einfallswinkel", "Neigung", "Plunge"],
  az:         ["az", "AZ", "Azimuth", "AZIMUTH", "azimuth", "Bearing", "bearing", "Direction", "Richtung", "Strike"]
};

function autoDetectSurveyMapping(headers) {
  const result = {};
  for (const [field, patterns] of Object.entries(SURVEY_PATTERNS)) {
    const hit = patterns.find((p) =>
      headers.some((h) => h.trim().toLowerCase() === p.toLowerCase())
    );
    result[field] = hit
      ? (headers.find((h) => h.trim().toLowerCase() === hit.toLowerCase()) ?? "")
      : "";
  }
  return result;
}

function applySurveyMapping(rows, mapping) {
  const fieldMap = [
    [mapping.boreholeId, "BHID"],
    [mapping.at,         "at"],
    [mapping.dip,        "dip"],
    [mapping.az,         "az"]
  ];

  const remappedSources = new Set(
    fieldMap.filter(([src, tgt]) => src && src !== tgt).map(([src]) => src)
  );

  return rows.map((row) => {
    const out = {};
    for (const [key, val] of Object.entries(row)) {
      if (!remappedSources.has(key)) out[key] = val;
    }
    for (const [src, tgt] of fieldMap) {
      if (src) out[tgt] = row[src] ?? "";
    }
    return out;
  });
}

function countValidSurveyRows(rows, mapping) {
  const toNum = (v) => parseFloat(String(v ?? "").replace(",", "."));
  const validRows = rows.filter((row) => {
    const bhid = String(row[mapping.boreholeId] ?? "").trim();
    const at   = toNum(row[mapping.at]);
    return bhid && isFinite(at);
  });
  const uniqueBhids = new Set(
    validRows.map((r) => String(r[mapping.boreholeId] ?? "").trim().toUpperCase())
  );
  return { rows: validRows.length, boreholes: uniqueBhids.size };
}

function updateSurveyMappingPreview(pendingRows) {
  const mapping = readSurveyMappingSelects();
  const prev    = el("survey-mapping-preview");

  if (!pendingRows.length) {
    prev.textContent = "Keine Datenzeilen erkannt. Bitte Trennzeichen und Header-Zeile pruefen.";
    prev.className   = "mapping-preview is-error";
    return;
  }

  if (!mapping.boreholeId || !mapping.at) {
    prev.textContent = "Bohrung-ID und Teufe sind Pflichtfelder.";
    prev.className   = "mapping-preview is-warn";
    return;
  }

  const { rows, boreholes } = countValidSurveyRows(pendingRows, mapping);
  prev.textContent = `${rows} Messpunkte · ${boreholes} Bohrungen erkannt`;
  prev.className   = "mapping-preview" + (rows === 0 ? " is-error" : " is-ok");
}

function readSurveyMappingSelects() {
  return {
    boreholeId: el("smap-bhid")?.value ?? "",
    at:         el("smap-at")?.value   ?? "",
    dip:        el("smap-dip")?.value  ?? "",
    az:         el("smap-az")?.value   ?? ""
  };
}

function populateSurveyMappingSelect(selectId, headers, selectedValue, isRequired) {
  const sel = el(selectId);
  sel.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— nicht zugewiesen —";
  sel.append(blank);
  for (const header of headers) {
    const opt = document.createElement("option");
    opt.value = header;
    opt.textContent = header;
    if (header === selectedValue) opt.selected = true;
    sel.append(opt);
  }
  sel.className = "mapping-select" +
    (selectedValue ? " is-auto-detected" : (isRequired ? " is-missing" : ""));
}

function showSurveyMappingUI(rows, filename, shouldScroll = true) {
  const headers  = Object.keys(rows[0] ?? {});
  const detected = autoDetectSurveyMapping(headers);

  populateSurveyMappingSelect("smap-bhid", headers, detected.boreholeId, true);
  populateSurveyMappingSelect("smap-at",   headers, detected.at,         true);
  populateSurveyMappingSelect("smap-dip",  headers, detected.dip,        false);
  populateSurveyMappingSelect("smap-az",   headers, detected.az,         false);

  el("survey-mapping-filename").textContent = filename;
  el("survey-mapping-cols").textContent     = headers.join(" · ");

  const section = el("survey-mapping-section");
  section.hidden = false;
  if (shouldScroll) {
    setTimeout(() => section.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  }

  updateSurveyMappingPreview(rows);
}

function reParseSurveyImport() {
  const rows = parseCsv(state.pendingSurveyText, getImportParseOptions("smapcfg"));
  state.pendingSurveyRows = rows;
  updateImportHeaderPreview("smapcfg", state.pendingSurveyText);
  showSurveyMappingUI(rows, el("survey-mapping-filename").textContent || state.pendingSurveyFilename || "", false);
}

function showSurveyImportUI(text, filename) {
  state.pendingSurveyText = text;
  state.pendingSurveyFilename = filename;
  const headerInput = el("smapcfg-header-row");
  if (headerInput) headerInput.value = "1";
  const headerRow = 1;
  const delimSel = el("smapcfg-delimiter");
  if (delimSel) {
    delimSel.value = delimiterCharToValue(detectDelimiter(text, { headerRow }));
  }
  reParseSurveyImport();
}

// =====================================================================
// GEOLOGY COLUMN MAPPING
// =====================================================================
const GEOLOGY_PATTERNS = {
  boreholeId: ["Location ID", "BHID", "BH_ID", "Hole ID", "HoleID", "holeid", "ID", "Bohrung", "Name", "Point_ID"],
  from:       ["Depth Top", "From", "from", "Top", "top", "Von", "von", "Start", "start", "Depth_Top"],
  to:         ["Depth Base", "To", "to", "Base", "base", "Bis", "bis", "End", "end", "Depth_Base"]
};

function delimiterValueToChar(selectValue) {
  if (selectValue === "auto" || !selectValue) return undefined;
  if (selectValue === "tab") return "\t";
  return selectValue;
}

function delimiterCharToValue(delimiter) {
  if (delimiter === "\t") return "tab";
  if (delimiter === ";" || delimiter === "," || delimiter === "|") return delimiter;
  return "auto";
}

function sanitizeHeaderRow(value) {
  return Math.max(1, Number.parseInt(String(value ?? "1"), 10) || 1);
}

function getImportParseOptions(prefix) {
  const delimiterValue = el(`${prefix}-delimiter`)?.value ?? "auto";
  const headerRow = sanitizeHeaderRow(el(`${prefix}-header-row`)?.value ?? 1);
  const delimiter = delimiterValueToChar(delimiterValue);
  return delimiter ? { delimiter, headerRow } : { headerRow };
}

function getPreviewLine(text, lineNumber) {
  const lines = text.split(/\r?\n/);
  const rawLine = lines[Math.max(0, lineNumber - 1)] ?? "";
  return rawLine.slice(0, 160) + (rawLine.length > 160 ? "..." : "");
}

function updateImportHeaderPreview(prefix, text) {
  const headerRow = sanitizeHeaderRow(el(`${prefix}-header-row`)?.value ?? 1);
  const previewEl = el(`${prefix}-raw-preview`);
  if (previewEl) {
    previewEl.textContent = getPreviewLine(text, headerRow) || "Keine Daten in dieser Zeile.";
  }
}

function autoDetectGeologyMapping(headers) {
  const result = {};
  for (const [field, patterns] of Object.entries(GEOLOGY_PATTERNS)) {
    const hit = patterns.find((p) =>
      headers.some((h) => h.trim().toLowerCase() === p.toLowerCase())
    );
    result[field] = hit
      ? (headers.find((h) => h.trim().toLowerCase() === hit.toLowerCase()) ?? "")
      : "";
  }
  return result;
}

function applyGeologyMapping(rows, mapping) {
  const fieldMap = [
    [mapping.boreholeId, "Location ID"],
    [mapping.from,       "Depth Top"],
    [mapping.to,         "Depth Base"]
  ];

  const remappedSources = new Set(
    fieldMap.filter(([src, tgt]) => src && src !== tgt).map(([src]) => src)
  );

  return rows.map((row) => {
    const out = {};
    for (const [key, val] of Object.entries(row)) {
      if (!remappedSources.has(key)) out[key] = val;
    }
    for (const [src, tgt] of fieldMap) {
      if (src) out[tgt] = row[src] ?? "";
    }
    return out;
  });
}

function countValidGeologyRows(rows, mapping) {
  const toNum = (v) => parseFloat(String(v ?? "").replace(",", "."));
  const validRows = rows.filter((row) => {
    const bhid = String(row[mapping.boreholeId] ?? "").trim();
    const from = toNum(row[mapping.from]);
    const to   = toNum(row[mapping.to]);
    return bhid && isFinite(from) && isFinite(to);
  });
  const uniqueBhids = new Set(
    validRows.map((r) => String(r[mapping.boreholeId] ?? "").trim().toUpperCase())
  );
  return { rows: validRows.length, boreholes: uniqueBhids.size };
}

function readGeologyMappingSelects() {
  return {
    boreholeId: el("gmap-bhid")?.value ?? "",
    from:       el("gmap-from")?.value ?? "",
    to:         el("gmap-to")?.value   ?? ""
  };
}

function updateGeologyMappingPreview() {
  const mapping = readGeologyMappingSelects();
  const prev    = el("geology-mapping-preview");
  if (!state.pendingGeologyRows.length) {
    prev.textContent = "Keine Datenzeilen erkannt. Bitte Trennzeichen und Header-Zeile pruefen.";
    prev.className   = "mapping-preview is-error";
    return;
  }
  if (!mapping.boreholeId || !mapping.from || !mapping.to) {
    prev.textContent = "Bohrung-ID, Tiefe Von und Tiefe Bis sind Pflichtfelder.";
    prev.className   = "mapping-preview is-warn";
    return;
  }
  const { rows, boreholes } = countValidGeologyRows(state.pendingGeologyRows, mapping);
  prev.textContent = `${rows} Intervalle · ${boreholes} Bohrungen erkannt`;
  prev.className   = "mapping-preview" + (rows === 0 ? " is-error" : " is-ok");
}

function populateGeologyMappingSelects(headers, detected) {
  const fields = [
    ["gmap-bhid", detected.boreholeId, true],
    ["gmap-from", detected.from,       true],
    ["gmap-to",   detected.to,         true]
  ];
  for (const [id, val, required] of fields) {
    const sel = el(id);
    sel.replaceChildren();
    const blank = document.createElement("option");
    blank.value = ""; blank.textContent = "— nicht zugewiesen —";
    sel.append(blank);
    for (const h of headers) {
      const opt = document.createElement("option");
      opt.value = h; opt.textContent = h;
      if (h === val) opt.selected = true;
      sel.append(opt);
    }
    sel.className = "mapping-select" + (val ? " is-auto-detected" : (required ? " is-missing" : ""));
  }
}

function reParseGeologyWithDelimiter() {
  const rows = parseCsv(state.pendingGeologyText, getImportParseOptions("gmap"));
  state.pendingGeologyRows = rows;
  updateImportHeaderPreview("gmap", state.pendingGeologyText);

  const headers  = Object.keys(rows[0] ?? {});
  const detected = autoDetectGeologyMapping(headers);
  populateGeologyMappingSelects(headers, detected);
  el("geology-mapping-cols").textContent = headers.join(" · ");
  updateGeologyMappingPreview();
}

function showGeologyMappingUI(text, filename) {
  state.pendingGeologyText = text;
  const headerInput = el("gmap-header-row");
  if (headerInput) headerInput.value = "1";
  const headerRow = 1;
  const firstLine = getPreviewLine(text, headerRow);
  const delimSel = el("gmap-delimiter");
  if (delimSel) {
    delimSel.value = delimiterCharToValue(detectDelimiter(text, { headerRow }));
  }

  el("geology-raw-preview").textContent = firstLine.slice(0, 120) + (firstLine.length > 120 ? "…" : "");

  // Parse + fill mapping selects
  reParseGeologyWithDelimiter();

  el("geology-mapping-filename").textContent = filename;

  const section = el("geology-mapping-section");
  section.hidden = false;
  setTimeout(() => section.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
}

const ATTRIBUTE_DATASET_META = {
  collar: {
    label: "Collar",
    targetLabel: "IfcBorehole",
    modeLabel: "Direkt pro Bohrung",
    defaultPropertySetName: "Pset_InfraCore_CollarImport"
  },
  survey: {
    label: "Survey",
    targetLabel: "IfcBorehole",
    modeLabel: "Aggregiert pro Bohrung",
    defaultPropertySetName: "Pset_InfraCore_SurveyImport"
  },
  interval: {
    label: "Intervall",
    targetLabel: "IfcBuildingElementProxy",
    modeLabel: "Direkt pro Intervall",
    defaultPropertySetName: "Pset_InfraCore_IntervalImport"
  }
};

function getAttributeSourceRows(datasetKey) {
  if (datasetKey === "collar") return state.collarRows;
  if (datasetKey === "survey") return state.surveyRows;
  if (datasetKey === "interval") return state.geologyRows;
  return [];
}

function buildAttributeMappingId(datasetKey, column) {
  return `${datasetKey}::${column}`;
}

function sanitizeIfcPropertyName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "Property";
}

function createDefaultAttributeMapping(datasetKey, column) {
  const meta = ATTRIBUTE_DATASET_META[datasetKey];
  return {
    id: buildAttributeMappingId(datasetKey, column),
    datasetKey,
    column,
    enabled: true,
    propertySetName: meta.defaultPropertySetName,
    propertyName: sanitizeIfcPropertyName(column)
  };
}

function syncAttributeMappings() {
  const existing = new Map((state.attributeMappings ?? []).map((mapping) => [mapping.id, mapping]));
  const next = [];

  for (const datasetKey of ["collar", "survey", "interval"]) {
    const rows = getAttributeSourceRows(datasetKey);
    const headers = Object.keys(rows[0] ?? {});
    for (const column of headers) {
      const id = buildAttributeMappingId(datasetKey, column);
      const current = existing.get(id);
      next.push(current
        ? {
            ...current,
            datasetKey,
            column,
            propertySetName: current.propertySetName || ATTRIBUTE_DATASET_META[datasetKey].defaultPropertySetName,
            propertyName: current.propertyName || sanitizeIfcPropertyName(column)
          }
        : createDefaultAttributeMapping(datasetKey, column));
    }
  }

  state.attributeMappings = next;
}

function getAttributeSampleValue(mapping) {
  const rows = getAttributeSourceRows(mapping.datasetKey);
  const row = rows.find((entry) => String(entry?.[mapping.column] ?? "").trim() !== "");
  return row ? String(row[mapping.column] ?? "") : "";
}

function updateAttributeMappingValue(mappingId, patch) {
  const mapping = state.attributeMappings.find((entry) => entry.id === mappingId);
  if (!mapping) return;
  Object.assign(mapping, patch);
  triggerProjectDbSync();
  updateAttributePanel();
  updateNavBadges();
}

function updateAttributePanel() {
  const table = el("attribute-table");
  if (!table) return;

  syncAttributeMappings();

  const total = state.attributeMappings.length;
  const enabled = state.attributeMappings.filter((mapping) => mapping.enabled).length;
  if (el("attribute-row-count")) el("attribute-row-count").textContent = `${total} Mappings`;
  if (el("attribute-enabled-count")) el("attribute-enabled-count").textContent = `${enabled} aktiv`;

  if (!total) {
    table.innerHTML = `<tbody><tr><td class="td-empty">Noch keine importierten Spalten verfuegbar.</td></tr></tbody>`;
    return;
  }

  const thead = `
    <thead>
      <tr>
        <th>Aktiv</th>
        <th>Import</th>
        <th>Spalte</th>
        <th>Ziel IFC</th>
        <th>Wertmodus</th>
        <th>PropertySet</th>
        <th>Property</th>
        <th>Beispiel</th>
      </tr>
    </thead>`;
  table.innerHTML = `${thead}<tbody></tbody>`;

  const tbody = table.querySelector("tbody");
  for (const mapping of state.attributeMappings) {
    const meta = ATTRIBUTE_DATASET_META[mapping.datasetKey];
    const tr = document.createElement("tr");

    const enabledTd = document.createElement("td");
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = !!mapping.enabled;
    enabledInput.addEventListener("change", () => updateAttributeMappingValue(mapping.id, { enabled: enabledInput.checked }));
    enabledTd.append(enabledInput);

    const datasetTd = document.createElement("td");
    datasetTd.textContent = meta.label;

    const columnTd = document.createElement("td");
    columnTd.textContent = mapping.column;
    columnTd.className = "td-bhid";

    const targetTd = document.createElement("td");
    targetTd.textContent = meta.targetLabel;

    const modeTd = document.createElement("td");
    modeTd.textContent = meta.modeLabel;

    const psetTd = document.createElement("td");
    const psetInput = document.createElement("input");
    psetInput.type = "text";
    psetInput.value = mapping.propertySetName ?? "";
    psetInput.className = "mapping-select";
    psetInput.addEventListener("change", () => updateAttributeMappingValue(mapping.id, {
      propertySetName: psetInput.value.trim() || meta.defaultPropertySetName
    }));
    psetTd.append(psetInput);

    const propTd = document.createElement("td");
    const propInput = document.createElement("input");
    propInput.type = "text";
    propInput.value = mapping.propertyName ?? "";
    propInput.className = "mapping-select";
    propInput.addEventListener("change", () => updateAttributeMappingValue(mapping.id, {
      propertyName: sanitizeIfcPropertyName(propInput.value || mapping.column)
    }));
    propTd.append(propInput);

    const sampleTd = document.createElement("td");
    sampleTd.textContent = getAttributeSampleValue(mapping) || "—";

    tr.append(enabledTd, datasetTd, columnTd, targetTd, modeTd, psetTd, propTd, sampleTd);
    tbody.append(tr);
  }
}

function getMatchingCollarRow(borehole) {
  return state.collarByNormalizedId.get(borehole.normalizedId) ?? null;
}

function getMatchingSurveyRows(borehole) {
  return state.surveyByNormalizedId.get(borehole.normalizedId) ?? [];
}

function inferIfcExportType(value) {
  const text = String(value ?? "").trim();
  if (!text) return "IFCTEXT";
  return /^[-+]?\d+(?:[.,]\d+)?$/.test(text) ? "IFCREAL" : "IFCTEXT";
}

function pushPropertyGroup(groups, propertySetName, propertyName, value, ifcType = inferIfcExportType(value)) {
  const trimmedPset = String(propertySetName ?? "").trim();
  const trimmedName = sanitizeIfcPropertyName(propertyName);
  const text = String(value ?? "").trim();
  if (!trimmedPset || !trimmedName || !text) return;
  if (!groups[trimmedPset]) groups[trimmedPset] = {};
  groups[trimmedPset][trimmedName] = { name: trimmedName, value: text, type: ifcType };
}

function buildBoreholeAttributePropertySets(boreholes) {
  const relevantMappings = state.attributeMappings.filter((mapping) => mapping.enabled && mapping.datasetKey !== "interval");
  const byId = {};

  for (const borehole of boreholes) {
    const groups = {};
    const collarRow = getMatchingCollarRow(borehole);
    const surveyRows = getMatchingSurveyRows(borehole);

    for (const mapping of relevantMappings) {
      if (mapping.datasetKey === "collar" && collarRow) {
        pushPropertyGroup(groups, mapping.propertySetName, mapping.propertyName, collarRow[mapping.column] ?? "");
      }

      if (mapping.datasetKey === "survey" && surveyRows.length) {
        const values = [...new Set(
          surveyRows
            .map((row) => String(row[mapping.column] ?? "").trim())
            .filter(Boolean)
        )];
        if (values.length) {
          const joined = values.join(" | ");
          const type = values.length === 1 ? inferIfcExportType(values[0]) : "IFCTEXT";
          pushPropertyGroup(groups, mapping.propertySetName, mapping.propertyName, joined, type);
        }
      }
    }

    byId[borehole.id] = Object.entries(groups).map(([name, properties]) => ({
      name,
      properties: Object.values(properties)
    })).filter((group) => group.properties.length > 0);
  }

  return byId;
}

function buildIntervalAttributeMappings() {
  return state.attributeMappings
    .filter((mapping) => mapping.enabled && mapping.datasetKey === "interval")
    .map((mapping) => ({
      column: mapping.column,
      propertySetName: String(mapping.propertySetName ?? "").trim() || ATTRIBUTE_DATASET_META.interval.defaultPropertySetName,
      propertyName: sanitizeIfcPropertyName(mapping.propertyName || mapping.column)
    }));
}

// =====================================================================
// STATE
// =====================================================================
const state = {
  projectId: WORKSPACE_PROJECT_ID,
  activeTab: "import",
  attributeMappings: [],
  pendingCollarFilename: "",
  pendingCollarText: "",
  pendingCollarRows: [],
  pendingSurveyFilename: "",
  pendingSurveyText: "",
  pendingSurveyRows: [],
  pendingGeologyRows: [],
  pendingGeologyText: "",
  logColumn: "",
  baseFilteredBoreholes: null,
  viewer3dLogColumn: "",
  ifcColorColumn: "",
  pendingColorMap: null,
  pendingColorFilename: "",
  colorFiles: [],
  collarRows: [],
  surveyRows: [],
  geologyRows: [],
  colorMap: new Map(),
  geologyById: new Map(),
  collarByNormalizedId: new Map(),
  surveyByNormalizedId: new Map(),
  boreholes: [],
  filteredBoreholes: [],
  selectedId: "",
  viewMode: "plan",
  showLabels: true,
  showGrid: true,
  showAll: true,
  loadStatus: {
    collar:   { count: 0, source: null },
    survey:   { count: 0, source: null },
    geology:  { count: 0, source: null },
    colors:   { count: 0, source: null }
  },
  detailLog: {
    zoom: 1,
    panX: 0,
    panY: 0,
    drag: { active: false, moved: false, startX: 0, startY: 0, originPanX: 0, originPanY: 0 },
    hovered: null
  },
  viewer: {
    mode: "select",
    camera: { zoom: 1, panX: 0, panY: 0 },
    measurement: { start: null, end: null, label: "" },
    hoveredTarget: null,
    scene: null,
    hitTargets: [],
    drag: { active: false, moved: false, startX: 0, startY: 0, originPanX: 0, originPanY: 0 }
  }
};

// =====================================================================
// ELEMENT HELPERS
// =====================================================================
const el = (id) => document.getElementById(id);
const qs = (sel) => document.querySelector(sel);
const qsa = (sel) => [...document.querySelectorAll(sel)];

// =====================================================================
// UTILITIES
// =====================================================================
const _fmtCache = new Map();
function fmt(value, digits = 2) {
  if (!_fmtCache.has(digits)) {
    _fmtCache.set(digits, new Intl.NumberFormat("de-DE", {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits
    }));
  }
  return _fmtCache.get(digits).format(value);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hashInt(value) {
  let h = 0;
  for (const ch of String(value)) {
    h = (h << 5) - h + ch.charCodeAt(0);
    h |= 0;
  }
  return Math.abs(h);
}

function setStatus(message, type = "info") {
  const dot    = el("status-dot");
  const txt    = el("status-text");
  const footer = document.querySelector(".sidebar-footer");
  txt.textContent  = message;
  dot.className    = "status-dot";
  if (footer) footer.className = "sidebar-footer";
  if (type === "ok")    { dot.classList.add("is-ok");    footer?.classList.add("is-ok");    }
  if (type === "busy")  { dot.classList.add("is-busy");  footer?.classList.add("is-busy");  }
  if (type === "error") { dot.classList.add("is-error"); footer?.classList.add("is-error"); }
  // Auto-clear ok/busy highlights
  if (type === "ok" || type === "busy") {
    setTimeout(() => { footer?.classList.remove("is-ok", "is-busy"); }, 2500);
  }
}

function collectIntervalColorAssignments(interval) {
  const assignments = [];

  for (const colorFile of state.colorFiles) {
    for (const column of colorFile.columns) {
      const value = String(interval.raw?.[column] ?? "").trim();
      if (!value) continue;

      const color = colorFile.colorMap.get(value);
      if (!color) continue;

      assignments.push({
        filename: colorFile.filename,
        column,
        value,
        css: color.css
      });
    }
  }

  return assignments;
}

function buildProjectDbSnapshot() {
  return {
    projectId: WORKSPACE_PROJECT_ID,
    // generatedAt is assigned at send/save time so that identical data
    // produces an identical sync signature (see project-db.js).
    // Snapshot is consumed read-only (serialized for sync / SQLite save),
    // so the large source arrays can be referenced directly instead of
    // deep-cloned on every change.
    attributeMappings: state.attributeMappings ?? [],
    loadStatus: state.loadStatus,
    collarRows: state.collarRows,
    surveyRows: state.surveyRows,
    geologyRows: state.geologyRows,
    colorFiles: state.colorFiles.map((cf) => ({
      id: cf.id,
      filename: cf.filename,
      columns: [...cf.columns],
      rows: serializeColorMap(cf.colorMap)
    })),
    boreholes: state.boreholes.map((borehole) => {
      const geology = (state.geologyById.get(borehole.normalizedId) ?? []).map((interval) => ({
        boreholeId: interval.boreholeId,
        from: interval.from,
        to: interval.to,
        thickness: interval.thickness,
        subUnit: interval.subUnit,
        unit: interval.unit,
        geologyCode: interval.geologyCode,
        description: interval.description,
        colorAssignments: collectIntervalColorAssignments(interval)
      }));

      return {
        id: borehole.id,
        normalizedId: borehole.normalizedId,
        className: borehole.className,
        collar: borehole.collar,
        totalDepth: borehole.totalDepth,
        stations: borehole.stations,
        points: borehole.points,
        endPoint: borehole.endPoint,
        lateralDisplacement: borehole.lateralDisplacement,
        geology,
        colorAssignments: geology.flatMap((interval) => interval.colorAssignments)
      };
    })
  };
}

function triggerProjectDbSync() {
  scheduleProjectDbSync(buildProjectDbSnapshot());
}

function boreholePathLength(points) {
  let length = 0;
  for (let index = 1; index < (points?.length ?? 0); index += 1) {
    const a = points[index - 1];
    const b = points[index];
    length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return length;
}

function getExportScopeBoreholes(scope) {
  if (scope === "selected") {
    return state.boreholes.filter((bh) => bh.id === state.selectedId);
  }
  if (scope === "filtered") {
    return state.filteredBoreholes.length ? state.filteredBoreholes : state.boreholes;
  }
  return state.boreholes;
}

function getExportIntervalsForBorehole(borehole) {
  return state.geologyById.get(borehole.normalizedId) ?? [];
}

function getAggregatedBoreholeColor(borehole, intervals, colorMode) {
  if (colorMode === "none") return null;

  if (colorMode === "class-color") {
    const css = getIntervalColor(borehole.className || borehole.id, state.logColumn);
    return { mode: colorMode, label: borehole.className || borehole.id, css };
  }

  if (!intervals.length) return null;

  let picked = intervals[0];
  if (colorMode === "dominant-interval") {
    picked = intervals.slice().sort((a, b) => b.thickness - a.thickness)[0];
  }

  const label = getDetailLogIntervalLabel(picked);
  return {
    mode: colorMode,
    label,
    css: getIntervalColor(label, state.logColumn),
    from: picked.from,
    to: picked.to
  };
}

function filterDatasetRowsBySelection(rows, selectedIds, idKeys) {
  if (!selectedIds.size) return [];
  return rows.filter((row) => {
    const rawId = idKeys.map((key) => row[key]).find((value) => value !== undefined && String(value).trim() !== "");
    return rawId && selectedIds.has(normalizeBoreholeId(String(rawId)));
  });
}

function updateExportView() { /* removed — replaced by updateIfcExportStat */ }


function resetProjectState() {
  state.projectId = WORKSPACE_PROJECT_ID;
  state.attributeMappings = [];
  state.collarRows = [];
  state.surveyRows = [];
  state.geologyRows = [];
  state.colorFiles = [];
  state.geologyById = new Map();
  state.collarByNormalizedId = new Map();
  state.surveyByNormalizedId = new Map();
  state.boreholes = [];
  state.filteredBoreholes = [];
  state.selectedId = "";
  state.logColumn = "";
  invalidateColorCache();
  resetDetailLogView();
  state.detailLog.selectedId = "";
  state.detailLog.pointer = null;
  state.loadStatus = {
    collar:  { count: 0, source: null },
    survey:  { count: 0, source: null },
    geology: { count: 0, source: null },
    colors:  { count: 0, source: null }
  };
}

async function persistSnapshotToBrowserCache(snapshot) {
  await saveDataset("collar", snapshot.collarRows ?? [], "project").catch(() => {});
  await saveDataset("survey", snapshot.surveyRows ?? [], "project").catch(() => {});
  await saveDataset("geology", snapshot.geologyRows ?? [], "project").catch(() => {});
  await saveDataset("colorFiles", snapshot.colorFiles ?? [], "project").catch(() => {});
}

async function applyProjectSnapshot(snapshot, sourceLabel = "Projekt") {
  resetProjectDbSyncSignature();
  resetProjectState();
  state.projectId = snapshot.projectId ?? WORKSPACE_PROJECT_ID;
  state.attributeMappings = snapshot.attributeMappings ?? [];

  state.collarRows = snapshot.collarRows ?? [];
  state.surveyRows = snapshot.surveyRows ?? [];
  state.geologyRows = snapshot.geologyRows ?? [];
  state.colorFiles = (snapshot.colorFiles ?? []).map((cf) => ({
    id: cf.id ?? generateColorFileId(),
    filename: cf.filename ?? "",
    columns: cf.columns ?? [],
    colorMap: deserializeColorMap(cf.rows ?? [])
  }));

  state.loadStatus = snapshot.loadStatus ?? {
    collar: { count: state.collarRows.length, source: "project", filename: sourceLabel },
    survey: { count: state.surveyRows.length, source: "project", filename: sourceLabel },
    geology: { count: state.geologyRows.length, source: "project", filename: sourceLabel },
    colors: { count: state.colorFiles.length, source: "project", filename: sourceLabel }
  };

  state.loadStatus.collar = {
    count: state.collarRows.length,
    source: "project",
    filename: sourceLabel
  };
  state.loadStatus.survey = {
    count: state.surveyRows.length,
    source: "project",
    filename: sourceLabel
  };
  state.loadStatus.geology = {
    count: state.geologyRows.length,
    source: "project",
    filename: sourceLabel
  };
  state.loadStatus.colors = {
    count: state.colorFiles.length,
    source: "project",
    filename: sourceLabel
  };

  if (state.geologyRows.length) {
    populateLogColumnSelector(state.geologyRows);
  } else {
    const sel = el("log-color-col");
    if (sel) {
      sel.replaceChildren();
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "— auswählen —";
      sel.append(blank);
    }
    state.logColumn = "";
  }

  await persistSnapshotToBrowserCache(snapshot);
  buildFromState();
  redraw();
}

// =====================================================================
// MODAL DIALOG (promise-based; replaces native prompt)
// =====================================================================
function showModal({ title, message = "", fields = [], confirmLabel = "OK", cancelLabel = "Abbrechen" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "app-modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "app-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h3");
    heading.className = "app-modal-title";
    heading.textContent = title;
    dialog.append(heading);

    if (message) {
      const desc = document.createElement("p");
      desc.className = "app-modal-message";
      desc.textContent = message;
      dialog.append(desc);
    }

    const inputs = new Map();
    for (const field of fields) {
      const wrap = document.createElement("label");
      wrap.className = "app-modal-field";
      if (field.label) {
        const span = document.createElement("span");
        span.textContent = field.label;
        wrap.append(span);
      }

      let input;
      if (field.type === "select") {
        input = document.createElement("select");
        for (const opt of field.options ?? []) {
          const option = document.createElement("option");
          option.value = opt.value;
          option.textContent = opt.label ?? opt.value;
          input.append(option);
        }
        if (field.value != null) input.value = field.value;
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = field.value ?? "";
        if (field.placeholder) input.placeholder = field.placeholder;
      }
      input.className = "app-modal-input";
      inputs.set(field.name, input);
      wrap.append(input);
      dialog.append(wrap);
    }

    const footer = document.createElement("div");
    footer.className = "app-modal-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-secondary";
    cancelBtn.textContent = cancelLabel;
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "btn btn-primary";
    confirmBtn.textContent = confirmLabel;
    footer.append(cancelBtn, confirmBtn);
    dialog.append(footer);

    overlay.append(dialog);
    document.body.append(overlay);

    function close(result) {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    }
    function collect() {
      const out = {};
      for (const [name, input] of inputs) out[name] = String(input.value ?? "").trim();
      return out;
    }
    function onKey(event) {
      if (event.key === "Escape") {
        close(null);
      } else if (event.key === "Enter" && document.activeElement?.tagName !== "SELECT") {
        event.preventDefault();
        close(collect());
      }
    }

    cancelBtn.addEventListener("click", () => close(null));
    confirmBtn.addEventListener("click", () => close(collect()));
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(null); });
    document.addEventListener("keydown", onKey);

    const firstInput = inputs.values().next().value;
    (firstInput ?? confirmBtn).focus();
    if (firstInput?.tagName === "INPUT") firstInput.select?.();
  });
}

async function saveProjectToSQLite() {
  if (!state.collarRows.length && !state.surveyRows.length && !state.geologyRows.length) {
    setStatus("Keine Daten vorhanden, die als Projekt gespeichert werden koennen.", "error");
    return;
  }

  const result = await showModal({
    title: "Projekt speichern",
    message: "Speichert den aktuellen Stand als eigene SQLite-Datei.",
    fields: [{ name: "projectId", type: "text", label: "Projektname", placeholder: "z. B. Baustelle-Nord" }],
    confirmLabel: "Speichern"
  });
  if (!result) return;

  const projectId = result.projectId;
  if (!projectId) return;
  if (projectId === WORKSPACE_PROJECT_ID) {
    setStatus("Dieser Projektname ist reserviert.", "error");
    return;
  }

  try {
    const snapshot = { ...buildProjectDbSnapshot(), projectId };
    await saveNamedProject(snapshot);
    setStatus(`Projekt '${projectId}' in SQLite gespeichert.`, "ok");
  } catch (error) {
    setStatus(`Projekt konnte nicht gespeichert werden: ${error.message}`, "error");
  }
}

async function openProjectFromSQLite() {
  try {
    const listing = await listSavedProjects();
    const projects = listing.projects ?? [];
    if (!projects.length) {
      setStatus("Keine gespeicherten Projekte in SQLite gefunden.", "error");
      return;
    }

    const choice = await showModal({
      title: "Projekt öffnen",
      fields: [{
        name: "projectId",
        type: "select",
        label: "Gespeichertes Projekt",
        value: projects[0]?.projectId,
        options: projects.map((p) => ({ value: p.projectId, label: p.projectId }))
      }],
      confirmLabel: "Öffnen"
    });
    if (!choice || !choice.projectId) return;

    const result = await loadSavedProject(choice.projectId);
    if (!result.snapshot) {
      throw new Error(result.error ?? "Projekt nicht gefunden.");
    }

    await applyProjectSnapshot(result.snapshot, `SQLite-Projekt: ${result.projectId}`);
    setStatus(`Projekt '${result.projectId}' aus SQLite geladen.`, "ok");
  } catch (error) {
    setStatus(`Projekt konnte nicht geladen werden: ${error.message}`, "error");
  }
}

// =====================================================================
// COLOR FILES
// =====================================================================
function generateColorFileId() {
  return `cf-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
}

const _colorCache = new Map();
function invalidateColorCache() { _colorCache.clear(); }

function getIntervalColor(value, logColumn) {
  const cacheKey = `${logColumn ?? ""}|${value ?? ""}`;
  if (_colorCache.has(cacheKey)) return _colorCache.get(cacheKey);

  let result;
  if (!value || value === "—") {
    const hue = hashInt("empty") % 360;
    result = `hsla(${hue},20%,88%,0.6)`;
  } else {
    const entry = findColorEntry(value, logColumn, state.colorFiles);
    if (entry) {
      result = entry.css;
    } else {
      const hue = hashInt(value) % 360;
      result = `hsla(${hue},52%,72%,0.88)`;
    }
  }

  _colorCache.set(cacheKey, result);
  return result;
}

function countColorFileMatches(colorMap, columnName) {
  if (!state.geologyRows.length || !columnName) return 0;
  const values = new Set(
    state.geologyRows.map((r) => String(r[columnName] ?? "").trim()).filter(Boolean)
  );
  let matches = 0;
  for (const v of values) {
    if (colorMap.has(v)) { matches++; continue; }
    for (const key of colorMap.keys()) {
      if (v.length > 2 && (key.includes(v) || v.includes(key))) { matches++; break; }
    }
  }
  return matches;
}

async function saveColorFilesToDB() {
  invalidateColorCache();
  const serialized = state.colorFiles.map((cf) => ({
    id: cf.id,
    filename: cf.filename,
    columns: cf.columns,
    rows: serializeColorMap(cf.colorMap)
  }));
  await saveDataset("colorFiles", serialized, "user").catch(() => {});
}

function updateColorsCard() {
  const badge = el("colors-badge");
  const count = state.colorFiles.length;
  badge.textContent  = `${count} Datei${count !== 1 ? "en" : ""}`;
  badge.className    = "status-badge " + (count > 0 ? "status-ok" : "status-none");
  el("card-colors")?.classList.toggle("is-loaded", count > 0);
  updateColorFilesList();
}

function updateColorFilesList() {
  const list = el("color-files-list");
  list.replaceChildren();

  if (!state.colorFiles.length) {
    const empty = document.createElement("div");
    empty.className = "color-files-empty";
    empty.textContent = "Keine Farb-Dateien geladen";
    list.append(empty);
    return;
  }

  for (const cf of state.colorFiles) {
    const item = document.createElement("div");
    item.className = "color-file-item";

    // Color swatches preview (first 8)
    const swRow = document.createElement("div");
    swRow.className = "cfi-swatch-row";
    let n = 0;
    for (const [, color] of cf.colorMap) {
      if (n++ >= 8) break;
      const sw = document.createElement("span");
      sw.className = "cfi-swatch";
      sw.style.background = color.css;
      swRow.append(sw);
    }
    item.append(swRow);

    const name = document.createElement("span");
    name.className = "cfi-name";
    name.textContent = cf.filename;
    name.title = cf.filename;
    item.append(name);

    const arrow = document.createElement("span");
    arrow.className = "cfi-arrow";
    arrow.textContent = "→";
    item.append(arrow);

    const cols = document.createElement("span");
    cols.className = "cfi-cols";
    cols.textContent = cf.columns.length
      ? cf.columns.join(", ")
      : "Keine Spalten zugewiesen";
    cols.title = cols.textContent;
    item.append(cols);

    const countBadge = document.createElement("span");
    countBadge.className = "status-badge status-cache";
    countBadge.textContent = `${cf.colorMap.size} Farben`;
    item.append(countBadge);

    const removeBtn = document.createElement("button");
    removeBtn.className = "cfi-remove";
    removeBtn.textContent = "×";
    removeBtn.title = `${cf.filename} entfernen`;
    removeBtn.addEventListener("click", async () => {
      state.colorFiles = state.colorFiles.filter((f) => f.id !== cf.id);
      await saveColorFilesToDB();
      triggerProjectDbSync();
      updateColorsCard();
      if (state.activeTab === "detail") updateDetailView();
    });
    item.append(removeBtn);

    list.append(item);
  }
}

function showColorMappingUI(colorMap, filename) {
  state.pendingColorMap      = colorMap;
  state.pendingColorFilename = filename;

  el("colors-mapping-filename").textContent = filename;
  el("colors-mapping-count").textContent    = `${colorMap.size} Farb-Codes`;

  // Swatch preview (first 16)
  const swatches = el("colors-swatches");
  swatches.replaceChildren();
  let n = 0;
  for (const [code, color] of colorMap) {
    if (n++ >= 16) break;
    const sw = document.createElement("div");
    sw.className = "color-swatch-preview";
    sw.style.background = color.css;
    sw.title = code;
    swatches.append(sw);
  }

  // Column checkboxes
  const checks = el("color-col-checks");
  checks.replaceChildren();
  const columns = Object.keys(state.geologyRows[0] ?? {});

  if (!columns.length) {
    checks.innerHTML = '<div class="log-empty">Bitte zuerst eine Intervalltabelle laden.</div>';
  } else {
    for (const col of columns) {
      const matches = countColorFileMatches(colorMap, col);
      const label = document.createElement("label");
      label.className = "color-col-check-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = col;
      cb.checked = matches > 0;
      cb.addEventListener("change", updateColorMappingPreview);
      label.append(cb);

      const nameSpan = document.createElement("span");
      nameSpan.className = "ccb-name";
      nameSpan.textContent = col;
      label.append(nameSpan);

      const matchSpan = document.createElement("span");
      matchSpan.className = "ccb-match" + (matches > 0 ? " is-good" : "");
      matchSpan.textContent = matches > 0 ? `${matches} Treffer` : "keine Treffer";
      label.append(matchSpan);

      checks.append(label);
    }
  }

  updateColorMappingPreview();

  const section = el("colors-mapping-section");
  section.hidden = false;
  setTimeout(() => section.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
}

function updateColorMappingPreview() {
  const checked = [...document.querySelectorAll("#color-col-checks input:checked")];
  const prev    = el("colors-mapping-preview");
  if (!checked.length) {
    prev.textContent = "Bitte mindestens eine Spalte auswählen.";
    prev.className   = "mapping-preview is-warn";
  } else {
    prev.textContent = `${checked.length} Spalte${checked.length > 1 ? "n" : ""} ausgewählt`;
    prev.className   = "mapping-preview is-ok";
  }
}

// =====================================================================
// BOREHOLE LIST (SIDEBAR)
// =====================================================================
function getFilteredBoreholes() {
  const base = state.baseFilteredBoreholes ?? state.boreholes;
  const q    = el("search-input")?.value.trim().toLowerCase() ?? "";
  return q ? base.filter((bh) => bh.id.toLowerCase().includes(q)) : [...base];
}

function syncBoreholeList() {
  state.filteredBoreholes = getFilteredBoreholes();

  if (!state.filteredBoreholes.some((bh) => bh.id === state.selectedId)) {
    state.selectedId = state.filteredBoreholes[0]?.id ?? "";
  }

  const list = el("borehole-list");
  list.replaceChildren();

  if (!state.filteredBoreholes.length) {
    const msg = document.createElement("div");
    msg.className = "bh-empty";
    msg.textContent = state.boreholes.length
      ? "Keine Treffer für aktuelle Suche"
      : "Keine Daten geladen";
    list.append(msg);
    return;
  }

  for (const bh of state.filteredBoreholes) {
    const isSelected = bh.id === state.selectedId;
    const item = document.createElement("div");
    item.className = "bh-item" + (isSelected ? " is-selected" : "");
    item.dataset.id = bh.id;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", isSelected ? "true" : "false");
    item.setAttribute("tabindex", "0");

    const idSpan = document.createElement("span");
    idSpan.className = "bh-item-id";
    idSpan.textContent = bh.id;

    const depthSpan = document.createElement("span");
    depthSpan.className = "bh-item-depth";
    depthSpan.textContent = bh.totalDepth > 0 ? `${fmt(bh.totalDepth, 0)} m` : "";

    item.append(idSpan, depthSpan);

    const selectBh = () => {
      state.selectedId = bh.id;
      redraw();
      if (state.viewMode === "3d" && viewer3d) {
        refresh3DViewer();
        viewer3d.focusBorehole(bh.id);
      }
    };

    item.addEventListener("click", selectBh);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectBh(); }
      if (e.key === "ArrowDown") { e.preventDefault(); item.nextElementSibling?.focus(); }
      if (e.key === "ArrowUp")   { e.preventDefault(); item.previousElementSibling?.focus(); }
    });
    list.append(item);
  }
}

// =====================================================================
// STATS (SIDEBAR)
// =====================================================================
function updateStats() {
  const selected = state.boreholes.find((bh) => bh.id === state.selectedId);
  const totalDepth = state.boreholes.reduce((s, bh) => s + bh.totalDepth, 0);
  const totalStations = state.boreholes.reduce((s, bh) => s + bh.stations.length, 0);
  const withGeology = state.boreholes.filter(
    (bh) => (state.geologyById.get(normalizeBoreholeId(bh.id)) ?? []).length > 0
  ).length;

  const dl = el("dataset-stats");
  dl.replaceChildren();

  const globalEntries = [
    ["Bohrungen", fmt(state.boreholes.length, 0)],
    ["Survey-Punkte", fmt(totalStations, 0)],
    ["Gesamttiefe", `${fmt(totalDepth, 0)} m`],
    ["Mit Geologie", fmt(withGeology, 0)],
    ["Gefiltert", fmt(state.filteredBoreholes.length, 0)]
  ];

  for (const [label, value] of globalEntries) {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    dl.append(dt, dd);
  }

  if (selected) {
    // Section divider
    const divider = document.createElement("div");
    divider.className = "stat-divider";
    dl.append(divider);

    const secLabel = document.createElement("div");
    secLabel.className = "stat-section-label";
    secLabel.textContent = "Ausgewählt";
    dl.append(secLabel);

    const selectedEntries = [
      ["ID", selected.id],
      ["Collar X", fmt(selected.collar.x, 3)],
      ["Collar Y", fmt(selected.collar.y, 3)],
      ["Collar Z", fmt(selected.collar.z, 3)],
      ["Ende Z", fmt(selected.endPoint.z, 3)],
      ["Endtiefe", `${fmt(selected.totalDepth, 1)} m`],
      ["Seitversatz", `${fmt(selected.lateralDisplacement, 2)} m`],
      ["Klasse", selected.className || "—"]
    ];
    for (const [label, value] of selectedEntries) {
      const dt = document.createElement("dt"); dt.textContent = label;
      const dd = document.createElement("dd"); dd.textContent = value;
      dl.append(dt, dd);
    }
  }
}

// =====================================================================
// NAV BADGES + STEP STATES
// =====================================================================
function updateNavBadges() {
  const st = state.loadStatus;
  const hasCollar  = st.collar.count > 0;
  const hasSurvey  = st.survey.count > 0;
  const hasGeo     = st.geology.count > 0;
  const hasBH      = state.boreholes.length > 0;
  const hasSelect  = !!state.selectedId;

  // Step done/active/blocked states
  setNavItemState("import",     true,  (hasCollar || hasSurvey));
  setNavItemState("collar",     hasCollar || hasSurvey,  hasCollar);
  setNavItemState("survey",     hasCollar || hasSurvey,  hasSurvey);
  setNavItemState("interval",   true,  hasGeo);
  setNavItemState("attributes", hasCollar || hasSurvey || hasGeo, state.attributeMappings.some((m) => m.enabled));
  setNavItemState("filter",     hasBH, false);
  setNavItemState("map",        hasBH, hasBH);
  setNavItemState("detail",     hasBH, hasSelect);
  setNavItemState("export",     hasBH, hasBH);

  // Legacy dots — kept for any external references
  setDot("dot-import",   (hasCollar || hasSurvey) ? "is-loaded" : "");
  setDot("dot-collar",   hasCollar  ? "is-loaded" : "");
  setDot("dot-survey",   hasSurvey  ? "is-loaded" : "");
  setDot("dot-interval", hasGeo     ? "is-loaded" : "is-partial");
  setDot("dot-attributes", state.attributeMappings.some((m) => m.enabled) ? "is-loaded" : "");
  setDot("dot-map",     hasBH  ? "is-loaded" : "");
  setDot("dot-detail",  hasSelect ? "is-loaded" : "");
  setDot("dot-export",  hasBH  ? "is-loaded" : "");
}

function setNavItemState(tabName, accessible, done) {
  const item = document.querySelector(`.nav-item[data-tab="${tabName}"]`);
  if (!item) return;
  const isActive = state.activeTab === tabName;
  item.classList.toggle("is-done",    !isActive && done);
  item.classList.toggle("is-blocked", !accessible && !isActive);
  item.setAttribute("aria-disabled", (!accessible && !isActive) ? "true" : "false");
}

function setDot(id, cls) {
  const dot = el(id);
  if (!dot) return;
  dot.className = "nav-dot" + (cls ? " " + cls : "");
}

// =====================================================================
// IMPORT CARDS
// =====================================================================
function updateImportCards() {
  updateCard("collar",  state.loadStatus.collar);
  updateCard("survey",  state.loadStatus.survey);
  updateCard("geology", state.loadStatus.geology);
  updateColorsCard();
}

function updateCard(key, status) {
  const badge  = el(`${key}-badge`);
  const source = el(`${key}-source`);
  const card   = el(`card-${key}`);
  if (!badge) return;

  if (!status.source) {
    badge.textContent = "Nicht geladen";
    badge.className = "status-badge status-none";
    if (source) source.textContent = "";
    card?.classList.remove("is-loaded");
    return;
  }

  const count = status.count;
  const label = key === "colors" ? `${count} Farben` : `${fmt(count, 0)} Zeilen`;

  if (status.source === "default" || status.source === "user") {
    badge.textContent = label;
    badge.className = "status-badge status-ok";
  } else if (status.source === "cache") {
    badge.textContent = `Cache · ${label}`;
    badge.className = "status-badge status-cache";
  }

  if (status.source === "project") {
    badge.textContent = `Projekt · ${label}`;
    badge.className = "status-badge status-ok";
  }

  if (source) source.textContent = status.filename ?? "";
  card?.classList.add("is-loaded");
}

// =====================================================================
// OVERVIEW SECTION (import panel)
// =====================================================================
function updateOverview() {
  const section = el("overview-section");
  if (!section) return;

  if (!state.boreholes.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;

  const depths = state.boreholes.map((bh) => bh.totalDepth);
  const maxDepth = Math.max(...depths);
  const minDepth = Math.min(...depths.filter((d) => d > 0));
  const avgDepth = depths.reduce((s, d) => s + d, 0) / depths.length;
  const withGeo  = state.boreholes.filter(
    (bh) => (state.geologyById.get(normalizeBoreholeId(bh.id)) ?? []).length > 0
  ).length;

  const kpis = el("overview-kpis");
  kpis.replaceChildren();

  const kpiData = [
    { val: fmt(state.boreholes.length, 0), lbl: "Bohrungen gesamt" },
    { val: `${fmt(maxDepth, 1)} m`,         lbl: "Max. Tiefe" },
    { val: `${fmt(avgDepth, 1)} m`,         lbl: "Mittl. Tiefe" },
    { val: fmt(state.geologyRows.length, 0), lbl: "Geol. Intervalle" },
    { val: `${fmt(withGeo, 0)}`,             lbl: "Mit Geologie" }
  ];

  for (const { val, lbl } of kpiData) {
    const card = document.createElement("div");
    card.className = "kpi-card";
    card.innerHTML = `<div class="kpi-value">${esc(val)}</div><div class="kpi-label">${esc(lbl)}</div>`;
    kpis.append(card);
  }

  // Quality pills
  const quality = el("overview-quality");
  quality.replaceChildren();

  const geoPercent = state.boreholes.length
    ? Math.round((withGeo / state.boreholes.length) * 100)
    : 0;

  const pills = [
    { label: `${geoPercent}% mit Geologie`, color: geoPercent > 50 ? "#107C10" : "#9D5D00" },
    { label: `${state.loadStatus.colors.count} Einheiten farbcodiert`, color: state.loadStatus.colors.count > 0 ? "#0078D4" : "#A19F9D" }
  ];

  for (const { label, color } of pills) {
    const pill = document.createElement("div");
    pill.className = "quality-pill";
    pill.innerHTML = `<span class="pill-dot" style="background:${color}"></span>${esc(label)}`;
    quality.append(pill);
  }
}

// =====================================================================
// TABLE RENDERING
// =====================================================================
function renderTable(tableEl, rows, countEl, visibleEl, preferredCols = [], filter = "") {
  tableEl.replaceChildren();

  if (!rows.length) {
    if (countEl)   countEl.textContent = "0 Zeilen";
    if (visibleEl) visibleEl.textContent = "0 sichtbar";
    tableEl.innerHTML = `<tbody><tr><td class="td-empty">Keine Daten vorhanden.</td></tr></tbody>`;
    return;
  }

  const q = filter.toLowerCase();
  const filtered = q
    ? rows.filter((row) => Object.values(row).some((v) => String(v ?? "").toLowerCase().includes(q)))
    : rows;

  if (countEl)   countEl.textContent = `${fmt(rows.length, 0)} Zeilen`;
  if (visibleEl) visibleEl.textContent = `${fmt(Math.min(filtered.length, 500), 0)} sichtbar`;

  const allCols = Object.keys(rows[0] ?? {});
  const cols = [
    ...preferredCols.filter((c) => allCols.includes(c)),
    ...allCols.filter((c) => !preferredCols.includes(c))
  ];

  const limited = filtered.slice(0, 500);

  const thead = `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>`;
  const tbody = limited.map((row) => {
    const cells = cols.map((c) => {
      const v = esc(row[c] ?? "");
      const cls = c === "BHID" || c === "Location ID" ? ' class="td-bhid"' : "";
      return `<td${cls}>${v}</td>`;
    }).join("");
    return `<tr data-bhid="${esc(row["BHID"] ?? row["Location ID"] ?? "")}">${cells}</tr>`;
  }).join("");

  tableEl.innerHTML = `${thead}<tbody>${tbody}</tbody>`;

  // Make rows clickable → select borehole
  for (const tr of tableEl.querySelectorAll("tbody tr")) {
    const bhid = tr.dataset.bhid;
    if (!bhid) continue;
    tr.addEventListener("click", () => {
      const normalized = normalizeBoreholeId(bhid);
      const bh = state.boreholes.find((b) => b.normalizedId === normalized);
      if (bh) {
        state.selectedId = bh.id;
        redraw();
      }
    });
  }
}

function renderDetailTable(tableEl, rows, preferredCols = [], emptyMsg = "Keine Daten vorhanden.") {
  tableEl.replaceChildren();

  if (!rows.length) {
    tableEl.innerHTML = `<tbody><tr><td class="td-empty">${esc(emptyMsg)}</td></tr></tbody>`;
    return;
  }

  const allCols = Object.keys(rows[0] ?? {});
  const cols = [
    ...preferredCols.filter((c) => allCols.includes(c)),
    ...allCols.filter((c) => !preferredCols.includes(c))
  ];

  const thead = `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>`;
  const tbody = rows.map((row) =>
    `<tr>${cols.map((c) => `<td>${esc(row[c] ?? "")}</td>`).join("")}</tr>`
  ).join("");

  tableEl.innerHTML = `${thead}<tbody>${tbody}</tbody>`;
}

// =====================================================================
// TABLE FILTERING HELPERS
// =====================================================================
function getTableRows(rows, idKeys, showAll) {
  if (showAll || !state.selectedId) return rows;
  return rows.filter((row) => {
    const rowId = idKeys.map((k) => row[k]).find((v) => v !== undefined && String(v).trim() !== "");
    return !rowId || normalizeBoreholeId(String(rowId)) === state.selectedId;
  });
}

// =====================================================================
// GEOLOGICAL LOG (DETAIL PANEL)
// =====================================================================
function populateLogColumnSelector(rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);

  // Shared helper: fill a column select with headers
  const _skipDepthCols = new Set([
    "Location ID", "BHID", "Hole ID", "BH_ID",
    "Depth Top", "Depth Base", "From", "To", "Top", "Base"
  ]);
  function fillColSelect(sel, stateKey, blankLabel) {
    if (!sel) return;
    // Reset stale value if the stored column no longer exists in the new headers
    if (state[stateKey] && !headers.includes(state[stateKey])) {
      state[stateKey] = "";
    }
    const current = state[stateKey];
    sel.replaceChildren();
    const blank = document.createElement("option");
    blank.value = ""; blank.textContent = blankLabel;
    sel.append(blank);
    for (const h of headers) {
      const opt = document.createElement("option");
      opt.value = h; opt.textContent = h;
      if (h === current) opt.selected = true;
      sel.append(opt);
    }
    if (!current) {
      const preferred = ["Geol_SubUnit_VASYD", "Geol_Units_VASYD", "Geology Code", "Unit", "SubUnit", "Code"];
      const auto = preferred.find((p) => headers.includes(p))
        ?? headers.find((h) => !_skipDepthCols.has(h))
        ?? "";
      sel.value = auto;
      state[stateKey] = auto;
    }
  }

  fillColSelect(el("log-color-col"),   "logColumn",        "— auswählen —");
  fillColSelect(el("viewer-3d-col"),   "viewer3dLogColumn","— keine —");
  fillColSelect(el("ifc-color-col"),   "ifcColorColumn",   "— keine —");
}

function resetDetailLogView() {
  state.detailLog.zoom = 1;
  state.detailLog.panX = 0;
  state.detailLog.panY = 0;
  state.detailLog.hovered = null;
}

function zoomDetailLog(factor) {
  state.detailLog.zoom = Math.min(12, Math.max(0.35, state.detailLog.zoom * factor));
}

function getDetailLogCanvasPoint(event) {
  const canvas = el("geo-log-canvas");
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function getDetailLogIntervalLabel(interval) {
  const col = state.logColumn;
  return col
    ? String(interval.raw?.[col] ?? interval.raw?.[Object.keys(interval.raw ?? {}).find((k) => k === col)] ?? "—")
    : (interval.subUnit || interval.unit || "—");
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function renderDetailLogCanvas(intervals, totalDepth) {
  const container = el("geo-log");
  const canvas = el("geo-log-canvas");
  const readout = el("detail-log-readout");
  if (!container || !canvas || !readout) return;

  const rect = container.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || container.clientWidth || 320));
  const height = Math.max(320, Math.floor(rect.height || container.clientHeight || 320));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  if (!intervals.length || totalDepth <= 0) {
    const text = intervals.length === 0 ? "Keine Intervalle für diese Bohrung." : "Bohrtiefe unbekannt.";
    readout.textContent = text;
    ctx.fillStyle = "#605E5C";
    ctx.font = "12px Segoe UI";
    ctx.fillText(text, 18, 28);
    return;
  }

  const paddingTop = 18;
  const paddingBottom = 22;
  const scaleWidth = 82;
  const trackGap = 16;
  const barWidth = Math.max(180, width - scaleWidth - trackGap - 28);
  const barX = scaleWidth + trackGap + state.detailLog.panX;
  const baseScale = Math.max(0.1, (height - paddingTop - paddingBottom) / totalDepth);
  const ppm = baseScale * state.detailLog.zoom;
  const toScreenY = (depth) => paddingTop + state.detailLog.panY + (depth * ppm);

  ctx.fillStyle = "#F4F2EF";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(Math.max(scaleWidth, barX - 10), 0, Math.max(120, barWidth + 20), height);

  ctx.strokeStyle = "#D2D0CE";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(scaleWidth - 12, paddingTop - 10);
  ctx.lineTo(scaleWidth - 12, height - paddingBottom + 8);
  ctx.stroke();

  const step = totalDepth > 300 ? 25 : totalDepth > 100 ? 10 : totalDepth > 50 ? 5 : 2;
  ctx.font = "11px Segoe UI";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  state.detailLog.hovered = null;
  for (let d = 0; d <= totalDepth + step * 0.5; d += step) {
    const actual = Math.min(d, totalDepth);
    const y = toScreenY(actual);
    if (y < -20 || y > height + 20) continue;
    ctx.strokeStyle = "#E1DFDD";
    ctx.beginPath();
    ctx.moveTo(scaleWidth - 18, y);
    ctx.lineTo(width - 10, y);
    ctx.stroke();
    ctx.fillStyle = "#605E5C";
    ctx.fillText(`${fmt(actual, 0)} m`, scaleWidth - 24, y);
  }

  for (const iv of intervals) {
    const label = getDetailLogIntervalLabel(iv);
    const y = toScreenY(iv.from);
    const h = Math.max(18, iv.thickness * ppm);
    if (y > height || y + h < 0) continue;

    drawRoundedRect(ctx, barX, y, barWidth, h, 6);
    ctx.fillStyle = getIntervalColor(label, state.logColumn);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.stroke();

    const hovered = state.detailLog.pointer &&
      state.detailLog.pointer.x >= barX &&
      state.detailLog.pointer.x <= barX + barWidth &&
      state.detailLog.pointer.y >= y &&
      state.detailLog.pointer.y <= y + h;

    ctx.save();
    ctx.beginPath();
    ctx.rect(barX + 8, y + 4, Math.max(20, barWidth - 16), Math.max(10, h - 8));
    ctx.clip();
    ctx.fillStyle = "#1F1F1F";
    ctx.font = "bold 12px Segoe UI";
    ctx.textAlign = "left";
    ctx.fillText(label, barX + 10, y + 14);
    ctx.font = "11px Segoe UI";
    ctx.fillText(`${fmt(iv.from, 1)} - ${fmt(iv.to, 1)} m`, barX + 10, y + 29);
    ctx.restore();

    if (hovered) {
      state.detailLog.hovered = { interval: iv, label };
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 2;
      drawRoundedRect(ctx, barX, y, barWidth, h, 6);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  if (state.detailLog.hovered) {
    const iv = state.detailLog.hovered.interval;
    readout.textContent = `${state.detailLog.hovered.label} · ${fmt(iv.from, 2)} bis ${fmt(iv.to, 2)} m${iv.description ? ` · ${iv.description}` : ""}`;
  } else {
    readout.textContent = `Zoom ${fmt(state.detailLog.zoom, 2)}x · Mausrad: Zoom · Ziehen: Verschieben`;
  }
}

// =====================================================================
// DETAIL VIEW
// =====================================================================
function updateDetailView() {
  const selected = state.boreholes.find((bh) => bh.id === state.selectedId);
  const intervals = state.geologyById.get(normalizeBoreholeId(state.selectedId)) ?? [];

  const bhid = el("detail-bhid");
  const kpiRow = el("detail-kpis");

  if (!selected) {
    bhid.textContent = "—";
    kpiRow.replaceChildren();
    el("detail-stats").replaceChildren();
    renderDetailLogCanvas([], 0);
    renderDetailTable(el("detail-survey-table"), [], [], "Keine Survey-Punkte.");
    renderDetailTable(el("detail-geology-table"), [], [], "Keine Geologie.");
    return;
  }

  if (state.detailLog.selectedId !== selected.id) {
    resetDetailLogView();
    state.detailLog.selectedId = selected.id;
  }

  bhid.textContent = selected.id;

  // KPI chips
  kpiRow.replaceChildren();
  [
    { val: `${fmt(selected.totalDepth, 1)} m`, lbl: "Endtiefe" },
    { val: fmt(selected.stations.length, 0),   lbl: "Survey-Punkte" },
    { val: fmt(intervals.length, 0),            lbl: "Intervalle" },
    { val: `${fmt(selected.lateralDisplacement, 2)} m`, lbl: "Seitversatz" }
  ].forEach(({ val, lbl }) => {
    const chip = document.createElement("div");
    chip.className = "kpi-chip";
    chip.innerHTML = `<div class="val">${esc(val)}</div><div class="lbl">${esc(lbl)}</div>`;
    kpiRow.append(chip);
  });

  // Stammdaten
  const dl = el("detail-stats");
  dl.replaceChildren();
  const entries = [
    ["BHID",        selected.id],
    ["Klasse",      selected.className || "—"],
    ["Collar X",    fmt(selected.collar.x, 3)],
    ["Collar Y",    fmt(selected.collar.y, 3)],
    ["Collar Z",    fmt(selected.collar.z, 3)],
    ["Ende Z",      fmt(selected.endPoint.z, 3)],
    ["Endtiefe",    `${fmt(selected.totalDepth, 1)} m`],
    ["Seitversatz", `${fmt(selected.lateralDisplacement, 2)} m`]
  ];
  for (const [label, val] of entries) {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = val;
    dl.append(dt, dd);
  }

  // Geological log
  renderDetailLogCanvas(intervals, selected.totalDepth);

  // Survey table
  const surveyRows = selected.stations.map((s) => ({
    "MD (m)":     fmt(s.at, 2),
    "Dip (°)":    fmt(s.dip, 2),
    "Azimut (°)": fmt(s.az, 2)
  }));
  renderDetailTable(
    el("detail-survey-table"),
    surveyRows,
    ["MD (m)", "Dip (°)", "Azimut (°)"],
    "Keine Survey-Punkte vorhanden."
  );

  // Geology table - dynamic: formatted depth fields first, then all raw columns
  const _skipGeoKeys = new Set([
    "Location ID", "BHID", "Hole ID", "BH_ID",
    "Depth Top", "Depth Base", "From", "To", "Top", "Base"
  ]);
  const geoRows = intervals.map((iv) => {
    const row = {
      "Von (m)":     fmt(iv.from, 2),
      "Bis (m)":     fmt(iv.to, 2),
      "Mächtigkeit": fmt(iv.thickness, 2)
    };
    for (const [k, v] of Object.entries(iv.raw ?? {})) {
      if (!_skipGeoKeys.has(k)) row[k] = v;
    }
    return row;
  });
  renderDetailTable(
    el("detail-geology-table"),
    geoRows,
    ["Von (m)", "Bis (m)", "Mächtigkeit"],
    "Keine geologischen Intervalle vorhanden."
  );

  // Detail trajectory canvas
  const detailCanvas = el("detail-canvas");
  renderCanvas(detailCanvas, {
    filteredBoreholes: [selected],
    selectedId: selected.id,
    viewMode: "profile",
    showAll: false,
    showLabels: true,
    showGrid: true,
    viewer: {
      camera: { zoom: 1, panX: 0, panY: 0 },
      measurement: { start: null, end: null, label: "" },
      hoveredTarget: null
    }
  });
}

function handleDetailLogDown(e) {
  const p = getDetailLogCanvasPoint(e);
  state.detailLog.pointer = p;
  state.detailLog.drag = {
    active: true,
    moved: false,
    startX: p.x,
    startY: p.y,
    originPanX: state.detailLog.panX,
    originPanY: state.detailLog.panY
  };
  el("geo-log-canvas")?.classList.add("is-dragging");
}

let _detailLogMoveRafPending = false;
let _detailLogMoveLastEvent = null;

function handleDetailLogMove(e) {
  _detailLogMoveLastEvent = e;
  if (_detailLogMoveRafPending) return;
  _detailLogMoveRafPending = true;
  requestAnimationFrame(() => {
    _detailLogMoveRafPending = false;
    const ev = _detailLogMoveLastEvent;
    if (!ev) return;
    const p = getDetailLogCanvasPoint(ev);
    state.detailLog.pointer = p;
    if (state.detailLog.drag.active) {
      const dx = p.x - state.detailLog.drag.startX;
      const dy = p.y - state.detailLog.drag.startY;
      state.detailLog.panX = state.detailLog.drag.originPanX + dx;
      state.detailLog.panY = state.detailLog.drag.originPanY + dy;
      state.detailLog.drag.moved = Math.abs(dx) > 2 || Math.abs(dy) > 2;
    }
    if (state.activeTab === "detail") updateDetailView();
  });
}

function handleDetailLogUp() {
  state.detailLog.drag.active = false;
  el("geo-log-canvas")?.classList.remove("is-dragging");
}

function handleDetailLogWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.9;
  zoomDetailLog(factor);
  if (state.activeTab === "detail") updateDetailView();
}

// =====================================================================
// TABS
// =====================================================================
const TAB_DESCS = {
  import:   "Lade Collar, Survey, Geologie und Farben.",
  collar:   "Bohransatzpunkte mit Koordinaten und Endtiefe prüfen.",
  survey:   "Survey-Messpunkte je Bohrung prüfen.",
  geology:  "Geologische Schichtintervalle prüfen.",
  attributes: "Importierte Spalten auf IFC-PropertySets mappen.",
  map:      "Bohrloch-Positionen und Trajektorien in der Karte.",
  detail:   "Detailansicht einer einzelnen Bohrung.",
  export:   "JSON Export fuer die spaetere IFC-Modellierung."
};

function setActiveTab(tab) {
  state.activeTab = tab;
  state.viewMode = normalizeMapViewMode(state.viewMode);

  qsa(".nav-item").forEach((item) => {
    const active = item.dataset.tab === tab;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", active ? "true" : "false");
    item.setAttribute("tabindex", active ? "0" : "-1");
  });

  qsa(".panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === tab);
  });

  redraw();
}

// =====================================================================
// CANVAS / VIEWER
// =====================================================================
function resetCamera() {
  state.viewer.camera = { zoom: 1, panX: 0, panY: 0 };
}

function updateViewerReadout() {
  const meas = state.viewer.measurement;
  const measEl = el("viewer-measurement");
  measEl.textContent = meas.label ? `Messung: ${meas.label}` : "";
}

function getCanvasPoint(event) {
  const canvas = el("viewer-canvas");
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function normalizeMapViewMode(mode) {
  return mode === "section" || mode === "isometric" || mode === "profile" ? "plan" : mode;
}

function findNearestTarget(point) {
  let nearest = null;
  for (const t of state.viewer.hitTargets) {
    const dist = Math.hypot(point.x - t.x, point.y - t.y);
    if (dist <= t.radius && (!nearest || dist < nearest.dist)) {
      nearest = { ...t, dist };
    }
  }
  return nearest;
}

function formatMeasurement(start, end) {
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const prefix = state.viewMode === "plan" ? "XY" : "Schnitt";
  return `${prefix} ${fmt(dist, 2)} m`;
}

function updateMeasurement(point) {
  if (!state.viewer.scene) return;
  const proj = state.viewer.scene.screenToProjected(point);
  const meas = state.viewer.measurement;
  if (!meas.start || meas.label) {
    state.viewer.measurement = { start: proj, end: proj, label: "" };
    return;
  }
  state.viewer.measurement = {
    start: meas.start,
    end: proj,
    label: formatMeasurement(meas.start, proj)
  };
}

// =====================================================================
// MAIN REDRAW
// =====================================================================
let _redrawScheduled = false;
let _canvasOnlyScheduled = false;

function _renderMapCanvas() {
  if (state.activeTab !== "map") return;
  const canvas = el("viewer-canvas");
  const renderState = renderCanvas(canvas, {
    filteredBoreholes: state.filteredBoreholes,
    selectedId: state.selectedId,
    viewMode: state.viewMode,
    showAll: state.showAll,
    showLabels: state.showLabels,
    showGrid: state.showGrid,
    viewer: state.viewer
  });
  state.viewer.hitTargets = renderState?.hitTargets ?? [];
  state.viewer.scene = renderState?.scene ?? null;
  updateViewerReadout();
  if (typeof updatePlanLegend === "function") updatePlanLegend();
}

// Lightweight redraw: only re-renders the map canvas, skips all DOM/sidebar updates.
// Used for hover and pan changes so the full sidebar doesn't rebuild on every mousemove.
function redrawCanvasOnly() {
  if (_redrawScheduled) return; // full redraw already queued, it covers this
  if (_canvasOnlyScheduled) return;
  _canvasOnlyScheduled = true;
  requestAnimationFrame(() => {
    _canvasOnlyScheduled = false;
    _renderMapCanvas();
  });
}

function redraw() {
  if (_redrawScheduled) return;
  _redrawScheduled = true;
  _canvasOnlyScheduled = false; // full redraw supersedes canvas-only
  requestAnimationFrame(_doRedraw);
}

function _doRedraw() {
  _redrawScheduled = false;
  state.viewMode = normalizeMapViewMode(state.viewMode);
  syncBoreholeList();
  updateStats();
  updateNavBadges();
  updateImportCards();
  updateOverview();

  updateTableHighlights();

  if (state.activeTab === "map") {
    _renderMapCanvas();
  }

  if (state.activeTab === "detail") {
    updateDetailView();
  }

  if (state.activeTab === "attributes") {
    updateAttributePanel();
  }

  if (state.activeTab === "export") {
    updateExportView();
  }

  if (state.activeTab === "collar") updateCollarTable();
  if (state.activeTab === "survey") updateSurveyTable();
  if (state.activeTab === "interval") updateGeologyTable();
}

let _lastHighlightedId = null;
function updateTableHighlights() {
  if (state.selectedId === _lastHighlightedId) return;
  _lastHighlightedId = state.selectedId;
  const tableIds = ["collar-table", "survey-table", "geology-table"];
  for (const id of tableIds) {
    const table = el(id);
    if (!table) continue;
    for (const tr of table.querySelectorAll("tbody tr[data-bhid]")) {
      const rowId = normalizeBoreholeId(tr.dataset.bhid);
      tr.classList.toggle("is-selected", rowId === state.selectedId);
    }
  }
}

// =====================================================================
// TABLE UPDATERS (per panel)
// =====================================================================
function updateCollarTable() {
  const showAll = el("collar-show-all")?.checked ?? true;
  const filter  = el("collar-filter")?.value ?? "";
  const rows    = getTableRows(state.collarRows, ["BHID"], showAll);
  renderTable(
    el("collar-table"),
    rows,
    el("collar-row-count"),
    el("collar-visible-count"),
    ["BHID", "x", "y", "z", "depth", "class", "Date", "Kommentar"],
    filter
  );
}

function updateSurveyTable() {
  const showAll = el("survey-show-all")?.checked ?? true;
  const filter  = el("survey-filter")?.value ?? "";
  const rows    = getTableRows(state.surveyRows, ["BHID"], showAll);
  renderTable(
    el("survey-table"),
    rows,
    el("survey-row-count"),
    el("survey-visible-count"),
    ["BHID", "at", "dip", "az"],
    filter
  );
}

function updateGeologyTable() {
  const showAll = el("geology-show-all")?.checked ?? true;
  const filter  = el("geology-filter")?.value ?? "";
  const rows    = getTableRows(state.geologyRows, ["Location ID", "BHID"], showAll);
  renderTable(
    el("geology-table"),
    rows,
    el("geology-row-count"),
    el("geology-visible-count"),
    ["Location ID", "Depth Top", "Depth Base", "Geol_SubUnit_VASYD", "Geol_Units_VASYD", "Geology Code", "Description"],
    filter
  );
}

// =====================================================================
// DATA LOADING
// =====================================================================
function buildFromState() {
  const geoIndex = buildGeologyIndex(state.geologyRows);
  state.geologyById = geoIndex.byId;
  state.boreholes = buildBoreholes(state.collarRows, state.surveyRows);
  state.collarByNormalizedId = new Map(
    state.collarRows.map((row) => [
      normalizeBoreholeId(row.BHID ?? row["Location ID"] ?? ""),
      row
    ])
  );

  const surveyIndex = new Map();
  for (const row of state.surveyRows) {
    const key = normalizeBoreholeId(row.BHID ?? row["Location ID"] ?? "");
    if (!key) continue;
    const arr = surveyIndex.get(key) ?? [];
    arr.push(row);
    surveyIndex.set(key, arr);
  }
  state.surveyByNormalizedId = surveyIndex;

  invalidateColorCache();
  syncAttributeMappings();
  if (!state.boreholes.some((bh) => bh.id === state.selectedId)) {
    state.selectedId = state.boreholes[0]?.id ?? "";
  }
  resetCamera();
  state.viewer.measurement = { start: null, end: null, label: "" };
  triggerProjectDbSync();
}

async function applyCollar(rows, source, filename = "") {
  state.collarRows = rows;
  state.loadStatus.collar = { count: rows.length, source, filename };
  await saveDataset("collar", rows, source).catch(() => {});
}

async function applySurvey(rows, source, filename = "") {
  state.surveyRows = rows;
  state.loadStatus.survey = { count: rows.length, source, filename };
  await saveDataset("survey", rows, source).catch(() => {});
}

async function applyGeology(rows, source, filename = "") {
  state.geologyRows = rows;
  state.loadStatus.geology = { count: rows.length, source, filename };
  await saveDataset("geology", rows, source).catch(() => {});
  populateLogColumnSelector(rows);
}

// (applyColors replaced by showColorMappingUI + applyColorFileAndSave flow)

// =====================================================================
// LOAD DEFAULTS (from /input data/)
// =====================================================================
async function loadDefaults() {
  setStatus("Lade Standarddateien...", "busy");

  try {
    const [collarRes, surveyRes, geoRes, colorRes] = await Promise.all([
      fetch("./input%20data/220111_collar.csv"),
      fetch("./input%20data/220111_survey.csv"),
      fetch("./input%20data/260422_GeologicalDescription.csv"),
      fetch("./input%20data/GeoSubUnits_VASYD.lfc")
    ]);

    if (!collarRes.ok || !surveyRes.ok) {
      throw new Error("Collar oder Survey nicht erreichbar.");
    }

    const [collarText, surveyText] = await Promise.all([
      collarRes.text(),
      surveyRes.text()
    ]);

    const collarRaw = parseCsv(collarText);
    const collarMapping = autoDetectCollarMapping(Object.keys(collarRaw[0] ?? {}));
    await applyCollar(applyCollarMapping(collarRaw, collarMapping), "default", "220111_collar.csv");
    const surveyRaw = parseCsv(surveyText);
    const surveyMapping = autoDetectSurveyMapping(Object.keys(surveyRaw[0] ?? {}));
    await applySurvey(applySurveyMapping(surveyRaw, surveyMapping), "default", "220111_survey.csv");

    if (geoRes.ok) {
      const geoText = await geoRes.text();
      const geoRaw  = parseCsv(geoText, { delimiter: ";" });
      const geoMapping = autoDetectGeologyMapping(Object.keys(geoRaw[0] ?? {}));
      await applyGeology(applyGeologyMapping(geoRaw, geoMapping), "default", "260422_GeologicalDescription.csv");
    }

    if (colorRes.ok) {
      const colorText  = await colorRes.text();
      const cmap       = parseLfcColors(colorText);
      const geoHeaders = Object.keys(state.geologyRows[0] ?? {});
      const autoCols   = ["Geol_SubUnit_VASYD", "Geol_Units_VASYD"].filter((c) => geoHeaders.includes(c));
      const colorFile  = {
        id: generateColorFileId(),
        filename: "GeoSubUnits_VASYD.lfc",
        columns: autoCols,
        colorMap: cmap
      };
      state.colorFiles = [colorFile];
      await saveColorFilesToDB();
    }

    buildFromState();
    redraw();
    setStatus(
      `${state.boreholes.length} Bohrungen geladen · ${state.geologyRows.length} Intervall-Zeilen · ${state.colorFiles.length} Color File${state.colorFiles.length !== 1 ? "s" : ""}`,
      "ok"
    );
  } catch (err) {
    setStatus(`Fehler: ${err.message}`, "error");
    console.error(err);
  }
}

// =====================================================================
// LOAD FROM CACHE (IndexedDB)
// =====================================================================
async function initFromCache() {
  setStatus("Lade Daten aus Cache...", "busy");

  try {
    const workspace = await loadWorkspaceProject();
    if (workspace?.snapshot) {
      await applyProjectSnapshot(workspace.snapshot, "SQLite-Arbeitsstand");
      setStatus(
        `SQLite: ${state.boreholes.length} Bohrungen · ${state.geologyRows.length} Geol.-Zeilen`,
        "ok"
      );
      return;
    }
  } catch {
    // Fallback to browser cache below
  }

  const cached = await loadAllCached();

  if (!cached.collar && !cached.survey) {
    setStatus("Keine zwischengespeicherten Daten. Bitte Dateien laden.", "");
    triggerProjectDbSync();
    redraw();
    return;
  }

  if (cached.collar?.rows?.length) {
    state.collarRows = cached.collar.rows;
    state.loadStatus.collar = {
      count: cached.collar.rows.length,
      source: "cache",
      filename: cached.collar.source === "default" ? "Standarddaten" : "Cache"
    };
  }

  if (cached.survey?.rows?.length) {
    state.surveyRows = cached.survey.rows;
    state.loadStatus.survey = {
      count: cached.survey.rows.length,
      source: "cache",
      filename: cached.survey.source === "default" ? "Standarddaten" : "Cache"
    };
  }

  if (cached.geology?.rows?.length) {
    state.geologyRows = cached.geology.rows;
    state.loadStatus.geology = {
      count: cached.geology.rows.length,
      source: "cache",
      filename: cached.geology.source === "default" ? "Standarddaten" : "Cache"
    };
    populateLogColumnSelector(cached.geology.rows);
  }

  if (cached.colorFiles?.rows?.length) {
    state.colorFiles = cached.colorFiles.rows.map((cf) => ({
      id: cf.id ?? generateColorFileId(),
      filename: cf.filename ?? "",
      columns: cf.columns ?? [],
      colorMap: deserializeColorMap(cf.rows ?? [])
    }));
  }

  if (state.collarRows.length || state.surveyRows.length) {
    buildFromState();
    setStatus(
      `Cache: ${state.boreholes.length} Bohrungen · ${state.geologyRows.length} Geol.-Zeilen`,
      "ok"
    );
  } else {
    setStatus("Keine Daten gefunden. Bitte Dateien importieren.", "");
  }

  redraw();
}

// =====================================================================
// CLEAR DATA
// =====================================================================
async function clearData() {
  await clearAll().catch(() => {});
  resetProjectDbSyncSignature();
  state.projectId = WORKSPACE_PROJECT_ID;
  state.collarRows   = [];
  state.surveyRows   = [];
  state.geologyRows  = [];
  state.colorFiles              = [];
  state.baseFilteredBoreholes   = null;
  state.geologyById             = new Map();
  state.collarByNormalizedId    = new Map();
  state.surveyByNormalizedId    = new Map();
  state.boreholes    = [];
  state.filteredBoreholes = [];
  state.selectedId   = "";
  state.logColumn    = "";
  invalidateColorCache();
  resetDetailLogView();
  state.detailLog.selectedId = "";
  state.detailLog.pointer = null;
  state.loadStatus   = {
    collar:  { count: 0, source: null },
    survey:  { count: 0, source: null },
    geology: { count: 0, source: null },
    colors:  { count: 0, source: null }
  };
  resetCamera();
  triggerProjectDbSync();
  redraw();
  setStatus("Alle Daten zurückgesetzt.", "");
}

// =====================================================================
// CANVAS EVENT HANDLERS
// =====================================================================
function handleCanvasDown(e) {
  if (!state.viewer.scene) return;
  const p = getCanvasPoint(e);
  state.viewer.drag = { active: true, moved: false, startX: p.x, startY: p.y, originPanX: state.viewer.camera.panX, originPanY: state.viewer.camera.panY };
}

let _canvasMoveRafPending = false;
let _canvasMoveLastEvent = null;

function handleCanvasMove(e) {
  _canvasMoveLastEvent = e;
  if (_canvasMoveRafPending) return;
  _canvasMoveRafPending = true;
  requestAnimationFrame(() => {
    _canvasMoveRafPending = false;
    const ev = _canvasMoveLastEvent;
    if (!ev) return;
    const p = getCanvasPoint(ev);
    if (state.viewer.drag.active) {
      const dx = p.x - state.viewer.drag.startX;
      const dy = p.y - state.viewer.drag.startY;
      state.viewer.camera.panX = state.viewer.drag.originPanX + dx;
      state.viewer.camera.panY = state.viewer.drag.originPanY + dy;
      state.viewer.drag.moved = Math.abs(dx) > 3 || Math.abs(dy) > 3;
      redrawCanvasOnly();
      return;
    }
    const prevHoverId = state.viewer.hoveredTarget?.id ?? null;
    state.viewer.hoveredTarget = findNearestTarget(p);
    const newHoverId = state.viewer.hoveredTarget?.id ?? null;
    if (state.viewer.mode === "measure" && state.viewer.measurement.start) {
      updateMeasurement(p);
      redrawCanvasOnly();
    } else if (prevHoverId !== newHoverId) {
      redrawCanvasOnly();
    }
  });
}

function handleCanvasUp(e) {
  if (!state.viewer.scene) return;
  const p = getCanvasPoint(e);
  const dragged = state.viewer.drag.moved;
  state.viewer.drag.active = false;
  if (dragged) { redraw(); return; }

  if (state.viewer.mode === "measure") {
    updateMeasurement(p);
    if (state.viewer.measurement.start && state.viewer.measurement.end) {
      state.viewer.measurement.label = formatMeasurement(
        state.viewer.measurement.start,
        state.viewer.measurement.end
      );
    }
    redraw();
    return;
  }

  const nearest = findNearestTarget(p);
  if (nearest?.id) {
    state.selectedId = nearest.id;
    redraw();
  }
}

function handleCanvasWheel(e) {
  if (!state.viewer.scene) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.9;
  const cam = state.viewer.camera;
  const prev = cam.zoom;
  const next = Math.min(12, Math.max(0.25, prev * factor));
  const p = getCanvasPoint(e);
  const canvas = el("viewer-canvas");
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  const bx = cx + (p.x - cx - cam.panX) / prev;
  const by = cy + (p.y - cy - cam.panY) / prev;
  cam.zoom = next;
  cam.panX = p.x - (cx + (bx - cx) * next);
  cam.panY = p.y - (cy + (by - cy) * next);
  redraw();
}

// =====================================================================
// EVENT LISTENERS
// =====================================================================

// Tabs — with Arrow-key roving tabindex
const navItems = qsa(".nav-item");
navItems.forEach((item, idx) => {
  item.addEventListener("click", () => {
    const tab = item.dataset.tab;
    if (!tab || item.getAttribute("aria-disabled") === "true") return;
    setActiveTab(tab);
    if (tab === "collar")   updateCollarTable();
    if (tab === "survey")   updateSurveyTable();
    if (tab === "interval") updateGeologyTable();
    if (tab === "filter")   updateFilterPreview();
  });
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); item.click(); }
    if (e.key === "ArrowDown") { e.preventDefault(); navItems[Math.min(idx + 1, navItems.length - 1)]?.focus(); }
    if (e.key === "ArrowUp")   { e.preventDefault(); navItems[Math.max(idx - 1, 0)]?.focus(); }
  });
});

// Import: Load defaults
el("load-defaults").addEventListener("click", () => {
  loadDefaults();
});

// Import: Save/load SQLite projects
el("save-project-sqlite").addEventListener("click", () => {
  saveProjectToSQLite();
});

el("open-project-sqlite").addEventListener("click", () => {
  openProjectFromSQLite();
});

// Import: Clear data
el("clear-data").addEventListener("click", () => {
  if (confirm("Alle geladenen Daten und den Cache löschen?")) {
    clearData();
  }
});

// Import: File inputs
async function handleFileInput(fileEl, loader) {
  const file = fileEl.files?.[0];
  if (!file) return;
  setStatus(`Lade ${file.name}...`, "busy");
  try {
    const text = await file.text();
    await loader(text, file.name);
    buildFromState();
    redraw();
    setStatus(`${file.name} geladen.`, "ok");
  } catch (err) {
    setStatus(`Fehler beim Laden: ${err.message}`, "error");
    console.error(err);
  }
}

// Collar: show mapping UI instead of direct load
el("collar-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus(`Analysiere ${file.name}...`, "busy");
  try {
    const text = await file.text();
    if (!text.trim()) { setStatus("Datei enthaelt keine Daten.", "error"); return; }
    showCollarImportUI(text, file.name);
    setStatus(`${file.name}: Importoptionen und Spalten pruefen, dann uebernehmen.`, "");
    return;
    if (!rows.length) { setStatus("Datei enthält keine Daten.", "error"); return; }
    state.pendingCollarRows = rows;
    showCollarMappingUI(rows, file.name);
    setStatus(`${file.name}: ${rows.length} Zeilen erkannt – bitte Spalten prüfen und übernehmen.`, "");
  } catch (err) {
    setStatus(`Fehler: ${err.message}`, "error");
    console.error(err);
  }
});

// Collar mapping: apply button
el("collar-mapping-apply").addEventListener("click", async () => {
  const mapping = readMappingSelects();
  if (!mapping.boreholeId || !mapping.x || !mapping.y || !mapping.depth) {
    el("collar-mapping-preview").textContent = "Bitte Bohrung-ID, X, Y und Endtiefe zuweisen.";
    el("collar-mapping-preview").className = "mapping-preview is-error";
    return;
  }
  try {
    const remapped = applyCollarMapping(state.pendingCollarRows, mapping);
    const filename = el("collar-mapping-filename").textContent;
    await applyCollar(remapped, "user", filename);
    buildFromState();
    redraw();
    updateMappingPreview(state.pendingCollarRows);
    setStatus(`Collar übernommen · ${state.boreholes.length} Bohrungen erkannt.`, "ok");
  } catch (err) {
    setStatus(`Fehler: ${err.message}`, "error");
    console.error(err);
  }
});

// Collar mapping: dismiss
el("collar-mapping-dismiss").addEventListener("click", () => {
  el("collar-mapping-section").hidden = true;
});

// Collar mapping: live preview on select change
["map-bhid", "map-x", "map-y", "map-z", "map-depth", "map-class"].forEach((id) => {
  el(id)?.addEventListener("change", () => {
    // Update styling
    const sel = el(id);
    sel.className = "mapping-select" + (sel.value ? " is-auto-detected" : "");
    updateMappingPreview(state.pendingCollarRows);
  });
});

["cmap-delimiter", "cmap-header-row"].forEach((id) => {
  el(id)?.addEventListener("change", () => {
    if (!state.pendingCollarText) return;
    if (id === "cmap-header-row") {
      const delimSel = el("cmap-delimiter");
      if (delimSel?.value === "auto") {
        delimSel.value = delimiterCharToValue(
          detectDelimiter(state.pendingCollarText, { headerRow: sanitizeHeaderRow(el("cmap-header-row")?.value ?? 1) })
        );
      }
    }
    reParseCollarImport();
  });
});

// Survey: show mapping UI instead of direct load
el("survey-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus(`Analysiere ${file.name}...`, "busy");
  try {
    const text = await file.text();
    if (!text.trim()) { setStatus("Datei enthaelt keine Daten.", "error"); return; }
    showSurveyImportUI(text, file.name);
    setStatus(`${file.name}: Importoptionen und Spalten pruefen, dann uebernehmen.`, "");
    return;
    const rows = parseCsv(text);
    if (!rows.length) { setStatus("Datei enthält keine Daten.", "error"); return; }
    state.pendingSurveyRows = rows;
    showSurveyMappingUI(rows, file.name);
    setStatus(`${file.name}: ${rows.length} Zeilen erkannt – bitte Spalten prüfen und übernehmen.`, "");
  } catch (err) {
    setStatus(`Fehler: ${err.message}`, "error");
    console.error(err);
  }
});

// Survey mapping: apply
el("survey-mapping-apply").addEventListener("click", async () => {
  const mapping = readSurveyMappingSelects();
  if (!mapping.boreholeId || !mapping.at) {
    el("survey-mapping-preview").textContent = "Bitte Bohrung-ID und Teufe zuweisen.";
    el("survey-mapping-preview").className   = "mapping-preview is-error";
    return;
  }
  try {
    const remapped = applySurveyMapping(state.pendingSurveyRows, mapping);
    const filename = el("survey-mapping-filename").textContent;
    await applySurvey(remapped, "user", filename);
    buildFromState();
    redraw();
    updateSurveyMappingPreview(state.pendingSurveyRows);
    const { boreholes } = countValidSurveyRows(state.pendingSurveyRows, mapping);
    setStatus(`Survey übernommen · ${boreholes} Bohrungen mit Verlaufsdaten.`, "ok");
  } catch (err) {
    setStatus(`Fehler: ${err.message}`, "error");
    console.error(err);
  }
});

// Survey mapping: dismiss
el("survey-mapping-dismiss").addEventListener("click", () => {
  el("survey-mapping-section").hidden = true;
});

// Survey mapping: live preview
["smap-bhid", "smap-at", "smap-dip", "smap-az"].forEach((id) => {
  el(id)?.addEventListener("change", () => {
    const sel = el(id);
    sel.className = "mapping-select" + (sel.value ? " is-auto-detected" : "");
    updateSurveyMappingPreview(state.pendingSurveyRows);
  });
});

["smapcfg-delimiter", "smapcfg-header-row"].forEach((id) => {
  el(id)?.addEventListener("change", () => {
    if (!state.pendingSurveyText) return;
    if (id === "smapcfg-header-row") {
      const delimSel = el("smapcfg-delimiter");
      if (delimSel?.value === "auto") {
        delimSel.value = delimiterCharToValue(
          detectDelimiter(state.pendingSurveyText, { headerRow: sanitizeHeaderRow(el("smapcfg-header-row")?.value ?? 1) })
        );
      }
    }
    reParseSurveyImport();
  });
});

// Geology: show mapping UI
el("geology-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus(`Analysiere ${file.name}...`, "busy");
  try {
    const text = await file.text();
    if (!text.trim()) { setStatus("Datei enthält keine Daten.", "error"); return; }
    showGeologyMappingUI(text, file.name);
    setStatus(`${file.name} geladen – bitte Trennzeichen und Spalten prüfen.`, "");
  } catch (err) {
    setStatus(`Fehler: ${err.message}`, "error");
    console.error(err);
  }
});

// Geology mapping: delimiter change → re-parse
el("gmap-delimiter").addEventListener("change", () => {
  reParseGeologyWithDelimiter();
});

el("gmap-header-row").addEventListener("change", () => {
  const delimSel = el("gmap-delimiter");
  if (delimSel?.value === "auto") {
    delimSel.value = delimiterCharToValue(
      detectDelimiter(state.pendingGeologyText, { headerRow: sanitizeHeaderRow(el("gmap-header-row")?.value ?? 1) })
    );
  }
  reParseGeologyWithDelimiter();
});

// Geology mapping: live preview on select change
["gmap-bhid", "gmap-from", "gmap-to"].forEach((id) => {
  el(id)?.addEventListener("change", () => {
    const sel = el(id);
    sel.className = "mapping-select" + (sel.value ? " is-auto-detected" : "");
    updateGeologyMappingPreview();
  });
});

// Geology mapping: apply
el("geology-mapping-apply").addEventListener("click", async () => {
  const mapping = readGeologyMappingSelects();
  if (!mapping.boreholeId || !mapping.from || !mapping.to) {
    el("geology-mapping-preview").textContent = "Bitte Bohrung-ID, Tiefe Von und Tiefe Bis zuweisen.";
    el("geology-mapping-preview").className   = "mapping-preview is-error";
    return;
  }
  try {
    const remapped = applyGeologyMapping(state.pendingGeologyRows, mapping);
    const filename = el("geology-mapping-filename").textContent;
    await applyGeology(remapped, "user", filename);
    buildFromState();
    redraw();
    updateGeologyMappingPreview();
    const { rows, boreholes } = countValidGeologyRows(state.pendingGeologyRows, mapping);
    setStatus(`Intervalltabelle übernommen · ${rows} Intervalle · ${boreholes} Bohrungen.`, "ok");
  } catch (err) {
    setStatus(`Fehler: ${err.message}`, "error");
    console.error(err);
  }
});

// Geology mapping: dismiss
el("geology-mapping-dismiss").addEventListener("click", () => {
  el("geology-mapping-section").hidden = true;
});

// Colors: show mapping UI after loading
el("colors-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus(`Lade ${file.name}...`, "busy");
  try {
    const text = await file.text();
    const cmap = parseLfcColors(text);
    if (!cmap.size) { setStatus("Keine Farb-Codes in dieser Datei gefunden.", "error"); return; }
    showColorMappingUI(cmap, file.name);
    setStatus(`${file.name}: ${cmap.size} Farb-Codes – bitte Spalten zuweisen.`, "");
    e.target.value = "";  // allow re-selecting same file
  } catch (err) {
    setStatus(`Fehler: ${err.message}`, "error");
    console.error(err);
  }
});

// Colors mapping: apply
el("colors-mapping-apply").addEventListener("click", async () => {
  const checked = [...document.querySelectorAll("#color-col-checks input:checked")];
  const columns = checked.map((cb) => cb.value);
  const prev = el("colors-mapping-preview");

  if (!state.pendingColorMap) return;

  const colorFile = {
    id:       generateColorFileId(),
    filename: state.pendingColorFilename,
    columns,
    colorMap: state.pendingColorMap
  };

  state.colorFiles.push(colorFile);
  await saveColorFilesToDB();
  triggerProjectDbSync();
  updateColorsCard();
  updateNavBadges();
  if (state.activeTab === "detail") updateDetailView();

  el("colors-mapping-section").hidden = true;
  state.pendingColorMap = null;
  setStatus(
    `${colorFile.filename} hinzugefügt · ${colorFile.colorMap.size} Farben · ${columns.length ? columns.join(", ") : "keine Spalten"}.`,
    "ok"
  );
});

// Colors mapping: dismiss
el("colors-mapping-dismiss").addEventListener("click", () => {
  el("colors-mapping-section").hidden = true;
});

// Sidebar search
el("search-input").addEventListener("input", () => {
  syncBoreholeList();
  updateStats();
  updateNavBadges();
  if (state.activeTab === "map") redraw();
});

// Map: Viewer tools
qsa(".tool-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tool === "fit") {
      resetCamera();
      state.viewer.measurement = { start: null, end: null, label: "" };
      redraw();
      return;
    }
    state.viewer.mode = btn.dataset.tool;
    state.viewer.measurement = { start: null, end: null, label: "" };
    qsa(".tool-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    redraw();
  });
});

// Map: View mode buttons — 2D modes handled here (3D handled in the 3D section)
qsa(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.mode === "3d") return; // handled by 3D section
    state.viewMode = btn.dataset.mode;
    qsa(".mode-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    deactivate3DViewer();
    resetCamera();
    state.viewer.measurement = { start: null, end: null, label: "" };
    redraw();
  });
});

// Map: Toggles
el("show-labels").addEventListener("change", (e) => { state.showLabels = e.target.checked; redraw(); });
el("show-grid").addEventListener("change",   (e) => { state.showGrid   = e.target.checked; redraw(); });
el("show-all").addEventListener("change",    (e) => { state.showAll    = e.target.checked; resetCamera(); redraw(); });

// Map: Canvas events
const mainCanvas = el("viewer-canvas");
mainCanvas.addEventListener("pointerdown",  handleCanvasDown);
mainCanvas.addEventListener("pointermove",  handleCanvasMove);
mainCanvas.addEventListener("pointerup",    handleCanvasUp);
mainCanvas.addEventListener("pointerleave", () => {
  state.viewer.drag.active = false;
  state.viewer.hoveredTarget = null;
  redraw();
});
mainCanvas.addEventListener("wheel", handleCanvasWheel, { passive: false });

// Per-panel table filters
el("collar-filter")?.addEventListener("input",  updateCollarTable);
el("survey-filter")?.addEventListener("input",  updateSurveyTable);
el("geology-filter")?.addEventListener("input", updateGeologyTable);

el("collar-show-all")?.addEventListener("change",  updateCollarTable);
el("survey-show-all")?.addEventListener("change",  updateSurveyTable);
el("geology-show-all")?.addEventListener("change", updateGeologyTable);

// =====================================================================
// 3D WEBGL VIEWER
// =====================================================================
let viewer3d = null;

function show3DCanvas(visible) {
  const c2d = el("viewer-canvas");
  const c3d = el("viewer-canvas-3d");
  const msg = el("viewer-3d-loading");
  if (!c2d || !c3d) return;
  c2d.hidden  = visible;
  c3d.hidden  = !visible;
  if (msg) msg.hidden = true;
}

function get3DDiameter() {
  return Math.max(0, parseFloat(el("viewer-3d-diameter")?.value ?? "1") || 0);
}

async function activate3DViewer() {
  const canvas = el("viewer-canvas-3d");
  const loading = el("viewer-3d-loading");
  const errEl   = el("viewer-3d-error");
  if (!canvas) return;

  show3DCanvas(true);
  el("vtb-3d-opts").hidden = false;
  if (loading) loading.hidden = false;
  if (errEl)   errEl.hidden   = true;

  try {
    if (!viewer3d) {
      viewer3d = new Viewer3D(canvas);
      await viewer3d.init();
    }
    viewer3d.setBoreholes(
      state.filteredBoreholes,
      state.selectedId,
      state.geologyById,
      state.viewer3dLogColumn,
      state.colorFiles,
      get3DDiameter()
    );
    if (loading) loading.hidden = true;
    updateViewer3DLegend();
  } catch (err) {
    if (loading) loading.hidden = true;
    if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
    console.error(err);
  }
}

function deactivate3DViewer() {
  show3DCanvas(false);
  el("vtb-3d-opts").hidden = true;
  const legendEl = el("viewer-3d-legend");
  if (legendEl) legendEl.hidden = true;
}

// Hook: when 3D mode is selected, init viewer; otherwise use 2D
const _origModeBtnHandler = null;
qsa(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (btn.dataset.mode === "3d") {
      qsa(".mode-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      state.viewMode = "3d";
      resetCamera();
      await activate3DViewer();
    } else {
      deactivate3DViewer();
    }
  });
});

// Update 3D viewer when borehole selection changes (if 3D is active)
const _origRedraw = redraw;

// =====================================================================
// IFC EXPORT
// =====================================================================
function getExportBoreholes() {
  const scope = document.querySelector('input[name="ifc-scope"]:checked')?.value ?? "all";
  if (scope === "selected") {
    const bh = state.boreholes.find((b) => b.id === state.selectedId);
    return bh ? [bh] : [];
  }
  if (scope === "filtered") return state.filteredBoreholes;
  return state.boreholes;
}

function updateIfcNamePreview() {
  const previewEl = el("ifc-name-preview");
  if (!previewEl) return;

  const bhTpl  = el("ifc-name-borehole")?.value?.trim() || DEFAULT_BOREHOLE_NAME_TEMPLATE;
  const ivTpl  = el("ifc-name-interval")?.value?.trim() || DEFAULT_INTERVAL_NAME_TEMPLATE;
  const prefix = el("ifc-facility-prefix")?.value ?? "";

  const bh = state.boreholes[0];
  if (!bh) {
    previewEl.textContent = "Vorschau: (noch keine Bohrungen geladen)";
    previewEl.className = "mapping-preview is-warn";
    return;
  }

  const facilityName = `${prefix}${bh.id}`;
  const bhTokens = { prefix, bhid: bh.id, borehole: facilityName, class: bh.className || "" };
  const iv = (state.geologyById.get(bh.normalizedId) ?? [])[0];
  const ivTokens = iv
    ? {
        ...bhTokens,
        geo: iv.unit || iv.subUnit || iv.geologyCode || "Stratum",
        unit: iv.unit || "", subunit: iv.subUnit || "", code: iv.geologyCode || "",
        from: iv.from, to: iv.to, thickness: iv.thickness, desc: iv.description || ""
      }
    : { ...bhTokens, geo: "Sand", unit: "Sand", from: 0, to: 5, thickness: 5 };

  const bhName = applyNameTemplate(bhTpl, bhTokens) || facilityName;
  const ivName = applyNameTemplate(ivTpl, ivTokens) || ivTokens.geo;
  previewEl.textContent = `Vorschau · Bohrloch: "${bhName}"   ·   Intervall: "${ivName}"`;
  previewEl.className = "mapping-preview is-ok";
}

function updateIfcSettingsSummary() {
  const summary = el("ifc-settings-summary");
  const countEl = el("ifc-borehole-count");
  if (!summary) return;

  const onlyWithIv = el("ifc-only-with-intervals")?.checked ?? false;
  const allBhs = state.filteredBoreholes;
  const bhs    = onlyWithIv
    ? allBhs.filter((bh) => (state.geologyById.get(bh.normalizedId)?.length ?? 0) > 0)
    : allBhs;
  const total    = state.boreholes.length;
  const ivTotal  = bhs.reduce((s, bh) => s + (state.geologyById.get(bh.normalizedId)?.length ?? 0), 0);
  const col      = el("ifc-color-col")?.value || "";
  const diam     = get3DDiameter();
  const filtered = state.baseFilteredBoreholes !== null;
  const boreholeClass = el("ifc-borehole-class")?.value ?? "IFCBOREHOLE";
  const intervalClass = el("ifc-interval-class")?.value ?? "IFCBUILDINGELEMENTPROXY";

  if (countEl) countEl.textContent = `${bhs.length} Bohrungen`;

  // Build color preview swatches (first 10 unique values in current data)
  const uniqueValues = [];
  if (col) {
    for (const bh of bhs) {
      const ivs = state.geologyById.get(bh.normalizedId) ?? [];
      for (const iv of ivs) {
        const v = String(iv.raw?.[col] ?? "").trim();
        if (v && !uniqueValues.includes(v)) uniqueValues.push(v);
        if (uniqueValues.length >= 10) break;
      }
      if (uniqueValues.length >= 10) break;
    }
  }

  summary.replaceChildren();

  function addRow(keyText, valueNode) {
    const k = document.createElement("span"); k.className = "iss-key"; k.textContent = keyText;
    summary.append(k, valueNode);
  }

  function val(text, cls = "iss-val") {
    const v = document.createElement("span"); v.className = cls; v.textContent = text; return v;
  }

  // Boreholes
  addRow("Bohrungen",
    val(`${bhs.length}${filtered ? ` von ${total} (Filter aktiv)` : ` (alle)`}`,
        filtered ? "iss-val-accent" : "iss-val"));

  // Intervals
  const ivSpan = document.createElement("span");
  ivSpan.className = ivTotal > 0 ? "iss-val" : "iss-val-muted";
  ivSpan.textContent = ivTotal > 0 ? `${ivTotal} Intervalle (${intervalClass})` : "keine Intervalle geladen";
  addRow("Intervalle", ivSpan);

  addRow("Bohrloch-Klasse", val(boreholeClass, "iss-val"));
  addRow("Intervall-Klasse", val(intervalClass, "iss-val"));

  // Color column
  addRow("Farbspalte", val(col || "— nicht gesetzt —", col ? "iss-val-accent" : "iss-val-muted"));

  // Swatches
  if (col && uniqueValues.length) {
    const swatchRow = document.createElement("span");
    swatchRow.className = "iss-swatch-row";
    for (const v of uniqueValues) {
      const sw = document.createElement("span");
      sw.className = "iss-swatch";
      sw.style.background = getIntervalColor(v, col);
      sw.title = v;
      swatchRow.append(sw);
    }
    if (uniqueValues.length < bhs.reduce((s, bh) => s + new Set((state.geologyById.get(bh.normalizedId) ?? []).map(iv => String(iv.raw?.[col] ?? ""))).size, 0)) {
      const more = document.createElement("span");
      more.className = "iss-val-muted";
      more.textContent = " …";
      swatchRow.append(more);
    }
    addRow("Farben (Vorschau)", swatchRow);
  }

  // Color files
  const activeCFs = col
    ? state.colorFiles.filter(cf => cf.columns.includes(col) || cf.columns.length === 0)
    : [];
  addRow("Farb-Dateien",
    val(activeCFs.length
      ? activeCFs.map(cf => cf.filename).join(", ")
      : "Hash-basiert (keine .lfc zugewiesen)",
      activeCFs.length ? "iss-val" : "iss-val-muted"));

  // Diameter
  addRow("Durchmesser", val(diam > 0 ? `${diam} m` : "— nur Achslinie —", diam > 0 ? "iss-val" : "iss-val-muted"));
  const activeAttributeCount = state.attributeMappings.filter((mapping) => mapping.enabled).length;
  addRow("Attribute Mapping",
    val(activeAttributeCount ? `${activeAttributeCount} aktive Zuordnungen` : "keine aktiven Zuordnungen",
        activeAttributeCount ? "iss-val-accent" : "iss-val-muted"));
}

el("ifc-export-btn")?.addEventListener("click", () => {
  // Use filtered boreholes (mirrors WebGL viewer)
  const onlyWithIntervals = el("ifc-only-with-intervals")?.checked ?? false;
  const bhs = onlyWithIntervals
    ? state.filteredBoreholes.filter((bh) => (state.geologyById.get(bh.normalizedId)?.length ?? 0) > 0)
    : state.filteredBoreholes;
  if (!bhs.length) { setStatus("Keine Bohrungen zum Exportieren.", "error"); return; }

  const filename          = (el("ifc-filename")?.value?.trim() || "boreholes") + ".ifc";
  const includeIntervals  = state.geologyRows.length > 0;
  const diameter          = get3DDiameter();
  const colorColumn       = el("ifc-color-col")?.value || "";
  const boreholeGeometry    = el("ifc-borehole-geometry")?.checked ?? true;
  const includeStratumPset  = el("ifc-include-stratum-pset")?.checked ?? true;
  const boreholeIfcClass    = el("ifc-borehole-class")?.value ?? "IFCBOREHOLE";
  const intervalIfcClass  = el("ifc-interval-class")?.value ?? "IFCBUILDINGELEMENTPROXY";
  const boreholePropertySetsById = buildBoreholeAttributePropertySets(bhs);
  const intervalAttributeMappings = buildIntervalAttributeMappings();
  const projectName    = el("ifc-project-name")?.value?.trim()    || "InfraCore GEO Boreholes";
  const siteName       = el("ifc-site-name")?.value?.trim()       || "Borehole Site";
  const facilityPrefix = el("ifc-facility-prefix")?.value ?? "";
  const boreholeNameTemplate = el("ifc-name-borehole")?.value?.trim() || DEFAULT_BOREHOLE_NAME_TEMPLATE;
  const intervalNameTemplate = el("ifc-name-interval")?.value?.trim() || DEFAULT_INTERVAL_NAME_TEMPLATE;

  setStatus("Erstelle IFC 4.3 Add2 Datei…", "busy");
  try {
    const stepText = exportToIfc(bhs, state.geologyById, {
      includeIntervals,
      filename,
      diameter,
      colorColumn,
      colorFiles: state.colorFiles,
      boreholeGeometry,
      includeStratumPset,
      boreholeIfcClass,
      intervalIfcClass,
      boreholePropertySetsById,
      intervalAttributeMappings,
      projectName,
      siteName,
      facilityPrefix,
      boreholeNameTemplate,
      intervalNameTemplate
    });
    const blob = new Blob([stepText], { type: "application/x-step" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    const ivTotal = bhs.reduce((s, bh) => s + (state.geologyById.get(bh.normalizedId)?.length ?? 0), 0);
    setStatus(`${filename} · ${bhs.length} Bohrungen · ${ivTotal} Intervalle exportiert.`, "ok");
  } catch (err) {
    setStatus(`IFC Export Fehler: ${err.message}`, "error");
    console.error(err);
  }
});

["ifc-borehole-class", "ifc-interval-class", "ifc-borehole-geometry", "ifc-filename",
 "ifc-color-col", "ifc-only-with-intervals", "ifc-include-stratum-pset"].forEach((id) => {
  el(id)?.addEventListener("change", () => {
    if (state.activeTab === "export") updateIfcSettingsSummary();
  });
});

// IfcName-Schema: preset dropdown fills the interval template; manual edits
// switch the preset to "custom". Every change refreshes the live preview.
el("ifc-name-interval-preset")?.addEventListener("change", (e) => {
  if (e.target.value !== "__custom__") {
    const input = el("ifc-name-interval");
    if (input) input.value = e.target.value;
  }
  updateIfcNamePreview();
});

el("ifc-name-interval")?.addEventListener("input", () => {
  const preset = el("ifc-name-interval-preset");
  const value = el("ifc-name-interval")?.value ?? "";
  if (preset && ![...preset.options].some((o) => o.value === value)) {
    preset.value = "__custom__";
  }
  updateIfcNamePreview();
});

el("ifc-name-borehole")?.addEventListener("input", updateIfcNamePreview);
el("ifc-facility-prefix")?.addEventListener("input", updateIfcNamePreview);


// =====================================================================
// IFC IMPORT
// =====================================================================
el("ifc-import-file")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const result = el("ifc-import-result");
  setStatus(`Lese ${file.name}…`, "busy");
  try {
    const text = await file.text();
    const parsed = importFromIfc(text);

    if (!parsed.collarRows.length) {
      if (result) {
        result.textContent = "Keine IFCBOREHOLE-Einträge in dieser Datei gefunden.";
        result.className = "ifc-import-result is-error";
        result.hidden = false;
      }
      setStatus("Keine Bohrungen im IFC gefunden.", "error");
      return;
    }

    // Apply to app state
    await applyCollar(parsed.collarRows, "ifc", file.name);
    await applySurvey(parsed.surveyRows, "ifc", file.name);
    if (parsed.intervalRows.length) {
      await applyGeology(parsed.intervalRows, "ifc", file.name);
    }
    buildFromState();
    redraw();

    if (result) {
      result.textContent =
        `${parsed.boreholeCount} Bohrungen · ${parsed.intervalCount} Intervalle aus ${file.name} geladen.`;
      result.className = "ifc-import-result";
      result.hidden = false;
    }
    setStatus(`IFC Import: ${parsed.boreholeCount} Bohrungen geladen.`, "ok");
  } catch (err) {
    if (result) {
      result.textContent = `Fehler: ${err.message}`;
      result.className = "ifc-import-result is-error";
      result.hidden = false;
    }
    setStatus(`IFC Import Fehler: ${err.message}`, "error");
    console.error(err);
  } finally {
    e.target.value = "";
  }
});

// 3D diameter change → re-render
// ─── 3D Legend ───────────────────────────────────────────────────────────────

function updateViewer3DLegend() {
  const legendEl = el("viewer-3d-legend");
  const titleEl  = el("viewer-3d-legend-title");
  const itemsEl  = el("viewer-3d-legend-items");
  if (!legendEl) return;

  const col = state.viewer3dLogColumn;
  if (!col || state.viewMode !== "3d") {
    legendEl.hidden = true;
    return;
  }

  // Collect unique values present in visible boreholes
  const valueColors = new Map(); // value → css color
  for (const bh of state.filteredBoreholes) {
    const intervals = state.geologyById.get(bh.normalizedId) ?? [];
    for (const iv of intervals) {
      const val = String(iv.raw?.[col] ?? "").trim();
      if (!val || val === "$" || valueColors.has(val)) continue;
      valueColors.set(val, getIntervalColor(val, col));
    }
  }

  if (!valueColors.size) {
    legendEl.hidden = true;
    return;
  }

  titleEl.textContent = col;
  itemsEl.replaceChildren();

  const sorted = [...valueColors.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const MAX_ITEMS = 22;

  for (const [label, color] of sorted.slice(0, MAX_ITEMS)) {
    const item = document.createElement("div");
    item.className = "viewer-legend-item";

    const swatch = document.createElement("span");
    swatch.className = "viewer-legend-swatch";
    swatch.style.background = color;

    const text = document.createElement("span");
    text.className = "viewer-legend-label";
    text.textContent = label;
    text.title = label;

    item.append(swatch, text);
    itemsEl.append(item);
  }

  if (sorted.length > MAX_ITEMS) {
    const more = document.createElement("div");
    more.className = "viewer-legend-more";
    more.textContent = `… und ${sorted.length - MAX_ITEMS} weitere`;
    itemsEl.append(more);
  }

  legendEl.hidden = false;
}

// ─── 3D Refresh (geometry + legend) ──────────────────────────────────────────

function refresh3DViewer() {
  if (state.viewMode === "3d" && viewer3d) {
    viewer3d.setBoreholes(
      state.filteredBoreholes,
      state.selectedId,
      state.geologyById,
      state.viewer3dLogColumn,
      state.colorFiles,
      get3DDiameter()
    );
    updateViewer3DLegend();
  }
}

el("viewer-3d-diameter")?.addEventListener("change", refresh3DViewer);

document.addEventListener("change", (e) => {
  const id = e.target?.id;
  if (id === "viewer-3d-col") {
    state.viewer3dLogColumn = e.target.value;
    refresh3DViewer();
    return;
  }
  if (id === "ifc-color-col") {
    state.ifcColorColumn = e.target.value;
    return;
  }
  if (id === "log-color-col" || id === "log-color-col-legacy") {
    state.logColumn = e.target.value;
    invalidateColorCache();
    if (state.activeTab === "detail") updateDetailView();
    if (state.activeTab === "map") updatePlanLegend();
  }
});

// Update IFC export summary when tab becomes active
qsa(".nav-item").forEach((item) => {
  if (item.dataset.tab === "export") {
    item.addEventListener("click", () => {
      updateIfcSettingsSummary();
      updateIfcNamePreview();
    });
  }
});

// =====================================================================
// MULTI-LEVEL FILTER
// =====================================================================

// state.baseFilteredBoreholes: result after filter conditions (null = no filter)
// state.filteredBoreholes:     further narrowed by sidebar search

const TEXT_OPS = [
  { v: "contains",     l: "enthält" },
  { v: "not_contains", l: "enthält nicht" },
  { v: "eq",           l: "= (gleich)" },
  { v: "neq",          l: "≠ (ungleich)" },
  { v: "in",           l: "in Liste (kommagetrennt)" },
  { v: "empty",        l: "ist leer" },
  { v: "not_empty",    l: "ist nicht leer" }
];

const NUM_OPS = [
  { v: "eq",      l: "= (gleich)" },
  { v: "neq",     l: "≠ (ungleich)" },
  { v: "gt",      l: "> (größer als)" },
  { v: "gte",     l: "≥ (größer gleich)" },
  { v: "lt",      l: "< (kleiner als)" },
  { v: "lte",     l: "≤ (kleiner gleich)" },
  { v: "between", l: "zwischen" },
  { v: "empty",   l: "ist leer" },
  { v: "not_empty", l: "ist nicht leer" }
];

function isNumericColumn(rows, key) {
  const sample = rows.slice(0, 30).map((r) => r[key]).filter((v) => v != null && v !== "");
  return sample.length > 0 && sample.every((v) => Number.isFinite(parseFloat(String(v).replace(",", "."))));
}

function getFilterFields(dataset) {
  if (dataset === "collar") {
    const base = [
      { value: "BHID",  label: "Bohrung-ID",      type: "text" },
      { value: "depth", label: "Endtiefe (m)",      type: "numeric" },
      { value: "class", label: "Klasse",            type: "text" },
      { value: "x",     label: "X-Koordinate",      type: "numeric" },
      { value: "y",     label: "Y-Koordinate",      type: "numeric" },
      { value: "z",     label: "Z-Höhe",            type: "numeric" }
    ];
    if (state.collarRows.length) {
      const known = new Set(base.map((f) => f.value));
      for (const key of Object.keys(state.collarRows[0])) {
        if (!known.has(key)) base.push({ value: key, label: key, type: "text" });
      }
    }
    return base;
  }

  if (dataset === "survey") {
    return [
      { value: "at",  label: "Teufe / MD (m)",       type: "numeric" },
      { value: "dip", label: "Einfallswinkel (Dip)", type: "numeric" },
      { value: "az",  label: "Azimut (°)",            type: "numeric" }
    ];
  }

  if (dataset === "interval") {
    if (!state.geologyRows.length) return [{ value: "", label: "— Intervalle nicht geladen —", type: "text" }];
    return Object.keys(state.geologyRows[0]).map((key) => ({
      value: key,
      label: key,
      type: isNumericColumn(state.geologyRows, key) ? "numeric" : "text"
    }));
  }

  return [];
}

function fillFieldSelect(sel, dataset) {
  const cur = sel.value;
  sel.replaceChildren();
  for (const { value, label, type } of getFilterFields(dataset)) {
    const opt = document.createElement("option");
    opt.value = value; opt.textContent = label; opt.dataset.ftype = type;
    sel.append(opt);
  }
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function fillOpSelect(sel, fieldType, curOp = "") {
  const ops = fieldType === "numeric" ? NUM_OPS : TEXT_OPS;
  sel.replaceChildren();
  for (const { v, l } of ops) {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = l;
    sel.append(opt);
  }
  if ([...sel.options].some((o) => o.value === curOp)) sel.value = curOp;
}

function currentFieldType(row) {
  const fieldSel = row.querySelector(".fr-field");
  return fieldSel?.options[fieldSel.selectedIndex]?.dataset.ftype ?? "text";
}

function syncOpSelect(row) {
  const ft = currentFieldType(row);
  const opSel = row.querySelector(".fr-op");
  const cur   = opSel.value;
  fillOpSelect(opSel, ft, cur);
  syncValueInput(row);
}

function syncValueInput(row) {
  const op      = row.querySelector(".fr-op")?.value ?? "";
  const valIn   = row.querySelector(".fr-val");
  const maxIn   = row.querySelector(".fr-val-max");
  const noValue = ["empty", "not_empty"].includes(op);
  const between = op === "between";

  valIn.hidden   = noValue;
  maxIn.hidden   = !between;
  valIn.type     = currentFieldType(row) === "numeric" && op !== "in" ? "number" : "text";
  if (between) {
    valIn.placeholder  = "von...";
    maxIn.placeholder  = "bis...";
  } else {
    valIn.placeholder  = op === "in" ? "Wert1, Wert2, ..." : "Wert...";
  }
  updateValueHints(row);
}

function getUniqueValuesForField(dataset, field) {
  let rows;
  if (dataset === "collar")   rows = state.collarRows;
  else if (dataset === "survey")   rows = state.surveyRows;
  else if (dataset === "interval") rows = state.geologyRows;
  else return null;
  if (!rows.length || !field) return null;

  const isNum = isNumericColumn(rows, field);
  if (isNum) {
    let min = Infinity, max = -Infinity, count = 0;
    for (const row of rows) {
      const v = parseFloat(String(row[field] ?? "").replace(",", "."));
      if (isFinite(v)) { if (v < min) min = v; if (v > max) max = v; count++; }
    }
    return count ? { type: "numeric", min, max, count } : null;
  }

  const freq = new Map();
  for (const row of rows) {
    const v = String(row[field] ?? "").trim();
    if (v) freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([v]) => v);
  return sorted.length ? { type: "text", values: sorted, total: freq.size } : null;
}

function updateValueHints(row) {
  const hintsEl  = row.querySelector(".filter-val-hints");
  if (!hintsEl) return;
  hintsEl.replaceChildren();

  const op      = row.querySelector(".fr-op")?.value ?? "";
  if (["empty", "not_empty"].includes(op)) return;

  const dataset = row.querySelector(".fr-dataset")?.value ?? "collar";
  const field   = row.querySelector(".fr-field")?.value ?? "";
  const valIn   = row.querySelector(".fr-val");
  const data    = getUniqueValuesForField(dataset, field);
  if (!data) return;

  if (data.type === "numeric") {
    const span = document.createElement("span");
    span.className = "filter-val-range";
    span.textContent = `min ${fmt(data.min, 2)} · max ${fmt(data.max, 2)} · ${fmt(data.count, 0)} Werte`;
    hintsEl.append(span);
    return;
  }

  const label = document.createElement("span");
  label.className = "filter-val-hints-label";
  label.textContent = data.total > 25 ? `Top 25 / ${fmt(data.total, 0)}` : `${data.values.length}`;
  hintsEl.append(label);

  for (const val of data.values) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-val-chip";
    chip.textContent = val;
    chip.title = val;
    chip.addEventListener("click", () => {
      if (op === "in") {
        const cur = valIn.value.split(",").map((s) => s.trim()).filter(Boolean);
        if (!cur.includes(val)) cur.push(val);
        valIn.value = cur.join(", ");
      } else {
        valIn.value = val;
      }
      valIn.dispatchEvent(new Event("input"));
      valIn.focus();
    });
    hintsEl.append(chip);
  }
}

let _filterRowCounter = 0;

function addFilterRow(logic = null) {
  const id  = ++_filterRowCounter;
  const isFirst = !el("filter-conditions").querySelector(".filter-row");

  // Remove placeholder hint
  el("filter-conditions").querySelector(".filter-hint")?.remove();

  const row = document.createElement("div");
  row.className = "filter-row";
  row.dataset.rowId = id;

  // ── Column 1: Logic (AND/OR) ─────────────────────────────────────
  const logicWrap = document.createElement("div");
  logicWrap.className = "filter-logic-wrap";

  if (isFirst) {
    const placeholder = document.createElement("span");
    placeholder.className = "filter-logic-placeholder";
    placeholder.textContent = "Wenn";
    logicWrap.append(placeholder);
  } else {
    const logicSel = document.createElement("select");
    logicSel.className = "filter-logic";
    [{ v: "AND", l: "UND" }, { v: "OR", l: "ODER" }].forEach(({ v, l }) => {
      const o = document.createElement("option"); o.value = v; o.textContent = l; logicSel.append(o);
    });
    if (logic) logicSel.value = logic;
    logicSel.addEventListener("change", markFilterPreviewDirty);
    logicWrap.append(logicSel);
  }

  // ── Column 2: Dataset ────────────────────────────────────────────
  const datasetSel = document.createElement("select");
  datasetSel.className = "fr-dataset";
  [
    { v: "collar",   l: "Collar" },
    { v: "survey",   l: "Survey" },
    { v: "interval", l: "Intervall" }
  ].forEach(({ v, l }) => {
    const o = document.createElement("option"); o.value = v; o.textContent = l; datasetSel.append(o);
  });

  // ── Column 3: Field ──────────────────────────────────────────────
  const fieldSel = document.createElement("select");
  fieldSel.className = "fr-field";
  fillFieldSelect(fieldSel, "collar");

  // ── Column 4: Operator ───────────────────────────────────────────
  const opSel = document.createElement("select");
  opSel.className = "fr-op";
  fillOpSelect(opSel, "text");

  // ── Column 5: Value(s) ───────────────────────────────────────────
  const valWrap = document.createElement("div");
  valWrap.className = "filter-value-wrap";

  const valInputRow = document.createElement("div");
  valInputRow.className = "filter-val-input-row";

  const valIn = document.createElement("input");
  valIn.className = "fr-val";
  valIn.type = "text";
  valIn.placeholder = "Wert...";

  const maxIn = document.createElement("input");
  maxIn.className = "fr-val-max";
  maxIn.type = "number";
  maxIn.placeholder = "bis...";
  maxIn.hidden = true;

  valInputRow.append(valIn, maxIn);

  const hintsEl = document.createElement("div");
  hintsEl.className = "filter-val-hints";

  valWrap.append(valInputRow, hintsEl);

  // ── Column 6: Remove ─────────────────────────────────────────────
  const removeBtn = document.createElement("button");
  removeBtn.className = "filter-remove-btn";
  removeBtn.title = "Bedingung entfernen";
  removeBtn.innerHTML = "×";
  removeBtn.addEventListener("click", () => {
    row.remove();
    // Restore hint if empty
    if (!el("filter-conditions").querySelector(".filter-row")) {
      const hint = document.createElement("div");
      hint.className = "filter-hint";
      hint.innerHTML = 'Klicke <strong>+ Bedingung</strong> um einen Filter hinzuzufügen.<br>Mehrere Bedingungen werden mit <strong>UND / ODER</strong> verknüpft.';
      el("filter-conditions").append(hint);
    }
    // Make sure first row has "Wenn" placeholder
    const firstRow = el("filter-conditions").querySelector(".filter-row");
    if (firstRow && firstRow.querySelector(".filter-logic")) {
      firstRow.querySelector(".filter-logic-wrap").innerHTML = '<span class="filter-logic-placeholder">Wenn</span>';
    }
    markFilterPreviewDirty();
  });

  // ── Wire events ──────────────────────────────────────────────────
  datasetSel.addEventListener("change", () => {
    fillFieldSelect(fieldSel, datasetSel.value);
    syncOpSelect(row);
    updateValueHints(row);
    markFilterPreviewDirty();
  });
  fieldSel.addEventListener("change", () => { syncOpSelect(row); updateValueHints(row); markFilterPreviewDirty(); });
  opSel.addEventListener("change",    () => { syncValueInput(row); markFilterPreviewDirty(); });
  valIn.addEventListener("input",     markFilterPreviewDirty);
  maxIn.addEventListener("input",     markFilterPreviewDirty);

  row.append(logicWrap, datasetSel, fieldSel, opSel, valWrap, removeBtn);
  el("filter-conditions").append(row);
  syncValueInput(row);
  markFilterPreviewDirty();
  valIn.focus();
}

// ── Filter evaluation ─────────────────────────────────────────────

function collectConditions() {
  return [...el("filter-conditions").querySelectorAll(".filter-row")].map((row, idx) => ({
    logic:    idx === 0 ? null : (row.querySelector(".filter-logic")?.value ?? "AND"),
    dataset:  row.querySelector(".fr-dataset")?.value ?? "collar",
    field:    row.querySelector(".fr-field")?.value ?? "",
    op:       row.querySelector(".fr-op")?.value ?? "contains",
    value:    row.querySelector(".fr-val")?.value ?? "",
    valueMax: row.querySelector(".fr-val-max")?.value ?? ""
  }));
}

function evalOp(rawValue, op, fv, fvMax) {
  const s    = String(rawValue ?? "").trim();
  const sl   = s.toLowerCase();
  const fvN  = String(fv).toLowerCase().trim();
  const n    = parseFloat(s.replace(",", "."));
  const fn   = parseFloat(String(fv).replace(",", "."));
  const fnx  = parseFloat(String(fvMax).replace(",", "."));

  switch (op) {
    case "eq":          return sl === fvN;
    case "neq":         return sl !== fvN;
    case "contains":    return sl.includes(fvN);
    case "not_contains":return !sl.includes(fvN);
    case "gt":          return Number.isFinite(n) && n > fn;
    case "gte":         return Number.isFinite(n) && n >= fn;
    case "lt":          return Number.isFinite(n) && n < fn;
    case "lte":         return Number.isFinite(n) && n <= fn;
    case "between":     return Number.isFinite(n) && n >= fn && n <= fnx;
    case "in": {
      const vals = fvN.split(",").map((v) => v.trim()).filter(Boolean);
      return vals.includes(sl);
    }
    case "empty":       return s === "" || s === "$";
    case "not_empty":   return s !== "" && s !== "$";
    default:            return false;
  }
}

function boreholeMatchesCondition(bh, cond) {
  const { dataset, field, op, value, valueMax } = cond;

  if (dataset === "collar") {
    const row = state.collarByNormalizedId.get(bh.normalizedId);
    return row ? evalOp(row[field] ?? "", op, value, valueMax) : false;
  }

  if (dataset === "survey") {
    return bh.stations.some((s) => {
      const v = { at: s.at, dip: s.dip, az: s.az }[field] ?? "";
      return evalOp(v, op, value, valueMax);
    });
  }

  if (dataset === "interval") {
    const ivs = state.geologyById.get(bh.normalizedId) ?? [];
    return ivs.some((iv) => evalOp(iv.raw?.[field] ?? "", op, value, valueMax));
  }

  return false;
}

function evaluateFilterConditions(boreholes) {
  const conds = collectConditions();
  if (!conds.length) return [...boreholes];

  let resultIds = new Set(boreholes.map((bh) => bh.id));

  conds.forEach((cond, idx) => {
    const matchIds = new Set(
      boreholes.filter((bh) => boreholeMatchesCondition(bh, cond)).map((bh) => bh.id)
    );
    if (idx === 0 || cond.logic === "AND") {
      resultIds = new Set([...resultIds].filter((id) => matchIds.has(id)));
    } else {
      for (const id of matchIds) resultIds.add(id);
    }
  });

  return boreholes.filter((bh) => resultIds.has(bh.id));
}

// ── Live preview (no state change) ────────────────────────────────

function markFilterPreviewDirty() {
  const msg = el("filter-preview-msg");
  const countEl = el("filter-result-count");
  const hdrEl = el("filter-match-count");
  const list = el("filter-result-list");

  if (hdrEl) hdrEl.textContent = "Vorschau ausstehend";
  if (countEl) countEl.textContent = "offen";

  if (msg) {
    msg.textContent = "Aenderungen im Filter sind noch nicht synchronisiert. Klicke auf Vorschau.";
    msg.className = "filter-preview-msg is-warn";
  }

  if (list) {
    list.replaceChildren();
    const hint = document.createElement("div");
    hint.className = "filter-hint";
    hint.textContent = "Vorschau wird nach Klick auf 'Vorschau' aktualisiert.";
    list.append(hint);
  }
}

function updateFilterPreview() {
  const matches = evaluateFilterConditions(state.boreholes);
  const total   = state.boreholes.length;
  const msg     = el("filter-preview-msg");
  const countEl = el("filter-result-count");
  const hdrEl   = el("filter-match-count");

  if (hdrEl) hdrEl.textContent = `${matches.length} Bohrungen`;
  if (countEl) countEl.textContent = `${matches.length} von ${total}`;

  if (msg) {
    if (!total) {
      msg.textContent = "Keine Bohrungen geladen.";
      msg.className   = "filter-preview-msg";
    } else if (!collectConditions().length) {
      msg.textContent = `${total} Bohrungen verfügbar — keine Bedingungen gesetzt.`;
      msg.className   = "filter-preview-msg";
    } else if (matches.length === 0) {
      msg.textContent = `Keine Bohrungen entsprechen den Bedingungen.`;
      msg.className   = "filter-preview-msg is-error";
    } else {
      msg.textContent = `${matches.length} von ${total} Bohrungen entsprechen den Bedingungen.`;
      msg.className   = `filter-preview-msg ${matches.length < total ? "is-warn" : "is-ok"}`;
    }
  }

  renderFilterResultList(matches);
}

function renderFilterResultList(matches) {
  const list = el("filter-result-list");
  if (!list) return;
  list.replaceChildren();

  if (!matches.length) {
    const d = document.createElement("div");
    d.className = "filter-hint";
    d.textContent = "Keine Bohrungen entsprechen den aktuellen Bedingungen.";
    list.append(d);
    return;
  }

  for (const bh of matches.slice(0, 150)) {
    const ivCount = state.geologyById.get(bh.normalizedId)?.length ?? 0;
    const item = document.createElement("div");
    item.className = "filter-result-item" + (bh.id === state.selectedId ? " is-selected" : "");

    const bhid = document.createElement("span"); bhid.className = "fri-bhid"; bhid.textContent = bh.id;
    const cls  = document.createElement("span"); cls.className  = "fri-class"; cls.textContent = bh.className || "—";
    const dep  = document.createElement("span"); dep.className  = "fri-depth"; dep.textContent = `${fmt(bh.totalDepth, 1)} m`;
    item.append(bhid, cls, dep);

    if (ivCount) {
      const iv = document.createElement("span"); iv.className = "fri-iv"; iv.textContent = `${ivCount} IV`;
      item.append(iv);
    }

    item.addEventListener("click", () => {
      state.selectedId = bh.id;
      redraw();
      if (state.viewMode === "3d" && viewer3d) {
        refresh3DViewer();
        viewer3d.focusBorehole(bh.id);
      }
      item.scrollIntoView({ block: "nearest" });
    });
    list.append(item);
  }

  if (matches.length > 150) {
    const more = document.createElement("div");
    more.className = "filter-result-more";
    more.textContent = `… und ${matches.length - 150} weitere Bohrungen`;
    list.append(more);
  }
}

// ── Apply filter (writes to state) ────────────────────────────────

function applyFilter() {
  const hasConditions = !!el("filter-conditions").querySelector(".filter-row");
  const matches = evaluateFilterConditions(state.boreholes);

  state.baseFilteredBoreholes = hasConditions ? matches : null;

  const badge  = el("filter-active-badge");
  const deact  = el("filter-deactivate-btn");
  const dotFil = el("dot-filter");

  if (badge)  badge.hidden  = !hasConditions;
  if (deact)  deact.hidden  = !hasConditions;

  if (dotFil) {
    dotFil.className = "nav-dot" + (
      !hasConditions        ? ""
      : matches.length === 0 ? " is-error"
      : " is-loaded"
    );
  }

  syncBoreholeList();
  updateStats();
  updateNavBadges();

  if (state.activeTab === "collar")   updateCollarTable();
  if (state.activeTab === "survey")   updateSurveyTable();
  if (state.activeTab === "interval") updateGeologyTable();
  if (state.activeTab === "map")      redraw();
  if (state.activeTab === "detail")   updateDetailView();

  const n = matches.length;
  const t = state.boreholes.length;
  setStatus(
    hasConditions
      ? `Filter aktiv: ${n} von ${t} Bohrungen${n === 0 ? " — keine Treffer!" : "."}`
      : "Filter zurückgesetzt.",
    hasConditions ? (n > 0 ? "ok" : "error") : ""
  );
}

function deactivateFilter() {
  // Clear all condition rows
  el("filter-conditions").replaceChildren();
  const hint = document.createElement("div");
  hint.className = "filter-hint";
  hint.innerHTML = 'Klicke <strong>+ Bedingung</strong> um einen Filter hinzuzufügen.<br>Mehrere Bedingungen werden mit <strong>UND / ODER</strong> verknüpft.';
  el("filter-conditions").append(hint);
  applyFilter();
  updateFilterPreview();
}

// ── Override getFilteredBoreholes to respect base filter ──────────
// (replaces the existing function - defined after this block)

// ── Filter event handlers ─────────────────────────────────────────

el("filter-add-btn").addEventListener("click", () => addFilterRow());

el("filter-reset-btn").addEventListener("click", () => {
  deactivateFilter();
});

el("filter-apply-btn").addEventListener("click", () => {
  applyFilter();
  updateFilterPreview();
});

el("filter-deactivate-btn")?.addEventListener("click", () => {
  deactivateFilter();
});

// Re-render result list when switching to filter tab (to reflect current selection)
// (handled in setActiveTab via the nav-item click listener)


el("detail-log-fit")?.addEventListener("click", () => {
  resetDetailLogView();
  if (state.activeTab === "detail") updateDetailView();
});

el("detail-log-zoom-in")?.addEventListener("click", () => {
  zoomDetailLog(1.2);
  if (state.activeTab === "detail") updateDetailView();
});

el("detail-log-zoom-out")?.addEventListener("click", () => {
  zoomDetailLog(1 / 1.2);
  if (state.activeTab === "detail") updateDetailView();
});

const detailLogCanvas = el("geo-log-canvas");
detailLogCanvas?.addEventListener("pointerdown", handleDetailLogDown);
detailLogCanvas?.addEventListener("pointermove", handleDetailLogMove);
detailLogCanvas?.addEventListener("pointerup", handleDetailLogUp);
detailLogCanvas?.addEventListener("pointerleave", () => {
  state.detailLog.pointer = null;
  handleDetailLogUp();
  if (state.activeTab === "detail") updateDetailView();
});
detailLogCanvas?.addEventListener("wheel", handleDetailLogWheel, { passive: false });

// (old JSON export listeners removed — replaced by IFC export above)

// Window resize
let _resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (state.activeTab === "map") redraw();
    if (state.activeTab === "detail") updateDetailView();
  }, 100);
});

// =====================================================================
// SIDEBAR COLLAPSE (RESPONSIVE)
// =====================================================================
(function initSidebarToggle() {
  const toggle   = el("sidebar-toggle");
  const shell    = document.querySelector(".shell");
  const backdrop = el("sidebar-backdrop");
  if (!toggle || !shell) return;

  const openSidebar  = () => { shell.classList.add("sidebar-open");    toggle.setAttribute("aria-expanded", "true");  };
  const closeSidebar = () => { shell.classList.remove("sidebar-open"); toggle.setAttribute("aria-expanded", "false"); };

  toggle.addEventListener("click", () => shell.classList.contains("sidebar-open") ? closeSidebar() : openSidebar());
  backdrop?.addEventListener("click", closeSidebar);
  document.querySelectorAll(".nav-item").forEach((nav) => {
    nav.addEventListener("click", () => { if (window.innerWidth <= 860) closeSidebar(); });
  });
})();

// =====================================================================
// CANVAS TOOLTIP — hover info über Bohrungen in Plan-Ansicht
// =====================================================================
(function initCanvasTooltip() {
  const tooltip = el("canvas-tooltip");
  if (!tooltip) return;
  let ttTimer = null;

  const showTT = (bh, cx, cy) => {
    const ivs = state.geologyById.get(normalizeBoreholeId(bh.id)) ?? [];
    tooltip.innerHTML = `
      <div class="canvas-tooltip-title">${esc(bh.id)}</div>
      <div class="canvas-tooltip-row"><span class="canvas-tooltip-label">Tiefe</span><span class="canvas-tooltip-value">${fmt(bh.totalDepth, 1)} m</span></div>
      <div class="canvas-tooltip-row"><span class="canvas-tooltip-label">Intervalle</span><span class="canvas-tooltip-value">${ivs.length}</span></div>
      ${bh.className ? `<div class="canvas-tooltip-row"><span class="canvas-tooltip-label">Klasse</span><span class="canvas-tooltip-value">${esc(bh.className)}</span></div>` : ""}
    `;
    tooltip.style.left = `${cx + 16}px`;
    tooltip.style.top  = `${cy - 8}px`;
    tooltip.classList.add("is-visible");
  };

  const hideTT = () => { tooltip.classList.remove("is-visible"); clearTimeout(ttTimer); };

  const vc = el("viewer-canvas");
  if (vc) {
    vc.addEventListener("mousemove", (e) => {
      if (state.activeTab !== "map" || state.viewMode !== "plan") { hideTT(); return; }
      const r  = vc.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const hit = (state.viewer?.hitTargets ?? []).find((t) => Math.hypot(t.x - mx, t.y - my) <= t.radius + 4);
      if (hit) {
        const bh = state.filteredBoreholes.find((b) => b.id === hit.id);
        if (bh) { clearTimeout(ttTimer); ttTimer = setTimeout(() => showTT(bh, e.clientX, e.clientY), 100); return; }
      }
      hideTT();
    });
    vc.addEventListener("mouseleave", hideTT);
    vc.addEventListener("mousedown",  hideTT);
  }
})();

// =====================================================================
// PLAN VIEW GEOLOGY LEGEND
// =====================================================================
function updatePlanLegend() {
  const legendEl = el("canvas-plan-legend");
  const titleEl  = el("canvas-plan-legend-title");
  const itemsEl  = el("canvas-plan-legend-items");
  if (!legendEl || !itemsEl) return;

  const col = state.logColumn;
  if (!col || !state.geologyRows.length || state.activeTab !== "map" || state.viewMode !== "plan") {
    legendEl.hidden = true;
    return;
  }

  const valueSet = new Map();
  for (const row of state.geologyRows) {
    const v = String(row[col] ?? "").trim();
    if (!v || valueSet.has(v)) continue;
    valueSet.set(v, getIntervalColor(v, col));
    if (valueSet.size >= 20) break;
  }

  if (!valueSet.size) { legendEl.hidden = true; return; }

  titleEl.textContent = col;
  itemsEl.replaceChildren();
  for (const [label, color] of valueSet) {
    const item   = document.createElement("div"); item.className = "canvas-legend-item";
    const swatch = document.createElement("div"); swatch.className = "canvas-legend-swatch"; swatch.style.background = color;
    const lbl    = document.createElement("span"); lbl.className = "canvas-legend-label"; lbl.textContent = label; lbl.title = label;
    item.append(swatch, lbl);
    itemsEl.append(item);
  }
  legendEl.hidden = false;
}

// =====================================================================
// INITIALIZATION
// =====================================================================
setActiveTab("import");
initFromCache();

window.addEventListener("beforeunload", (e) => {
  if (state.boreholes.length > 0) {
    e.preventDefault();
    e.returnValue = "";
  }
});
