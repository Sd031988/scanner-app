# AGENTS.md

Projektkontext für OpenCode. Lesen, bevor geändert wird.

## Was das ist

`Dokumentenscanner` – installierbare Web-App (PWA) ausschließlich zum Scannen von Papierdokumenten, Rechnungen und Quittungen. Reine statische Dateien: **kein Build, kein Paketmanager, keine Framework-Abhängigkeiten.** Alles unter `vendor/` liegt lokal, damit die App offline, ohne CDN und ohne Cloud-Zugriff funktioniert.

Die Kamera ist der erste und einzige Einstieg. Keine Startseite, keine Tabs, keine Dashboards, keine Tabellen, keine Formulare.

## Starten

```powershell
cd C:\Users\Durra\scanner-app
python -m http.server 8123     # oder start.cmd
```

Dann `http://localhost:8123`. Die Kamera funktioniert nur über HTTPS oder `localhost`; über eine LAN-IP bleibt `getUserMedia` blockiert. Für Handy-Nutzung: Tunnel (`cloudflared tunnel --url http://localhost:8123`) oder statisches Hosting.

## Struktur

| Datei | Inhalt |
| --- | --- |
| `index.html` | App-Shell: Kamerabildschirm, Review-Bildschirm, Seiten-Sheet, Busy, Toast |
| `js/vision.js` | reine Bildverarbeitung, IIFE mit `window.Vision` **und** `module.exports` für Node-Tests |
| `js/app.js` | gesamte App-Logik in einem IIFE, kein Export |
| `app.css` | Styling, dunkel, randlos, grüne Bedienelemente, Safe-Area-Insets |
| `manifest.webmanifest` | PWA-Metadaten, Icons |
| `sw.js` | Offline-Cache; `VERSION` bestimmt den Cache-Namen, `SHELL` die Vorabliste |
| `vendor/jspdf.umd.min.js` | PDF-Erzeugung |
| `vendor/tesseract*.js`, `vendor/tesseract-core*.wasm.js` | OCR-Laufzeit und WASM-Cores |
| `vendor/tessdata/*.traineddata.gz` | lokale Sprachdaten `deu` + `eng` |
| `icons/` | 180/192/512 plus maskable, per Node-Skript erzeugt |

## Prüfen vor dem Abgeben

```powershell
node --check js\vision.js
node --check js\app.js
node --check sw.js
node C:\Users\Durra\AppData\Local\Temp\opencode\test-vision.js
```

Der Test deckt Kantenerkennung, Eckengenauigkeit, Reihenfolge, Entzerren, Textzeilen, Drehung, alle vier Filter, Schärfe, Stabilität, Homografie samt Inverser und PDF mit zwei Seiten ab. Danach Seite über den lokalen Server laden und die Browser-Konsole prüfen – sie muss fehlerfrei sein. Eine Kamera ist in der Testumgebung nicht verfügbar; Kamerapfade also nur über Code-Review und die sichtbaren Zustände (Overlay, Live-Hinweis, Toasts) absichern.

## Konventionen

- Zugriff auf DOM ausschließlich über `el("id")` bzw. das `ui`-Objekt. Keine `querySelector`-Kopplung, neue Elemente brauchen eine `id` in `index.html`.
- UI-Texte, Labels und Meldungen auf Deutsch.
- Code bleibt ohne Kommentare; Verständnis über sprechende Namen und klar getrennte Funktionen.
- Kein Framework, keine externe CDN-Referenz, keine Cloud-API.
- Wird eine Datei hinzugefügt oder entfernt, muss sie in `SHELL` in `sw.js` stehen.

## Stolperfallen

- **Luma liegt in 0..1, nicht 0..255.** Alles, was Schwellen oder Histogramme vergleicht, muss das berücksichtigen. `varianceOfLaplacian` rechnet intern mit `* 65025`, damit die Werte wieder auf der 0..255-Skala landen.
- **Die Homografie hat 8 Unbekannte, keine 9.** Der konstante Nenner-Term ist implizit `1`; durch `h[7]` zu dividieren zerstört die Perspektive. Rückwärts wird sie in homogenen Koordinaten angewendet, dafür gibt es `applyHH`.
- **Die Review-Vorschau wird beim Ziehen nicht neu entzerrt.** Die Abbildung Vorschau↔Original hängt am Quad, mit dem die Vorschau gebaut wurde (`state.preview.quad`), nicht am sich ändernden `state.editing.quad`. Sonst driftet der Griff.
- **`page.src` enthält schon den gewählten Filter.** Export und OCR wenden ihn nicht noch einmal an, sonst wird doppelt gefiltert.
- **Schattenkorrektur ist zweistufig.** `illuminationField` schätzt den Papierton als 80 %-Perzentil pro Kachel (nicht als Maximum: Max-Pooling erzeugt Gitterrauschen, das die Binarisierung flackern lässt), glättet das Feld mit `boxBlur` und interpoliert bilinear. `removeShadow` liefert `g / bg`, nicht `bg` selbst – wer `lum` als Nenner nimmt, entfernt den Lichtfleck nicht.
- **„Original" ist nur Belichtungskorrektur, kein Durchgang.** In `applyFilter` teilt der Zweig für `original` jeden Kanal durch das Papiertonfeld, ohne Sättigung, Konstante oder Tonwertkurve; bei gleichmäßigem Licht ist das exakt linear. Wer es zum echten Durchgang machen will, muss auch `applyPreviewFilter` (kein früher `return view`) und `rebuild` in `js/app.js` mitziehen, sonst weichen Vorschau und Export auseinander.
- **Der Modus `clear` ist der ClearScan-Ersatz und rechnet mit Deckkraft, nicht mit Stufen.** `cov` ist 0 auf Papier und 1 auf Tinte, alles dazwischen bleibt grau. Eine harte Schwelle (`applyLevels`, wie bei `document`) erzeugt nur 0 und 255 und damit gezackte Kanten – das ist genau der Unterschied zu Adobe ClearScan.
- **Der `floor`-Parameter in `clear` ist kein Schönheitswert.** Ohne ihn schlägt das Sensorrauschen des Papiers als helles Grau von 240–250 durch und die weiße Fläche ist nur zu ~74 % weiß. Mit `floor` 0.08 sind es ~99 %.
- **`despeckle` arbeitet flächen-, nicht pixelweise.** Es sucht zusammenhängende Bereiche über `cov > 0.5` und löscht nur solche mit Fläche `<= speckArea` **und** Bounding-Box-Kantenlänge `<= speckSize`. Ein Medianfilter wäre falsch, er würde die Punzen und dünnen Striche von `i`, `j`, `:` mitfressen.
- **Der Farbfilter muss jeden Kanal einzeln flachrechnen.** Nur die Luma zu korrigieren lässt den Lichtfleck sichtbar, weil die Kanäle die Beleuchtung weiter tragen. Deshalb `chanHi[c]` pro Kanal aus dem 98 %-Perzentil.
- **Die Schwarzweiß-Schwelle liegt nicht auf dem lokalen Mittel.** `thr = mean * k - thr * (1 - k)` mit `k` aus dem `bw`-Regler; bei `k = 1` und Bias `0` wird glattes Papier zufällig gekörnt.
- **jsPDF kennt kein `output("string")`** – das liefert `null`. `doc.output()` liefert den String, `"blob"` den Blob.
- **jsPDF rendert unsichtbar mit `renderingMode: "invisible"`** (`3 Tr`), Breite über `horizontalScale` (`Tz`). Die Wortboxen kommen aus `collectOcrWords`, das sich rekursiv bis zur tiefsten Ebene mit `bbox` durch `blocks`/`paragraphs`/`lines`/`words` arbeitet.
- **Umlaute in jsPDF werden als WinAnsi-Bytes geschrieben**, nicht als Octal-Escapes; `ß` = 0xDF, `ö` = 0xF6, `Ü` = 0xDC, `ä` = 0xE4. Zum Prüfen immer binär lesen, nie als UTF-8-Text.
- **PowerShell nicht zum Umschreiben von Quellcode benutzen.** `Get-Content -Raw` liest als ANSI, `Set-Content` schreibt zurück und verdichtet jedes Umlaut zu `Ã¶`. Dateien nur mit den Dateiwerkzeugen ändern.
- `clampBox` und `applyPreviewFilter` sind gepuffert, weil sie sonst pro `pointermove` ein Bild neu in ein Canvas laden.
- Tesseract lädt seine Sprachdaten erst beim ersten Texterkennen. Deshalb stehen sie nicht in `SHELL`, sondern werden nur zur Laufzeit gecacht.
- Der Service Worker ist in `js/app.js` registriert; nach einem Feature-Wechsel `VERSION` erhöhen, sonst liefert der alte Cache die alte App aus.
- Seiten liegen nur in `state.pages` (Arbeitsspeicher). Ein Neuladen löscht sie.

## Bekannte Lücken

Keine dauerhafte Speicherung, keine Synchronisierung zwischen Geräten, keine native App. Die Texterkennung ist nicht im Browser getestet, weil die Testumgebung keine Kamera und kein Bildmaterial aus dem echten Einsatz hat.

Adobes echtes ClearScan ersetzt die Bitmap-Buchstaben durch geglättete Vektor-Konturen mit eingebetteter Schnittdatei. Das ist hier nicht nachgebaut: es bräuchte eine Glyphenerkennung samt Schrifterzeugung. Der Modus `clear` bildet nur das *Aussehen* nach (weißes Papier, dunkler Text, weiche Kanten, staubfrei) – vergrößert bleibt der Text Bitmap.

`detectQuad` behält nicht alle Kanten, sondern nur die stärksten (`edgeBinary` mit `keepRatio` 0.12). Das Budget ist knapp: der Blattumfang belegt davon den größten Teil. Mit 0.05 war die Grenze bei etwa ±2 Graustufen Hintergrundrauschen erreicht, dann verdrängten Text- und Rauschkanten die Blattkante und die Erkennung gab `null`. Deshalb 0.12 plus `hugsBorder`, das Kandidaten verwirft, die an drei oder mehr Bildrändern kleben – ohne diese Prüfung wählen größere Kantenbudgets den Bildrahmen statt des Blattes und liefern einen still falschen Ausschnitt. Ein zu knappes Budget ist harmlos, weil `null` zu manuellen Ecken führt, ein falscher Quad dagegen nicht.

## Stand

Geprüft am 2026-10-05: `node --check` für alle Skripte, vollständige Bildverarbeitungs-Testsuite grün, Filtertestsuite grün (Lichtfleck 22.9 → 0.0 Dokument / 0.9 Farb / 0.7 Original, Papier in allen vier Ecken 0 % schwarz, Original bei gleichmäßigem Licht exakt linear L1 0.0000 und im Fleckfall L1 0.002 gegen eine unabhängige Flächenkorrektur), ClearScan-Suite grün (Papier 253..255 und 98.9 % reinweiß, 409 Staubpunkte → 0, 78449 Grauton-Pixel an den Kanten mit 36 Rampenstufen, Text mittel 35.4, 103 ms), PDF-Textschicht im unkomprimierten Contentstream geprüft (`3 Tr`, `Tz`, WinAnsi), Icons per Pixelanalyse, Service-Worker-Dateiliste gegen Dateisystem. Kamerapfade und OCR-Laufzeit sind im Browser noch nicht durchgetestet; die Texterkennung wurde nur bis zur Wortboxen-Sammlung ohne echtes Tesseract geprüft.
