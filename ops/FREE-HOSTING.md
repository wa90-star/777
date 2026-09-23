# Kostenfreier, hostunabhaengiger Betrieb

## Zielbild

Railway bleibt nur die derzeit aktive Instanz. Der Radar ist als Docker-Container mit einem eigenen persistenten Volume verpackt und kann unveraendert auf einer Linux-VM oder einem bereits vorhandenen Dauerlaeufer betrieben werden. `restart: unless-stopped`, ein Container-Healthcheck und ein unabhaengiger GitHub-Watchdog sind bereits konfiguriert.

## Geeignete Ziele

1. **Oracle Cloud Always Free Compute**: bevorzugte Cloud-Zweitinstanz. Always-Free-Ressourcen laufen laut Oracle nach dem zeitlich begrenzten Test weiter. Ein Konto, Identitaetspruefung und meist eine Kreditkarte sind erforderlich. Nicht auf einen kostenpflichtigen Tarif wechseln. Quelle: <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm>
2. **Vorhandener Linux-PC, Mini-PC, NAS oder Raspberry Pi**: keine neue Cloud-Abhaengigkeit und keine Zahlungsdaten, sofern das Geraet ohnehin dauerhaft laeuft. Docker muss verfuegbar sein.
3. **Google Compute Engine e2-micro**: technisch moeglich, aber nur in bestimmten US-Regionen kostenlos und mit kostenpflichtigem Abrechnungsprofil sowie berechenbaren Ueberschreitungsrisiken. Deshalb nicht automatisch als Standard ausgewaehlt. Quelle: <https://cloud.google.com/free/docs/free-cloud-features#compute>

Render Free ist fuer diesen Radar ungeeignet: Der Dienst schlaeft nach 15 Minuten ohne eingehenden Verkehr, verliert lokale Dateien bei Schlaf/Neustart und bietet im Gratistarif keine persistenten Disks. Quelle: <https://render.com/docs/free>

## Installation auf einer kostenlosen VM

Empfohlen ist Ubuntu 24.04 LTS. Auf Oracle muss die Instanz ausdruecklich als **Always Free eligible** angezeigt werden. Eine kleine Ampere-A1-Instanz mit 1 OCPU und 6 GB RAM liegt innerhalb der dokumentierten Always-Free-Grenze und reicht fuer diesen Node-Prozess aus.

1. Docker Engine und das Docker-Compose-Plugin nach der offiziellen Anleitung installieren: <https://docs.docker.com/engine/install/ubuntu/>
2. Das Repository auf die VM holen und in das Verzeichnis wechseln.
3. Konfiguration anlegen:

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

4. In `.env` die vorhandenen Alpaca- und Telegram-Werte eintragen. `OIL_DATA_MODE=free-proxy` beibehalten.
5. Starten und pruefen:

   ```bash
   docker compose up -d --build
   docker compose ps
   curl --fail http://127.0.0.1:3000/api/status
   curl --fail http://127.0.0.1:3000/api/oil-monitor
   ```

Das Volume `signal-radar-777-data` behaelt Journal, Baselines, Vorfaelle und Auswertungen ueber Container-Neustarts und Updates hinweg. Port 3000 darf nur dann direkt im Internet freigegeben werden, wenn der oeffentliche Nur-Lese-Zugriff gewollt ist. Fuer HTTPS sollte davor ein Reverse Proxy wie Caddy oder Nginx stehen.

## Updates und Rueckkehr zu einer anderen Plattform

```bash
git pull --ff-only
docker compose up -d --build
```

Der Anwendungscode erwartet nur die Umgebungsvariablen aus `.env.example` und einen beschreibbaren Pfad `/data`. Dadurch bleibt ein spaeterer Wechsel zwischen Oracle, Google, Railway oder eigener Hardware ohne Codeumbau moeglich.

## Unabhaengige Ueberwachung

`.github/workflows/radar-health.yml` prueft die Produktions-URL viermal pro Stunde. Geprueft werden mindestens Version 5.2.0, Nur-Lese-Modus, Telegram-Konfiguration, persistenter Speicher, die konfigurierte und authentifizierte Oel-Datenquelle sowie der fail-closed Trump-Archivvertrag (`trump.fm-public-api`, vollstaendige ID-/Zeit-/Checksum-Pruefung, unabhaengige Bestaetigung erforderlich, keine direkten Telegram-Alarme). Bei einem Fehler wird genau ein offenes GitHub-Issue angelegt und nach Erholung automatisch geschlossen.

GitHub dokumentiert Standard-Runner fuer oeffentliche Repositories als kostenlos. Zeitplaene koennen verzoegert werden und werden nach 60 Tagen ohne Repository-Aktivitaet deaktiviert. Dieser Watchdog ist deshalb eine unabhaengige Warnung, aber kein Ersatz fuer die laufende VM. Quellen: <https://docs.github.com/en/billing/concepts/product-billing/github-actions> und <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule>
