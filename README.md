# Dokumentenscanner

Offlinefähige PWA zum Scannen von Papierdokumenten, Rechnungen und Quittungen. Kein Build-Schritt, keine Abhängigkeiten zum Installieren, keine Cloud, keine Kosten, kein Wasserzeichen.

Die App startet sofort in die Kamera. Keine Startseite, keine Tabs, keine Dashboards.

## Dateien

| Datei | Zweck |
| --- | --- |
| `index.html` | App-Shell: Kamerabildschirm, Review, Seitenliste |
| `app.css` | dunkles, randloses Design mit grünen Bedienelementen |
| `js/vision.js` | Bildverarbeitung: Kantenerkennung, Entzerren, Filter, Schärfe, Stabilität |
| `js/app.js` | Kamera, Live-Overlay, Editor, Seitenliste, Export, OCR |
| `manifest.webmanifest` | PWA-Installation, Icon-Set |
| `sw.js` | Offline-Cache (App-Shell + Bibliotheken) |
| `vendor/` | jsPDF, Tesseract.js, WASM-Core, Sprachdaten `deu` + `eng` |
| `icons/` | 192/180/512 + maskable |

## Ablauf

1. **Kamera** – der grüne Rahmen folgt dem Blatt automatisch. Er leuchtet kräftig, wenn das Blatt ruhig und scharf ist.
2. **Auslöser** – Foto aufnehmen, der Rahmen wird zu einer Vorschau entzerrt.
3. **Review** – vier Ecken mit Lupe ziehen, `Auto` erkennt die Kanten erneut, `Drehen` dreht das Blatt um 90°, Filter mit Vorschau wählen.
4. **Übernehmen** – die Seite landet in der Seitenliste, die Kamera läuft weiter.
5. **Seitenliste** – Thumbnails sortieren (ziehen), löschen, erneut bearbeiten, einzelnes Bild speichern.

## Funktionen

- Automatische Blatterkennung auf dem Gerät, kein Netzwerkzugriff
- Perspektivisches Entzerren (Homografie) mit Ziehen der Ecken und Lupe
- Fünf Filter: Original, Farbe, Klar, Dokument (Kontrast), Schwarzweiß (Schwellwert)
- **Klar** ist der ClearScan-ähnliche Modus: reines Weiß fürs Papier, dunkler Text, weiche Buchstabenkanten. Er arbeitet nicht mit einer harten Stufung, sondern mit der Deckkraft des Textes, sodass die Kanten zwischengraue Töne behalten und beim Zoomen nicht treppenförmig wirken; einzelne Staubpunkte werden als zusammenhängende Flecken erkannt und entfernt, ein Rauschsockel hält das Papier reinweiß
- „Original" ist kein Durchgang mehr: es korrigiert nur die Beleuchtung. Jeder Farbkanal wird durch das geglättete Papiertonfeld geteilt, Sättigung, Kontrast und Tonwerte bleiben unangetastet, bei gleichmäßigem Licht ist das Ergebnis exakt linear
- Alle Filter entfernen den Lichtfleck: pro Kachel wird der 80 %-Papierton ermittelt, das Feld geglättet und das Bild darauf normalisiert; Farbe und Dokument rechnen danach zusätzlich mit Tonwertkurve
- Mehrseitige Sammlung mit Sortieren per Ziehen, Löschen und Nachbearbeiten
- Export als ein A4-PDF mit automatischer Ausrichtung je Seite, Einzelbild als JPG
- Teilen über die native Dialoge des Handys, Druckansicht im Browser
- Texterkennung (Deutsch + Englisch) aus den gescannten Seiten, Ausgabe als TXT
- Die Texterkennung legt den erkannten Text zusätzlich unsichtbar in jedes PDF: jedes Wort wird an seiner gemessenen Position und Größe mit Textrender-Modus „unsichtbar“ gesetzt, das Bild bleibt unverändert sichtbar. Das PDF bleibt dadurch durchsuchbar und kopierbar
- Zoom, Blitz und Kamerawechsel, sofern das Gerät es anbietet
- Läuft offline, Service Worker cacht die App; OCR-Assets werden beim ersten Texterkennen geladen

## Lokal starten

```powershell
cd C:\Users\Durra\scanner-app
python -m http.server 8123
```

Dann `http://localhost:8123` öffnen. Über `start.cmd` erledigt.

## Kamera braucht einen sicheren Kontext

Browser geben `getUserMedia` nur über **HTTPS** oder `localhost` frei. Über `http://192.168.x.x` (also die LAN-IP des PCs) bleibt die Kamera im Browser blockiert, auch wenn die Seite lädt.

Optionen für die Nutzung auf dem Handy:

1. **Empfohlen – Tunnel (2 Befehle):**

   ```powershell
   cd C:\Users\Durra\scanner-app
   python -m http.server 8123
   # zweites Fenster:
   cloudflared tunnel --url http://localhost:8123
   ```

   Ergebnis ist eine `https://xxx.trycloudflare.com`-Adresse. Handy und PC müssen im selben WLAN sein.

2. **Statisch hosten** (GitHub Pages, Netlify, Cloudflare Pages): Verzeichnis hochladen, fertig. Danach „Installieren" im Kopfbereich der App.

3. **Mobil am eigenen Server** mit gültigem TLS-Zertifikat.

Zur Installation auf dem Handy: Seite in Chrome/Edge öffnen → Menü → „App installieren" bzw. „Zum Startbildschirm hinzufügen".

## Verhalten beim Wechseln

Die Kamera wird beim Wechsel in den Hintergrund und beim Schließen der Seite freigegeben, damit die LED nicht brennen bleibt. Beim Zurück aus dem Review startet sie erneut.

## Geprüft

- `node C:\Users\Durra\AppData\Local\Temp\opencode\test-vision.js`: Kantenerkennung, Eckengenauigkeit, Reihenfolge, Entzerren, Textzeilen, Drehung, vier Filter, Schärfe, Stabilität, Homografie und Inverse, PDF mit zwei Seiten
- `node --check` für alle Skripte
- Icons per Pixelanalyse geprüft (Eckwinkel, Zentrierung, Maskable-Safe-Zone)
- Service-Worker-Dateiliste gegen Dateisystem geprüft

## Grenzen

- Seiten bleiben nur im Arbeitsspeicher. App schließen = weg.
- Die Texterkennung lädt beim ersten Mal rund 3 MB Sprachdaten vom eigenen Server.
- Keine native App, kein App-Store
- Kein Speichern in der Cloud, keine Synchronisierung zwischen Geräten
