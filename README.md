# InfraCore GEO Borehole Viewer

Lokale JavaScript-App zur Darstellung von Bohrungen aus `collar`- und `survey`-CSV-Dateien.

## Desktop-App

Die bevorzugte Endanwender-Variante ist jetzt die verpackte Electron-Desktop-App.

Fuer Entwicklung:

```bash
npm start
```

Das startet die lokale Desktop-Shell.

Fuer einen reinen Web-/Server-Start:

```bash
npm run start:web
```


## Web-Entwicklungsstart

Alternativ unter Windows direkt per Doppelklick:

```text
start-app.bat
```

Danach im Browser oeffnen:

```text
http://127.0.0.1:4173
```

## Projektstruktur

- `index.html`: Einstiegspunkt der lokalen App
- `server.js`: lokaler HTTP-Server fuer Web- und Electron-Betrieb
- `electron/main.js`: Electron-Hauptprozess fuer die Desktop-App
- `src/data`: CSV-Parsing
- `src/domain`: Berechnung der Bohrlochtrajektorien
- `src/render`: Canvas-Darstellung
- `input data`: bereitgestellte Quelldaten

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
