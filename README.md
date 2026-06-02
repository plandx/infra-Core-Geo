# InfraCore GEO Borehole Viewer

Lokale JavaScript-App zur Darstellung von Bohrungen aus `collar`- und `survey`-CSV-Dateien.

## Start

Voraussetzung: Node.js >= 22 (der SQLite-Projektspeicher nutzt `node:sqlite`).

Einmalig die Abhaengigkeiten installieren (stellt Three.js lokal bereit, damit
der 3D-Viewer ohne Internetverbindung funktioniert):

```bash
npm install
```

Die App laeuft als lokaler HTTP-Server (`server.js`).

```bash
npm start
```

Das startet den lokalen Server auf:

```text
http://127.0.0.1:4173
```

Alternativ unter Windows direkt per Doppelklick:

```text
start-app.bat
```

> Hinweis: Eine verpackte Electron-Desktop-App ist derzeit nicht Teil dieses
> Repositorys. `pack.js` erzeugt lediglich ein passwortgeschuetztes Quell-ZIP
> (`npm run pack`).

## Projektstruktur

- `index.html`: Einstiegspunkt der lokalen App
- `server.js`: lokaler HTTP-Server
- `server/`: SQLite-Projektspeicher (Workspace + benannte Projekte)
- `src/data`: CSV-Parsing und lokale Persistenz
- `src/domain`: Berechnung der Bohrlochtrajektorien
- `src/render`: Canvas- und 3D-Darstellung (Three.js via CDN)

## Datenlogik

- `collar` liefert den Bohransatzpunkt `x`, `y`, `z` sowie die Endtiefe
- `survey` liefert Messpunkte mit `at`, `dip` und `az`
- Die App berechnet daraus segmentweise die Trajektorie
- Bei `dip = 90` entsteht eine vertikale Bohrung, was zu den bereitgestellten Survey-Daten passt

## Projektdatenbank

- Geladene App-Daten werden im Hintergrund an `/api/project-db/sync` uebergeben.
- Der laufende Arbeitsstand wird separat in `./.project-db/workspace.sqlite` gespeichert.
- Gespeicherte Projekte liegen jeweils als eigene SQLite-Datei unter `./.project-db/projects/`.
- Damit waechst nicht mehr eine einzige Sammeldatenbank mit allen Projekten an.
- Beim Start versucht die App zuerst, den zuletzt synchronisierten SQLite-Arbeitsstand zu laden.
- Ueber die Buttons `Projekt speichern` und `Projekt oeffnen` koennen benannte Projekte direkt als eigene SQLite-Datei gesichert und wieder geladen werden, ohne die CSV-Dateien neu einzulesen.
