# InfraCore GEO — Borehole-Modul · Rebuild-Spezifikation

> **Zweck dieses Dokuments:** Briefing für den KI-Agenten der Zielanwendung.
> Es beschreibt vollständig und implementierungsneutral, **was** das bestehende
> „InfraCore GEO Borehole Viewer"-Tool kann, **wie** seine Fachlogik funktioniert
> und **wie** es als Modul in eine bestehende Anwendung mit performantem
> 3D-Viewer im Kern integriert werden soll. Der bestehende Viewer der
> Zielanwendung bleibt der Renderer — dieses Modul liefert Datenmodell,
> Import/Export, Fachlogik und Bedien-UI, **nicht** einen eigenen Renderer.

---

## 1. Mission in einem Absatz

Das Modul lädt Bohrungsdaten aus CSV- (Collar / Survey / Geologie) und
IFC-Dateien, berechnet aus Ansatzpunkt und Vermessungsstationen die
3D-Trajektorie jeder Bohrung, ordnet ihr geologische Schichtintervalle mit
farbcodierten Einheiten zu und stellt das Ergebnis als 2D-Karten/-Profile,
geologisches Bohrloch-Log und 3D-Szene dar. Projekte sind speicher- und
ladbar; ein normgerechter IFC-4.3-Export (Bohrungen als `IfcBorehole`,
Schichten als `IfcGeotechnicalStratum`) erlaubt die Übergabe an
BIM-Werkzeuge. **Im Rebuild stellt das Modul seine Geometrie an den
vorhandenen High-Performance-Viewer der Host-App ab, statt einen eigenen
Three.js-Viewer mitzubringen.**

---

## 2. Integrationskontext & Leitplanken

**Ausgangslage (Quell-App):** Vanilla-JS-ES-Module ohne Framework, eigener
Three.js-Viewer (`viewer3d.js`), eigener 2D-Canvas-Renderer
(`canvas-view.js`), lokaler Node-HTTP-Server (`server.js`) mit
`node:sqlite`-Projektspeicher, IndexedDB-Browsercache.

**Ziel (Host-App):** Bestehende Anwendung mit performantem Viewer im Kern.
Das Borehole-Tool wird als **gekapseltes Modul** integriert.

Daraus folgende Vorgaben für den Rebuild:

1. **Kein eigener Renderer.** Den 3D-Viewer der Host-App nutzen. Der gesamte
   Three.js-Code aus `viewer3d.js` wird **nicht** portiert, sondern durch
   einen Adapter ersetzt, der gegen die Viewer-API der Host-App spricht
   (siehe §9, Viewer-Integrationsvertrag).
2. **Fachlogik framework-neutral halten.** Datenmodell, Trajektorien-,
   Geologie- und Farb-Logik (§4) sowie Import/Export (§5/§6) müssen als reine,
   render-unabhängige Funktionen vorliegen (keine DOM-/THREE-Abhängigkeit).
   Sie sind unit-testbar und in der Host-App wiederverwendbar.
3. **UI an das Designsystem der Host-App anpassen.** Die hier beschriebenen
   Bedienflüsse und Zustände sind verbindlich, das konkrete Markup/Styling
   richtet sich nach der Host-App.
4. **Persistenz an die Host-App andocken.** Der eigene SQLite-/IndexedDB-Stack
   wird durch die Persistenzschicht der Host-App ersetzt; das Snapshot-Schema
   (§7) bleibt erhalten.
5. **Koordinaten-Konvention der Host-App respektieren.** Die Quell-App rechnet
   intern in Welt-Koordinaten (X=Easting, Y=Northing, Z=Höhe) und mappt erst
   im Viewer auf Y-up. Der Adapter übernimmt dieses Mapping passend zur
   Achsenkonvention der Host-App.

---

## 3. Domänen-Datenmodell

Drei Eingangstabellen plus optionale Farbpalette:

**Collar** (Ansatzpunkt, eine Zeile je Bohrung)
- `boreholeId` (Pflicht) — eindeutige Kennung
- `x` Easting / Rechtswert (Pflicht), `y` Northing / Hochwert (Pflicht)
- `z` Geländehöhe (optional, Default 0)
- `depth` Endtiefe (Pflicht, > 0)
- `class` Klasse/Kategorie (optional)

**Survey** (Vermessungsstationen, n Zeilen je Bohrung)
- `boreholeId`, `at` = Messtiefe (MD), `dip` = Einfallswinkel (Default 90 =
  vertikal), `az` = Azimut (Default 0). Fehlt Survey komplett → vertikale
  Bohrung von `z` bis `z − depth`.

**Geologie / Intervalle** (n Schichten je Bohrung)
- `boreholeId`, `from` (Depth Top), `to` (Depth Base), `thickness = to − from`
- beliebig viele Beschreibungs-/Klassifikationsspalten (frei), die als
  `raw`-Objekt erhalten bleiben (z. B. `Geol_SubUnit_VASYD`,
  `Geol_Units_VASYD`, `Geology Code`, `Description`, `BGS Lexicon`,
  `Geological formation` …). Diese Spalten dienen als wählbare Farb-/Legenden-
  und IFC-Property-Quellen.

**Farbpalette (`.lfc`, XML):** `<Entry>` mit `<Code>` und `<Colour>`
(drei 0..1-Floats RGB). Liefert eine Map `Code → {r,g,b}` (0..255).

**Abgeleitete Bohrung (Kernobjekt, vom Berechnungskern erzeugt):**
```
Borehole {
  id, normalizedId, className,
  collar { x, y, z },
  totalDepth,
  stations [ { at, dip, az } ],
  points   [ { md, x, y, z } ],   // Polyline der Trajektorie in Weltkoordinaten
  endPoint { md, x, y, z },
  lateralDisplacement             // horizontaler Versatz Ansatz→Endpunkt
}
```

**ID-Normalisierung:** `normalizeBoreholeId` macht IDs für das Matching über
Tabellen hinweg robust (Trim, Case- / Trennzeichen-insensitiv). Collar,
Survey und Geologie werden ausschließlich über `normalizedId` verknüpft.

---

## 4. Kern-Algorithmen (render-unabhängig, testpflichtig)

**4.1 Trajektorienberechnung** (`buildBoreholes(collarRows, surveyRows)`),
Tangentialverfahren:
- Survey-Stationen je Bohrung nach `at` sortieren; fehlt Station bei `at=0`,
  wird sie mit dip/az der ersten echten Station vorangestellt.
- Pro Segment Länge = `Δat`; Schritt: `horizontal = cos(dip)·L`,
  `dx = horizontal·sin(az)`, `dy = horizontal·cos(az)`, `dz = −sin(dip)·L`
  (Winkel in Grad → Bogenmaß; `dip=90` ⇒ rein vertikal nach unten).
- Reicht `totalDepth` über die letzte Station hinaus, wird mit deren Winkeln
  bis zur Endtiefe extrapoliert. `effectiveDepth = max(totalDepth, letzte at)`.
- Ergebnis sortiert nach `id`.

**4.2 Collar-Validierung:** verwirft Zeilen ohne ID, mit Header-artiger ID,
mit nicht-finitem x/y, mit Ursprung `(0,0)` (gilt als „nicht gesetzt", ein
einzelner 0-Wert ist erlaubt) oder `depth ≤ 0`.

**4.3 Geologie-Index** (`buildGeologyIndex`): normalisiert Zeilen, filtert auf
gültige `from`/`to`, gruppiert nach `normalizedId`, sortiert je Bohrung nach
`from`,`to`. Liefert `{ normalizedRows, byId: Map<normalizedId, interval[]> }`.

**4.4 Geländeextent** (`getDatasetExtents`): min/max über alle Trajektorien-
punkte (für Auto-Fit/Grid-Skalierung).

**4.5 Farbauflösung (geteilt!)** (`findColorEntry(value, logColumn, colorFiles)`):
Eine Lookup-Quelle für **alle** Renderer und den IFC-Export, damit derselbe
Wert überall dieselbe Farbe erhält. Reihenfolge: Paletten, die die aktive
Spalte explizit führen, zuerst, dann spaltenlose; exakter Key-Match, danach
Substring-Match in beiden Richtungen (nur für Werte > 2 Zeichen). Kein Treffer
→ deterministischer Hash→HSL-Fallback (jeder Aufrufer formatiert den Fallback
in seinem Zielraum: CSS `hsl`, three-RGB, IFC-0..1-Float).

---

## 5. Import-Pipelines

**5.1 CSV (Collar / Survey / Geologie)** — gemeinsamer Ablauf:
- Robuster CSV-Parser mit Quote-Handling; **Trennzeichen-Autoerkennung**
  (`, ; \t |`) anhand der Headerzeile; konfigurierbare **Header-Zeile**
  (1-indexiert); Dezimal-Komma-Toleranz (`toNumber` ersetzt `,`→`.`).
- **Spalten-Auto-Mapping** über umfangreiche Synonymlisten (DE/EN; z. B.
  Easting/Rechtswert/RW, Teufe/Depth/EOH, Dip/Neigung/Inclination …).
- **Mapping-UI** je Datei: pro Zielfeld ein Dropdown der erkannten Header,
  Pflichtfelder werden markiert, **Live-Vorschau** „N von M Zeilen erkennbar".
- Bestätigtes Mapping schreibt Standard-Spaltennamen (BHID, x, y, z, depth,
  class bzw. at/dip/az bzw. from/to) und behält Zusatzspalten.

**5.2 IFC-Import** (`importFromIfc`): STEP-Tokenizer; extrahiert
`IFCBOREHOLE`, `IFCGEOTECHNICALSTRATUM`, `IFCPOLYLINE`/`IFCCARTESIANPOINT`
(Geometrie), `IFCPROPERTYSINGLEVALUE`/`IFCPROPERTYSET`/
`IFCRELDEFINESBYPROPERTIES` (Attribute) und rekonstruiert Collar-/Survey-/
Geologie-Zeilen. Liefert Trefferzahlen (boreholeCount, intervalCount).

**5.3 Farb-Import (`.lfc`)** (`parseLfcColors`): mehrere Paletten gleichzeitig
ladbar; pro Palette wählt der Nutzer, **auf welche Geologie-Spalten** sie
angewendet wird; Swatch-Vorschau in der UI.

**5.4 Defaults:** mitgelieferte Beispieldaten (Collar/Survey/Geologie-CSV +
`.lfc`) per „Defaults laden" automatisch erkannt und angewandt.

---

## 6. IFC-4.3-Export (`exportToIfc`)

Schreibt eine **IFC4X3_ADD2-STEP-Datei**. Räumliche Struktur:
```
IfcProject → IfcSite → IfcFacility (eine je Bohrung)
                         → IfcBorehole (+ Trajektoriengeometrie)
                         → IfcGeotechnicalStratum (je Intervall)
```
Eigenschaften:
- Konfigurierbare **Element-Klassen** (Bohrung/Intervall), **Geometrie**
  (Linie vs. Volumenkörper/Diameter) und **Dateiname**.
- **Namensschemata per Template** mit `{token}`-Platzhaltern
  (`{borehole}`, `{geo}`, `{facility}` …); Defaults:
  Bohrung `{borehole}`, Intervall `{borehole} - {geo}`; Live-Vorschau.
- **Attribut-Mapping** in PropertySets: beliebige Quellspalten → `Pset`-Name +
  Property-Name, je Mapping aktivierbar; Scope collar/survey/interval.
- **Farbige CAD-Layer**: pro Einheit ein `IfcPresentationLayerWithStyle`;
  Layernamen werden DWG-sicher bereinigt (`sanitizeLayerName`), Farben stabil
  über die geteilte Farbauflösung (§4.5); korrekte
  `IfcSurfaceStyleRendering`/`IfcPresentationStyleAssignment`-Verkettung.
- STEP-konforme String-/Zahl-Kodierung (`\X2\…\X0\` für Nicht-ASCII, GUID-Komprimierung).
- Optionen: nur Bohrungen mit Intervallen exportieren; Stratum-Pset
  ein/aus; Export-Scope (alle / Auswahl / gefiltert).

---

## 7. Persistenz & Projektmodell

**Snapshot-Schema** (an Host-Persistenz andocken, Struktur beibehalten):
```
{
  projectId, generatedAt, attributeMappings[], loadStatus,
  collarRows[], surveyRows[], geologyRows[],
  colorFiles[ { id, filename, columns[], rows(serialisierte Map) } ],
  boreholes[ {
    id, normalizedId, className, collar, totalDepth,
    stations[], points[], endPoint, lateralDisplacement,
    geology[ { from, to, thickness, subUnit, unit, geologyCode,
               description, colorAssignments[] } ],
    colorAssignments[]
  } ]
}
```
- **Arbeitsstand (Workspace):** automatisch debounced gespeichert; beim Start
  zuerst geladen.
- **Benannte Projekte:** explizit speichern/öffnen, ohne CSV-Neuimport.
- In der Quell-App: Workspace + je Projekt eigene SQLite-Datei (`node:sqlite`),
  zusätzlich IndexedDB-Browsercache. **Im Rebuild durch Host-Persistenz
  ersetzen**; `loadStatus` trackt je Datensatz `{count, source, filename}`
  mit source ∈ default|user|cache|project|ifc.

---

## 8. Bedien-UI & Funktionen (verbindliche Flüsse, Styling = Host)

- **Navigation/Tabs:** Import · Collar · Survey · Interval · Attribute ·
  Filter · Karte · Detail · Export (tastaturnavigierbar).
- **Sidebar:** durchsuchbare Bohrungsliste, Auswahl synchron zu allen Ansichten.
- **Datentabellen** (Collar/Survey/Geologie): Textfilter, „alle/eine Bohrung",
  Zeilenauswahl; Rendering auf sichtbares Limit gedeckelt (Quell-App: 500).
- **Ansichten:** 2D-Plan (XY-Scatter, Grid, Labels, **Messwerkzeug**
  Klick-Klick-Distanz, Zoom/Pan mit mausstabilem Zoom), 2D-Profil
  (Einzelbohrung-Seitenansicht), Section/Isometrie, **3D** (über Host-Viewer).
- **Geologisches Bohrloch-Log (Detail):** Tiefen-Skala, farbige Intervallbalken
  mit Hover/Tooltip, eigener Zoom/Pan/Fit.
- **Legende:** Top-Werte der aktiven Farbspalte mit Swatches (Plan & 3D).
- **Farbspalten-Auswahl** getrennt für Detail-Log, 3D und IFC-Export;
  Auto-Vorauswahl bevorzugter Geologie-Spalten.
- **Mehrstufiger Filter:** Bedingungen mit AND/OR über Datasets
  collar/survey/interval; Text- (contains/eq/in/empty…) und Numerik-Operatoren
  (>, ≥, between…); Live-Trefferzähler + Liste; Apply/Reset; Ergebnis
  (`baseFilteredBoreholes`) wirkt auf alle Ansichten und den Export-Scope.
- **Attribut-Mapping-Tabelle:** Spalte → Pset/Property, aktivierbar, mit
  Beispielwert.
- **Display-Toggles:** Labels, Grid, „alle/gefilterte" Bohrungen, 3D-Durchmesser.

**Performance-Muster aus der Quell-App, die zu erhalten sind:** rAF-gedrosselte
Hover-/Pan-Updates, „nur Canvas neu zeichnen" statt vollem DOM-Rebuild,
gedrosseltes Resize, Map-Indizes (`collarByNormalizedId`,
`surveyByNormalizedId`, `geologyById`) für O(1)-Lookups, gecachte Farbauflösung,
adaptive Geometriequalität nach Bohrungsanzahl.

---

## 9. Viewer-Integrationsvertrag (Adapter zum Host-Viewer)

Statt `viewer3d.js` implementiert das Modul einen dünnen Adapter, der die
berechneten `Borehole`-Objekte in die Szenen-API der Host-App übersetzt. Der
Adapter muss mindestens leisten:

- **Geometrie abstellen:** je Bohrung eine Polyline aus `points` (Welt→Szene
  per Host-Achsenkonvention transformiert); bei gesetztem Durchmesser als Tube/
  Volumenkörper, sonst als Linie; Ansatzpunkt als Marker.
- **Geologie-Segmentierung:** Trajektorie an `from`/`to` der Intervalle
  unterteilen (lineare MD-Interpolation entlang der Polyline), Segmentfarbe aus
  §4.5; ohne Intervalle einfarbige Bohrung.
- **Selektion:** Pick→`boreholeId` (über die Host-Picking-API) und
  `focusBorehole(id)` / `fitAll()` an Host-Kamera delegieren.
- **Refresh-Hooks:** Neuaufbau bei Änderung von Auswahl, Farbspalte,
  Durchmesser, Filter; vorhandene Objekte sauber freigeben.
- **Legende & Labels:** Host-eigene Overlay-/Label-Mechanik nutzen.

Bleibt in der Host-App nur ein 2D-Viewer übrig, gilt derselbe Vertrag für die
projizierten 2D-Ansichten (Plan/Profil/Section), die in der Quell-App über
`canvas-view.js` mit Projektor-Funktionen je Modus laufen.

---

## 10. Empfohlene Verbesserungen (im Rebuild gleich mitnehmen)

**Korrektheit / Fachlogik**
1. **Minimum-Curvature statt Tangential** für die Trajektorie anbieten
   (Tangential übertreibt den Versatz bei stark abweichenden Stationen) —
   industrieüblich für Bohrlochvermessung; Tangential als Fallback behalten.
2. **CRS/EPSG-Bewusstsein:** Koordinatensystem je Projekt erfassen und beim
   IFC-Export als `IfcMapConversion`/`IfcProjectedCRS` schreiben (derzeit nur
   lokale Koordinaten). Ermöglicht echte Georeferenzierung in der Host-App.
3. **Einheiten explizit machen** (m vs. ft, Tiefe positiv-nach-unten) statt
   implizit; Import-Validierung gegen Tiefen-/Winkel-Plausibilität
   (z. B. `to ≤ totalDepth`, lückenlose/überlappende Intervalle melden).
4. **Survey-Lücken & Tie-in:** Umgang mit Stationen jenseits der Endtiefe und
   mit Mehrfach-`at=0` robuster spezifizieren.

**Daten & Skalierung**
5. **Worker-basierter Import/Parsing** (CSV/IFC im Web Worker) für große
   Datensätze, damit die UI nicht blockiert.
6. **Virtualisierte Tabellen** statt 500-Zeilen-Cap (alle Daten sichtbar,
   nur sichtbare Zeilen gerendert).
7. **Instanced Rendering** für Collar-Marker/Tubes über die Host-Viewer-API,
   um Tausende Bohrungen flüssig zu halten (in der Quell-App nur adaptive
   Segmentzahl).
8. **Inkrementeller/streaming Snapshot** statt Voll-Snapshot bei jeder
   Änderung; Schema versionieren (`schemaVersion`) für Migrationen.

**Export / Interop**
9. **IFC-Validierung** gegen ein buildingSMART-Schema/IDS vor dem Download;
   optional zusätzlich **GeoJSON-/CSV-Re-Export** und ggf. **AGS4**-Import
   (Industriestandard für Baugrunddaten).
10. **Farb-/Legenden-Mapping persistieren** als wiederverwendbare, benannte
    Profile (nicht nur pro Datei), inkl. manueller Überschreibung einzelner
    Werte und „nicht zugeordnet"-Hervorhebung.

**Architektur / Qualität**
11. **TypeScript-Typen** für Datenmodell und Snapshot-Schema (selbst bei
    JS-Host als `.d.ts`), reduziert Mapping-Fehler erheblich.
12. **Reine Kern-Bibliothek** (`@infracore/geo-core`) klar getrennt von UI und
    Viewer-Adapter; Kern hat keine DOM-/THREE-Abhängigkeit und volle
    Unit-Tests (Trajektorie, Geologie, Farbmatch, CSV, IFC-Writer existieren
    bereits in `test/` und sind zu übernehmen/erweitern).
13. **i18n:** UI-Strings extrahieren (Quell-App ist DE-hart­codiert).
14. **Barrierefreiheit & Theming** an das Designsystem der Host-App
    angleichen (Tastaturnavigation und ARIA sind in der Quell-App teils schon
    vorhanden und beizubehalten).

---

## 11. Abnahmekriterien & Nicht-Ziele

**Abnahme:** Identische Beispieldaten ergeben in Quell- und Host-App
deckungsgleiche Trajektorien, Geologie-Zuordnung, Farben und Legende; ein
IFC-Export öffnet in einem Standard-IFC-Viewer mit korrekter Struktur,
Geometrie, PropertySets und Layerfarben; Projekt speichern/öffnen stellt den
Zustand verlustfrei wieder her; alle übernommenen Unit-Tests sind grün.

**Nicht-Ziele:** kein eigener Renderer (Host-Viewer ist gesetzt); keine
Server-Komponente, wenn die Host-App ihre eigene Persistenz/Transport
mitbringt; keine Online-CDN-Abhängigkeit für 3D.

---

## 12. Referenz: Quell-Dateien (zum Nachschlagen, nicht 1:1 portieren)

| Bereich | Quell-Datei |
|---|---|
| App-Orchestrierung, State, UI-Verdrahtung | `src/main.js` (~4350 Z.) |
| Trajektorie, Collar-Validierung, Extents | `src/domain/trajectory.js` |
| Geologie-Index | `src/domain/geology.js` |
| ID-Normalisierung | `src/domain/identifiers.js` |
| Geteilte Farbauflösung | `src/domain/color-match.js` |
| CSV-Parser + Delimiter-Detection | `src/data/csv.js` |
| `.lfc`-Farbpaletten | `src/data/colors.js` |
| IndexedDB-Cache | `src/data/db.js` |
| Projekt-Sync-Client | `src/data/project-db.js` |
| IFC-Writer (Referenzlogik §6) | `src/ifc/writer.js` |
| IFC-Reader (Referenzlogik §5.2) | `src/ifc/reader.js` |
| 2D-Canvas-Renderer (Projektoren) | `src/render/canvas-view.js` |
| 3D-Viewer (**durch Adapter ersetzen**) | `src/render/viewer3d.js` |
| Server + SQLite-Store (**durch Host ersetzen**) | `server.js`, `server/` |
| Unit-Tests (übernehmen/erweitern) | `test/` |
