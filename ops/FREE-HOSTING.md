# Kostenfreier Betrieb: Vorbereitung und Abnahme

Stand der Dokumentation: 30. September 2026. Diese Dateien bereiten einen Umzug vor; sie belegen keine vorhandene VM, keinen aktiven Gratis-Tarif und keinen erfolgreichen Produktivstart. Der zuletzt geprüfte Railway-Dienst war wegen abgelaufenem Trial offline. Ein neuer Host benötigt einen eigenen Laufzeit- und Datenabnahmetest.

## Architektur und Grenzen

Der bestehende Node-Radar kann auf einem dauernd laufenden Linux-Host mit Docker betrieben werden. Eine App/PWA ist eine Oberfläche für diesen Dienst; sie ersetzt weder den dauernden Quellenabruf noch Persistenz, sichere Zugangsdaten oder die Alarmzustellung. Kimi bleibt in `off` oder `shadow`; sein Ausfall darf den Kernradar nicht blockieren.

- **Oracle Always Free:** ein möglicher kostenloser Hauptserver, sobald Konto, Home-Region, freie Kapazität und tatsächlich ausgewählte Ressourcen geprüft sind. Laut [Oracle-Dokumentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) sind A1-Kontingente und Boot-/Block-Volumes gemeinsam begrenzt. Ressourcen dürfen nur innerhalb der tatsächlich freien Grenzen angelegt werden. Keine automatische Konto-Hochstufung. Oracle kann gering ausgelastete Always-Free-VMs zurückfordern; eine unterbrechungsfreie Laufzeit ist damit nicht belegt.
- **Vorhandener Linux-PC/NAS/Mini-PC:** geeignet, wenn Stromversorgung, Internet und Dauerbetrieb gesichert sind. Hardware und Strom sind keine neuen Cloud-Gebühren, aber nicht automatisch kostenlos. Kein Standby während des Betriebs.
- **GitHub Actions:** Tests und unabhängige Zustandsprüfung. Ein [Zeitplan kann verspätet ausgeführt werden](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule); er ist kein Echtzeitserver. Bei privaten Repositories muss das tatsächlich verbleibende Minutenkontingent geprüft sein.

Für Oracle A1 ist ARM64 relevant. Das vorhandene Dockerfile kann auf dem Zielhost nativ gebaut werden. Ein fertiges Image darf erst genutzt werden, wenn dessen Manifest die Zielarchitektur bestätigt. Ein x86-Test ist kein ARM-Laufzeittest.

## Dateien und read-only Vorprüfung

`compose.free-host.yaml` ist eine eigenständige Alternative zu `compose.yaml`, kein zusätzlich gleichzeitig zu startender Dienst. Es verwendet denselben Projektnamen und dasselbe benannte Volume `signal-radar-777-data`, bindet den HTTP-Port aber fest an `127.0.0.1`. Ein Browserzugriff von außen benötigt einen gesondert geprüften HTTPS-Reverse-Proxy. Port 3000 wird nicht direkt freigegeben.

Auf dem **Zielhost**, mit lokalem Docker-Kontext und Node.js 24 oder neuer:

```bash
node ops/free-host-preflight.mjs
```

Das Skript führt ausschließlich lesende Docker-Befehle aus. Es startet, baut, installiert, kopiert oder stoppt nichts. Es kontrolliert:

- Linux und unterstützte Host-/Docker-Architektur, Docker Engine und Compose v2;
- private `.env`-Dateirechte und Anwesenheit der vier Alpaca-/Telegram-Werte, ohne Werte oder rohe Docker-Fehler auszugeben;
- `free-proxy`, Kimi-Isolation, `/data`-Mount, Loopback-Port, read-only Root und Neustartregel;
- tatsächliches Volume sowie genau einen existierenden, laufenden und gesunden Container mit dem erwarteten Mount und Port.

Vor dem ersten Aufbau sind fehlende Container und Volumes erwartete Blocker. Exit 1 bedeutet fehlende technische Voraussetzungen. Exit 0 bedeutet nur, dass die abgefragten technischen Prüfungen bestanden sind. `productionReady` bleibt ausdrücklich `false`, weil Tarif, vollständige Datenübernahme, Neustartfestigkeit, externe Erreichbarkeit und Zustellung separat belegt werden müssen. Docker-Health allein prüft HTTP-Erreichbarkeit, nicht die Qualität aller Datenquellen. `unless-stopped` startet nach einem Prozessabbruch neu, heilt aber keinen weiterlaufenden ungesunden Prozess.

## Zugangsdaten und bisherige Daten

Auf dem Zielhost wird eine private `.env` benötigt. Die Variablennamen stehen in `.env.example`: `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHAT_ID`. Es werden vorhandene Zugangsdaten übernommen; keine neuen kostenpflichtigen APIs aktiviert. `OIL_DATA_MODE=free-proxy` und `KIMI_RESEARCH_MODE=off` bleiben die Ausgangswerte. Schlüssel niemals in Git, Issues, Chats, Befehlszeilenargumenten oder Prüfberichten speichern.

**Die bisherige `/data`-Historie muss vor einem Umzug zugänglich und gesichert sein.** Eine leere neue Datenablage ist keine Migration. Ein HTTP-404 des alten Diensts sagt nichts darüber aus, ob das Railway-Volume noch wiederherstellbar ist. Solange ein überprüfbarer Export fehlt, bleibt die Datenübernahme offen.

Ein bereits sicher exportiertes Verzeichnis lässt sich ohne Änderung prüfen:

```bash
node ops/free-host-preflight.mjs --backup-directory /secure/radar-export/data
```

Kontrolliert werden reguläre lesbare JSON-Dateien für Journal, Katalysatoren, EIA, ECB und Ölmonitor. Die Ausgabe enthält nur Dateinamen, Größen und SHA-256-Prüfsummen. Fehlende, ungültige oder per Symlink referenzierte Dateien schlagen fehl. Gültiges JSON belegt weder die vollständige Historie noch einen erfolgreichen Restore. Weitere Zustandsdateien, insbesondere ein vorhandenes Kimi-Research-Paket und neu hinzukommende Alarm-Warteschlangen, gehören ebenfalls zum **vollständigen** `/data`-Export.

Die Übernahme erfolgt erst nach verifiziertem Quellbackup und auf einem abgesicherten Zielhost. Die Originaldateien bleiben erhalten. Bei einem späteren Neustarttest sind historische Einträge und Duplikatsperren zu kontrollieren; reine Änderungen der Dateiprüfsummen sind bei laufendem Betrieb erwartbar. Kein `down -v`, kein Volume-Pruning und kein blindes Überschreiben.

## Start erst nach den Voraussetzungen

Docker Engine und Compose nach der [offiziellen Linux-Anleitung](https://docs.docker.com/engine/install/ubuntu/) installieren. Die bestehende Datenablage muss nachvollziehbar in das benannte Zielvolume übertragen und für den Containerbenutzer schreibbar sein; dies erledigt der Preflight nicht. Vor dem Start sicherstellen, dass kein zweiter aktiver Radar dieselben Telegram-Alarme sendet.

Wenn Gratisberechtigung, Zugang, vorhandene Daten und Konfiguration belegt sind:

```bash
docker compose -f compose.free-host.yaml up -d --build
node ops/free-host-preflight.mjs --backup-directory /secure/radar-export/data
RADAR_BASE_URL=http://127.0.0.1:3000 node ops/health-check.mjs
```

Diese Startbefehle sind dokumentiert, wurden durch das Hinzufügen der Dateien aber nicht ausgeführt. Der Build benötigt Netzwerkzugriff für das Node-Basisimage. Bei Imagewechseln muss dessen Version/Architektur geprüft werden.

Für die Produktivabnahme zusätzlich die vollständige Zustandsprüfung gegen die echte HTTPS-Adresse ausführen. Pflichtquellen müssen aktuell und fehlerfrei sein, Alpaca muss authentifiziert sein, Öl muss live sein und alle Zustände müssen unter `/data` liegen. Danach Neustartfestigkeit und eine ausdrücklich als Test gekennzeichnete Telegram-Zustellung kontrollieren. Ein Test darf weder einen echten Handelsalarm imitieren noch bereits versendete Signale erneut senden. Erst mit diesen Ergebnissen ist die Einrichtung abgeschlossen.

## Nachweise dieser Vorbereitung

```bash
node --test test/free-host-preflight.test.mjs
```

Diese Tests verwenden Dateien und Docker-Stubs, um Fehlzustände und die geheimnisfreie Ausgabe zu prüfen. Sie beweisen keine reale Oracle-VM, kein Docker-Deployment und keine Telegram-Verbindung. Ein zusätzlicher echter Preflight in der Arbeitsumgebung muss fehlenden Docker-Zugriff und fehlende Produktionsdaten als Blocker ausweisen.
