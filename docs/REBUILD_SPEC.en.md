# InfraCore GEO — Borehole Module · Rebuild Specification

> **Purpose of this document:** A briefing for the AI agent on the target
> application. It describes — completely and implementation-neutrally — **what**
> the existing "InfraCore GEO Borehole Viewer" tool does, **how** its domain
> logic works, and **how** it should be integrated as a module into an existing
> application that already has a high-performance 3D viewer at its core. The
> host application's existing viewer remains the renderer — this module
> provides the data model, import/export, domain logic and operator UI,
> **not** a renderer of its own.

---

## 1. Mission in one paragraph

The module loads borehole data from CSV (collar / survey / geology) and IFC
files, computes each borehole's 3D trajectory from its collar point and survey
stations, assigns colour-coded geological interval layers to it, and presents
the result as 2D maps/profiles, a geological borehole log, and a 3D scene.
Projects can be saved and reopened; a standards-compliant IFC 4.3 export
(boreholes as `IfcBorehole`, layers as `IfcGeotechnicalStratum`) enables
handover to BIM tools. **In the rebuild, the module hands its geometry off to
the host app's existing high-performance viewer instead of shipping its own
Three.js viewer.**

---

## 2. Integration context & guardrails

**Starting point (source app):** Vanilla-JS ES modules, no framework; its own
Three.js viewer (`viewer3d.js`); its own 2D canvas renderer
(`canvas-view.js`); a local Node HTTP server (`server.js`) with a
`node:sqlite` project store; an IndexedDB browser cache.

**Target (host app):** An existing application with a performant viewer at its
core. The borehole tool is integrated as an **encapsulated module**.

Resulting requirements for the rebuild:

1. **No renderer of its own.** Use the host app's 3D viewer. None of the
   Three.js code from `viewer3d.js` is ported; it is replaced by an adapter
   that talks to the host app's viewer API (see §9, Viewer Integration
   Contract).
2. **Keep domain logic framework-neutral.** The data model, trajectory,
   geology and colour logic (§4), and import/export (§5/§6) must exist as pure,
   render-independent functions (no DOM / THREE dependency). They are
   unit-testable and reusable inside the host app.
3. **Adapt the UI to the host's design system.** The operating flows and
   states described here are binding; the concrete markup/styling follows the
   host app.
4. **Hook persistence into the host app.** The bespoke SQLite/IndexedDB stack
   is replaced by the host app's persistence layer; the snapshot schema (§7) is
   preserved.
5. **Respect the host app's coordinate convention.** The source app works
   internally in world coordinates (X = Easting, Y = Northing, Z = elevation)
   and only maps to Y-up inside the viewer. The adapter performs this mapping
   to match the host app's axis convention.

---

## 3. Domain data model

Three input tables plus an optional colour palette:

**Collar** (collar point, one row per borehole)
- `boreholeId` (required) — unique identifier
- `x` Easting (required), `y` Northing (required)
- `z` ground elevation (optional, default 0)
- `depth` end-of-hole depth (required, > 0)
- `class` class/category (optional)

**Survey** (survey stations, n rows per borehole)
- `boreholeId`, `at` = measured depth (MD), `dip` = inclination (default 90 =
  vertical), `az` = azimuth (default 0). If survey is entirely missing →
  vertical borehole from `z` down to `z − depth`.

**Geology / intervals** (n layers per borehole)
- `boreholeId`, `from` (depth top), `to` (depth base), `thickness = to − from`
- arbitrarily many free description/classification columns, preserved as a
  `raw` object (e.g. `Geol_SubUnit_VASYD`, `Geol_Units_VASYD`, `Geology Code`,
  `Description`, `BGS Lexicon`, `Geological formation` …). These columns serve
  as selectable colour/legend and IFC property sources.

**Colour palette (`.lfc`, XML):** `<Entry>` with `<Code>` and `<Colour>`
(three 0..1 RGB floats). Yields a map `Code → {r,g,b}` (0..255).

**Derived borehole (core object, produced by the computation kernel):**
```
Borehole {
  id, normalizedId, className,
  collar { x, y, z },
  totalDepth,
  stations [ { at, dip, az } ],
  points   [ { md, x, y, z } ],   // trajectory polyline in world coordinates
  endPoint { md, x, y, z },
  lateralDisplacement             // horizontal offset collar → end point
}
```

**ID normalization:** `normalizeBoreholeId` makes IDs robust for cross-table
matching (trim, case-/separator-insensitive). Collar, survey and geology are
linked exclusively via `normalizedId`.

---

## 4. Core algorithms (render-independent, must be tested)

**4.1 Trajectory computation** (`buildBoreholes(collarRows, surveyRows)`),
tangential method:
- Sort each borehole's survey stations by `at`; if no station exists at
  `at=0`, prepend one using the dip/az of the first real station.
- Per segment, length = `Δat`; step: `horizontal = cos(dip)·L`,
  `dx = horizontal·sin(az)`, `dy = horizontal·cos(az)`, `dz = −sin(dip)·L`
  (angles in degrees → radians; `dip=90` ⇒ straight down).
- If `totalDepth` extends past the last station, extrapolate with that
  station's angles down to end depth. `effectiveDepth = max(totalDepth,
  last at)`.
- Result sorted by `id`.

**4.2 Collar validation:** rejects rows with no ID, a header-like ID, a
non-finite x/y, an origin of `(0,0)` (treated as "unset"; a single 0 value is
allowed), or `depth ≤ 0`.

**4.3 Geology index** (`buildGeologyIndex`): normalizes rows, filters to valid
`from`/`to`, groups by `normalizedId`, sorts each borehole by `from`,`to`.
Returns `{ normalizedRows, byId: Map<normalizedId, interval[]> }`.

**4.4 Dataset extents** (`getDatasetExtents`): min/max over all trajectory
points (for auto-fit / grid scaling).

**4.5 Colour resolution (shared!)** (`findColorEntry(value, logColumn,
colorFiles)`): A single lookup source for **all** renderers and the IFC export,
so the same value always gets the same colour. Order: palettes that explicitly
cover the active column first, then palettes with no column; exact key match
first, then a substring match in both directions (only for values > 2 chars).
No hit → deterministic hash→HSL fallback (each caller formats the fallback in
its target space: CSS `hsl`, three RGB, IFC 0..1 float).

---

## 5. Import pipelines

**5.1 CSV (collar / survey / geology)** — shared flow:
- Robust CSV parser with quote handling; **delimiter auto-detection**
  (`, ; \t |`) based on the header row; configurable **header row**
  (1-indexed); decimal-comma tolerance (`toNumber` replaces `,`→`.`).
- **Column auto-mapping** via extensive synonym lists (DE/EN; e.g.
  Easting/Rechtswert/RW, Teufe/Depth/EOH, Dip/Neigung/Inclination …).
- **Mapping UI** per file: one dropdown of detected headers per target field,
  required fields flagged, **live preview** "N of M rows recognizable".
- Confirmed mapping writes standard column names (BHID, x, y, z, depth, class
  resp. at/dip/az resp. from/to) and keeps extra columns.

**5.2 IFC import** (`importFromIfc`): STEP tokenizer; extracts `IFCBOREHOLE`,
`IFCGEOTECHNICALSTRATUM`, `IFCPOLYLINE`/`IFCCARTESIANPOINT` (geometry),
`IFCPROPERTYSINGLEVALUE`/`IFCPROPERTYSET`/`IFCRELDEFINESBYPROPERTIES`
(attributes) and reconstructs collar/survey/geology rows. Returns hit counts
(boreholeCount, intervalCount).

**5.3 Colour import (`.lfc`)** (`parseLfcColors`): multiple palettes loadable
at once; per palette the user selects **which geology columns** it applies to;
swatch preview in the UI.

**5.4 Defaults:** bundled sample data (collar/survey/geology CSV + `.lfc`)
auto-detected and applied via "Load defaults".

---

## 6. IFC 4.3 export (`exportToIfc`)

Writes an **IFC4X3_ADD2 STEP file**. Spatial structure:
```
IfcProject → IfcSite → IfcFacility (one per borehole)
                         → IfcBorehole (+ trajectory geometry)
                         → IfcGeotechnicalStratum (per interval)
```
Properties:
- Configurable **element classes** (borehole/interval), **geometry** (line vs.
  solid/diameter) and **filename**.
- **Name schemas via templates** with `{token}` placeholders (`{borehole}`,
  `{geo}`, `{facility}` …); defaults: borehole `{borehole}`, interval
  `{borehole} - {geo}`; live preview.
- **Attribute mapping** into PropertySets: arbitrary source columns →
  `Pset` name + property name, each mapping toggleable; scope
  collar/survey/interval.
- **Coloured CAD layers**: one `IfcPresentationLayerWithStyle` per unit; layer
  names DWG-sanitized (`sanitizeLayerName`); colours stable via the shared
  colour resolution (§4.5); correct
  `IfcSurfaceStyleRendering`/`IfcPresentationStyleAssignment` chaining.
- STEP-compliant string/number encoding (`\X2\…\X0\` for non-ASCII, GUID
  compression).
- Options: export only boreholes with intervals; stratum pset on/off; export
  scope (all / selection / filtered).

---

## 7. Persistence & project model

**Snapshot schema** (hook into host persistence; keep the structure):
```
{
  projectId, generatedAt, attributeMappings[], loadStatus,
  collarRows[], surveyRows[], geologyRows[],
  colorFiles[ { id, filename, columns[], rows(serialized Map) } ],
  boreholes[ {
    id, normalizedId, className, collar, totalDepth,
    stations[], points[], endPoint, lateralDisplacement,
    geology[ { from, to, thickness, subUnit, unit, geologyCode,
               description, colorAssignments[] } ],
    colorAssignments[]
  } ]
}
```
- **Working state (workspace):** saved automatically, debounced; loaded first
  on startup.
- **Named projects:** explicit save/open, without re-importing CSVs.
- In the source app: workspace + one SQLite file per project (`node:sqlite`),
  plus an IndexedDB browser cache. **In the rebuild, replace with host
  persistence**; `loadStatus` tracks per dataset `{count, source, filename}`
  with source ∈ default|user|cache|project|ifc.

---

## 8. Operator UI & features (binding flows, styling = host)

- **Navigation/tabs:** Import · Collar · Survey · Interval · Attributes ·
  Filter · Map · Detail · Export (keyboard-navigable).
- **Sidebar:** searchable borehole list, selection synced across all views.
- **Data tables** (collar/survey/geology): text filter, "all/one borehole",
  row selection; rendering capped at a visible limit (source app: 500).
- **Views:** 2D plan (XY scatter, grid, labels, **measurement tool**
  click-click distance, zoom/pan with mouse-stable zoom), 2D profile
  (single-borehole side view), section/isometric, **3D** (via host viewer).
- **Geological borehole log (detail):** depth scale, coloured interval bars
  with hover/tooltip, its own zoom/pan/fit.
- **Legend:** top values of the active colour column with swatches (plan & 3D).
- **Colour-column selection** separate for detail log, 3D and IFC export; auto
  pre-selection of preferred geology columns.
- **Multi-level filter:** conditions with AND/OR across datasets
  collar/survey/interval; text (contains/eq/in/empty…) and numeric operators
  (>, ≥, between…); live hit count + list; apply/reset; the result
  (`baseFilteredBoreholes`) drives all views and the export scope.
- **Attribute mapping table:** column → Pset/property, toggleable, with a
  sample value.
- **Display toggles:** labels, grid, "all/filtered" boreholes, 3D diameter.

**Performance patterns from the source app to preserve:** rAF-throttled
hover/pan updates, "redraw canvas only" instead of a full DOM rebuild,
throttled resize, map indexes (`collarByNormalizedId`, `surveyByNormalizedId`,
`geologyById`) for O(1) lookups, cached colour resolution, geometry quality
adaptive to borehole count.

---

## 9. Viewer integration contract (adapter to the host viewer)

Instead of `viewer3d.js`, the module implements a thin adapter that translates
the computed `Borehole` objects into the host app's scene API. The adapter must
at minimum:

- **Emit geometry:** one polyline per borehole from `points` (world→scene
  transformed per the host axis convention); a tube/solid if a diameter is set,
  otherwise a line; the collar point as a marker.
- **Geology segmentation:** subdivide the trajectory at interval `from`/`to`
  (linear MD interpolation along the polyline), segment colour from §4.5; a
  single-colour borehole when there are no intervals.
- **Selection:** pick→`boreholeId` (via the host picking API) and delegate
  `focusBorehole(id)` / `fitAll()` to the host camera.
- **Refresh hooks:** rebuild on changes to selection, colour column, diameter,
  filter; dispose existing objects cleanly.
- **Legend & labels:** use the host's own overlay/label mechanics.

If the host app only has a 2D viewer, the same contract applies to the
projected 2D views (plan/profile/section), which in the source app run through
`canvas-view.js` with a projector function per mode.

---

## 10. Recommended improvements (fold into the rebuild)

**Correctness / domain logic**
1. **Minimum-curvature in addition to tangential** for the trajectory
   (tangential overstates the offset when stations differ strongly) —
   industry-standard for borehole surveys; keep tangential as a fallback.
2. **CRS/EPSG awareness:** capture the coordinate system per project and write
   it on IFC export as `IfcMapConversion`/`IfcProjectedCRS` (currently
   local coordinates only). Enables real georeferencing in the host app.
3. **Make units explicit** (m vs. ft, depth positive-down) instead of implicit;
   import validation against depth/angle plausibility (e.g. `to ≤ totalDepth`,
   report gappy/overlapping intervals).
4. **Survey gaps & tie-in:** specify handling of stations beyond end depth and
   of multiple `at=0` more robustly.

**Data & scaling**
5. **Worker-based import/parsing** (CSV/IFC in a web worker) for large datasets
   so the UI does not block.
6. **Virtualized tables** instead of the 500-row cap (all data visible, only
   visible rows rendered).
7. **Instanced rendering** for collar markers/tubes via the host viewer API to
   keep thousands of boreholes smooth (the source app only adapts segment
   count).
8. **Incremental/streaming snapshot** instead of a full snapshot on every
   change; version the schema (`schemaVersion`) for migrations.

**Export / interop**
9. **IFC validation** against a buildingSMART schema/IDS before download;
   optionally a **GeoJSON/CSV re-export** and possibly **AGS4** import
   (industry standard for ground investigation data).
10. **Persist colour/legend mappings** as reusable named profiles (not just per
    file), including manual overrides of individual values and an "unassigned"
    highlight.

**Architecture / quality**
11. **TypeScript types** for the data model and snapshot schema (even with a JS
    host, as `.d.ts`); greatly reduces mapping errors.
12. **A pure core library** (`@infracore/geo-core`) cleanly separated from UI
    and viewer adapter; the core has no DOM/THREE dependency and full unit
    tests (trajectory, geology, colour match, CSV, IFC writer already exist in
    `test/` and should be adopted/extended).
13. **i18n:** extract UI strings (the source app is DE-hardcoded).
14. **Accessibility & theming** aligned to the host app's design system
    (keyboard navigation and ARIA are partly present in the source app and
    should be retained).

---

## 11. Acceptance criteria & non-goals

**Acceptance:** Identical sample data yields matching trajectories, geology
assignment, colours and legend in both source and host app; an IFC export opens
in a standard IFC viewer with correct structure, geometry, PropertySets and
layer colours; saving/opening a project restores the state without loss; all
adopted unit tests pass.

**Non-goals:** no renderer of its own (the host viewer is a given); no server
component if the host app brings its own persistence/transport; no online CDN
dependency for 3D.

---

## 12. Reference: source files (for lookup, not a 1:1 port)

| Area | Source file |
|---|---|
| App orchestration, state, UI wiring | `src/main.js` (~4350 lines) |
| Trajectory, collar validation, extents | `src/domain/trajectory.js` |
| Geology index | `src/domain/geology.js` |
| ID normalization | `src/domain/identifiers.js` |
| Shared colour resolution | `src/domain/color-match.js` |
| CSV parser + delimiter detection | `src/data/csv.js` |
| `.lfc` colour palettes | `src/data/colors.js` |
| IndexedDB cache | `src/data/db.js` |
| Project sync client | `src/data/project-db.js` |
| IFC writer (reference logic §6) | `src/ifc/writer.js` |
| IFC reader (reference logic §5.2) | `src/ifc/reader.js` |
| 2D canvas renderer (projectors) | `src/render/canvas-view.js` |
| 3D viewer (**replace with adapter**) | `src/render/viewer3d.js` |
| Server + SQLite store (**replace with host**) | `server.js`, `server/` |
| Unit tests (adopt/extend) | `test/` |
