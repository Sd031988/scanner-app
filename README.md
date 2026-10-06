# Dokumentenscanner

Offlinefähige PWA zum Scannen von Papierdokumenten, Rechnungen und Quittungen. Kein Build-Schritt, keine Abhängigkeiten zum Installieren, keine Cloud, keine Kosten, kein Wasserzeichen.

Die App startet sofort in die Kamera. Ohne Kamera (z. B. am PC) bietet sie direkt den Import von Fotos und Bildern an.

## Dateien

| Datei | Zweck |
| --- | --- |
| `index.html` | App-Shell: Kamerabildschirm, Review, Seitenliste, Textansicht |
| `app.css` | dunkles, randloses Design mit grünen Bedienelementen |
| `js/vision.js` | Bildverarbeitung: Kantenerkennung, Kanten-Feinjustierung, Entzerren, Filter, Schärfe, Stabilität |
| `js/app.js` | Kamera, Import, Live-Overlay, Editor, Seitenliste, Speichern auf dem Gerät, Export, OCR |
| `manifest.webmanifest` | PWA-Installation, Icon-Set |
| `sw.js` | Offline-Cache (App-Shell + Bibliotheken) |
| `vendor/` | jsPDF, Tesseract.js, WASM-Core, Sprachdaten `deu` + `eng` |
| `icons/` | 192/180/512 + maskable |

## Ablauf

1. **Kamera** – der grüne Rahmen folgt dem Blatt automatisch. Er leuchtet kräftig, wenn das Blatt ruhig und scharf ist.
2. **Oder Import** – unten rechts „Import“: ein oder mehrere Fotos/Bilder wählen. Die App sucht das Blatt im Bild; findet sie keins, wird das ganze Bild übernommen. Mehrere Bilder werden nacheinander zur Bearbeitung geöffnet.
3. **Auslöser** – Foto aufnehmen, der Rahmen wird zu einer Vorschau entzerrt.
4. **Review** – vier Ecken mit Lupe ziehen, `Auto` erkennt die Kanten erneut, `Drehen` dreht das Blatt um 90°, Filter mit Vorschau wählen.
5. **Übernehmen** – die Seite landet in der Seitenliste, die Kamera läuft weiter.
6. **Seitenliste** – Dateiname festlegen, Thumbnails sortieren (ziehen), drehen (↻), löschen (✕), einzeln als JPG speichern (↓), antippen zum Nachbearbeiten. „Neu“ (zweimal tippen) leert das Dokument.

## Funktionen

- Automatische Blatterkennung auf dem Gerät, kein Netzwerkzugriff
- Kanten-Feinjustierung: nach der groben Erkennung wird jede Blattkante in voller Auflösung entlang der Normalen gesucht und per robuster Geradenanpassung neu gesetzt. Dadurch landet kein Streifen Tischhintergrund im Scan
- Perspektivisches Entzerren (Homografie) mit Ziehen der Ecken und Lupe
- Import von Fotos und Bildern (JPG, PNG, WebP; mehrere auf einmal), EXIF-Ausrichtung wird beachtet
- Fünf Filter: Original (nur entzerrt und zugeschnitten, unverändert), Farbe, Klar, Dokument (Kontrast), S/W (Schwellwert)
- **Klar** ist der ClearScan-ähnliche Modus: reines Weiß fürs Papier, dunkler Text, weiche Buchstabenkanten. Er arbeitet nicht mit einer harten Stufung, sondern mit der Deckkraft des Textes, sodass die Kanten zwischengraue Töne behalten; einzelne Staubpunkte werden als zusammenhängende Flecken erkannt und entfernt
- Farbe, Klar, Dokument und S/W entfernen den Lichtfleck über ein geglättetes Papiertonfeld
- Mehrseitige Sammlung mit Sortieren per Ziehen, Drehen, Löschen und Nachbearbeiten
- Seiten und Dateiname werden auf dem Gerät gespeichert (IndexedDB) und sind nach Neuladen oder erneutem Öffnen wieder da
- Eigener Dateiname für PDF, TXT und JPG
- Export als ein A4-PDF mit automatischer Ausrichtung je Seite, Einzelbild als JPG
- Teilen über die native Dialoge des Handys, Druckansicht im Browser
- Texterkennung (Deutsch + Englisch): Ergebnis in einer Textansicht zum Bearbeiten, Kopieren oder Speichern als TXT. Bereits erkannte Seiten werden nicht erneut erkannt
- Die Texterkennung legt den Text zusätzlich unsichtbar in jedes PDF: jedes Wort an seiner gemessenen Position und Größe mit Textrender-Modus „unsichtbar“. Das PDF bleibt dadurch durchsuchbar und kopierbar
- Zoom, Blitz und Kamerawechsel, sofern das Gerät es anbietet
- Läuft offline, Service Worker cacht die App; OCR-Assets werden beim ersten Texterkennen geladen

## Lokal starten

```powershell
cd C:\Users\Durra\scanner-app
python -m http.server 8123
```

Dann `http://localhost:8123` öffnen. Über `start.cmd` erledigt.

## Kamera braucht einen sicheren Kontext

Browser geben `getUserMedia` nur über **HTTPS** oder `localhost` frei. Über `http://192.168.x.x` (also die LAN-IP des PCs) bleibt die Kamera im Browser blockiert, auch wenn die Seite lädt. Der Bild-Import funktioniert auch dann.

Optionen für die Nutzung auf dem Handy:

1. **Empfohlen – Tunnel (2 Befehle):**

   ```powershell
   cd C:\Users\Durra\scanner-app
   python -m http.server 8123
   # zweites Fenster:
   cloudflared tunnel --url http://localhost:8123
   ```

   Ergebnis ist eine `https://xxx.trycloudflare.com`-Adresse.

2. **Statisch hosten** (GitHub Pages, Netlify, Cloudflare Pages): Verzeichnis hochladen, fertig.

3. **Mobil am eigenen Server** mit gültigem TLS-Zertifikat.

Zur Installation auf dem Handy: Seite in Chrome/Edge öffnen → Menü → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.

## Verhalten beim Wechseln

Die Kamera wird beim Wechsel in den Hintergrund und beim Schließen der Seite freigegeben, damit die LED nicht brennen bleibt. Beim Zurück aus dem Review startet sie erneut.

## Geprüft (06.10.2026)

In Chromium mit simulierter Kamera (schräg fotografierte Rechnung auf dunklem Hintergrund) und ohne Kamera:

- Blatterkennung live, Auslösen, Entzerren, alle Filter, Übernehmen
- Umsortieren per Ziehen, danach Löschen und Einzelbild speichern treffen die richtige Seite
- Drehen einer Seite, Dateiname, Neuladen: Seiten, Reihenfolge und Name bleiben erhalten
- „Neu“ mit Sicherheitsabfrage leert das Dokument dauerhaft
- PDF (A4, mehrere Seiten, Dateiname), Texterkennung im Browser (2 Seiten in wenigen Sekunden), Textansicht, Kopieren, TXT, durchsuchbares PDF
- Ohne Kamera: Hinweis mit Import-Knopf, Import von zwei Bildern nacheinander, Bild ohne Blatt wird ganz übernommen
- Ränder der PDF-Seiten frei von Hintergrundstreifen
- Browser-Konsole ohne Fehler

Nicht geprüft: echte Handykamera, Blitz, Zoom, Teilen-Dialog auf dem Handy.

## Grenzen

- Texterkennung nur Deutsch und Englisch. Weitere Sprachen (z. B. Dari/Persisch, Paschtu) bräuchten zusätzliche Sprachdateien in `vendor/tessdata/`
- Seitwärts liegende Seiten werden von der Texterkennung nicht erkannt – vorher mit ↻ drehen
- Kein PDF-Import, keine Synchronisierung zwischen Geräten, keine native App, kein App-Store
- Die Seiten liegen im Browser-Speicher des Geräts. Wer die Website-Daten des Browsers löscht, löscht auch die Scans
