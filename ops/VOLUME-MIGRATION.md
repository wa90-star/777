# Vollständige Datenübernahme ohne Überschreiben

Dieses Werkzeug bereitet die Übernahme eines **tatsächlich exportierten** `/data`-Verzeichnisses vor. Es meldet keine Migration als abgeschlossen, weil Code oder Tests existieren. Es führt keine Netzwerkzugriffe, Railway-Aktionen, Anmeldungen, Deployments oder Löschungen aus. Node.js 24 und Linux werden vorausgesetzt.

## Noch offener Quellenzugang

Der bisherige Datenstand liegt im Railway-Projekt `accomplished-creation`, Umgebung `production`, Dienst `radar-v5-image`:

- Projekt: `129edff7-1574-4a45-8187-57046ff1fe0b`
- Umgebung: `4d9e8751-cbf8-4cbd-822a-81c47a6bdade`
- Dienst: `9b834ba4-9b55-4535-acb4-093475bb03de`
- Volume: `4bb78e10-f647-4ae1-94bd-76c6148ccf70`, Mount `/data`

Die [offizielle Railway-CLI](https://docs.railway.com/cli/volume) bietet rekursiven Volume-Download. **Authentifizierung allein genügt hier nicht:** Die geprüfte CLI 5.63.1 ruft in `volume_file_target` zuerst `ensure_service_has_active_deployment` auf. Für den derzeit inaktiven Dienst mit abgelaufenem Trial ist dieser Exportpfad deshalb blockiert. Ein erfolgreicher CLI-Download oder installierter CLI-Zugang wurde bisher nicht belegt; der versuchte Binary-Download scheiterte am Proxy-Timeout. Eine Anmeldung allein ist keine Wiederherstellung des Datenzugangs. Kein kostenpflichtiges Upgrade aktivieren, kein neues leeres Volume als Ersatz deklarieren.

Erst wenn Zugang **und aktives Deployment** vorhanden sind, kann der vollständige Volumeroot mit diesem dokumentierten Pfad in ein neues privates Verzeichnis heruntergeladen werden. Die CLI-Version/Optionen zuvor mit `railway volume files --help` prüfen. Kein `--overwrite` verwenden:

```bash
railway volume --project 129edff7-1574-4a45-8187-57046ff1fe0b \
  --environment 4d9e8751-cbf8-4cbd-822a-81c47a6bdade \
  --service 9b834ba4-9b55-4535-acb4-093475bb03de \
  files --volume 4bb78e10-f647-4ae1-94bd-76c6148ccf70 \
  download / /secure/radar-transfer/run-001/source-data
```

**Konsistenz ist gesondert sicherzustellen:** keine gleichzeitig veränderliche Live-Dateisammlung als atomaren Snapshot ausgeben. Wenn der Dienst läuft, zuerst einen kontrolliert erstellten, abgeschlossenen Recovery-Snapshot verwenden oder einen freigegebenen konsistenten Export durchführen. Der CLI-Download selbst beweist keine Konsistenz. HTTP-Endpunkte enthalten weder alle Historien noch alle Duplikatsperren und ersetzen keinen vollständigen Export. Das bestehende Railway-Volume bleibt unverändert erhalten.

## 1. Privates Bundle erstellen und prüfen

`source-data` muss wirklich der exportierte Volumeroot sein, nicht ein übergeordnetes Downloadverzeichnis. Darin die bekannten Dateien `signal-journal.json`, `catalyst-state.json`, `eia-state.json`, `ecb-state.json` und `trump-oil-monitor.json` prüfen. Ein bestehendes Kimi-Paket, Outbox-Daten, Unterverzeichnisse, Punktdateien und `.radar-recovery` gehören mit zum Export. Fehlende Historie nicht erfinden oder durch leere JSON-Dateien ersetzen.

Das übergeordnete Transferverzeichnis muss bereits existieren, privat sein (`0700`) und außerhalb jedes Git-Repositories liegen. Darin das Bundle unter einem **noch nicht existierenden** Namen erstellen:

```bash
node ops/volume-migration.mjs capture \
  --source /secure/radar-transfer/run-001/source-data \
  --bundle /secure/radar-transfer/run-001/bundle
```

Das Ergebnis enthält nur Dateianzahl, Gesamtgröße und `manifestSha256`; keine Dateiinhalte oder Zugangsdaten. Den Hash getrennt vom Bundle vertrauenswürdig aufbewahren. Er ist der Vergleichswert nach der Übertragung und darf nicht einfach aus dem am Ziel angekommenen Manifest neu übernommen werden.

```bash
node ops/volume-migration.mjs verify \
  --bundle /secure/radar-transfer/run-001/bundle \
  --manifest-sha256 'HIER_DEN_64_STELLIGEN_CAPTURE_HASH_EINSETZEN'
```

Das Bundle besteht aus `manifest.json` und `data/`. Es übernimmt sämtliche regulären Dateien und leeren Verzeichnisse des angegebenen Quellverzeichnisses ohne Dateifilter. Jede Datei wird über Größe und SHA256 geprüft; zusätzliche oder fehlende Dateien schlagen fehl. Symlinks, Sonderdateien, unsichere Manifestpfade und doppelte Einträge werden abgelehnt. Dieses Werkzeug kopiert den gegebenen Datenstand vollständig, kann aber nicht beweisen, dass bereits der vorgelagerte Railway-Download vollständig war oder dass die Fachhistorie plausibel ist.

Das Bundle ist eine private, unverschlüsselte Kopie. Nur über authentifiziertes SSH/SCP/rsync in ein ebenfalls privates Zielverzeichnis übertragen; niemals über öffentliche Links, ein Git-Repository, CI-Artefakte oder Logs. Geheimnisse in `.env` werden separat über einen sicheren Kanal bereitgestellt. Das Werkzeug exportiert keine Railway-Umgebungsvariablen.

## 2. Ausschließlich in ein leeres, unbenutztes Ziel wiederherstellen

Oracle-Gratisberechtigung, erreichbarer SSH-Zugang, genügend Speicher und Docker müssen zuerst tatsächlich belegt sein. Ein Quellbackup wird vor Beginn und nach SSH-Übertragung mit **demselben zuvor notierten Hash** geprüft.

Der Ziel-Radar darf noch nicht laufen. Bei einem neuen Docker-Volume `signal-radar-777-data` dessen tatsächlichen lokalen Mountpoint per `docker volume inspect` bestimmen und kontrollieren, dass kein Container das Volume verwendet. Nicht raten und kein bestehendes gefülltes Volume leeren. Dieses Werkzeug erstellt kein Docker-Volume.

**Restore auf dem Host ausführen**, auf das vorhandene leere Volume-Verzeichnis. Nicht innerhalb eines Containers auf dessen eingehängtes `/data` anwenden: ein aktiver Mountpoint lässt sich nicht atomar ersetzen. Das Werkzeug baut die Wiederherstellung in einem privaten Nachbarverzeichnis auf demselben Dateisystem auf und ersetzt erst nach vollständiger Verifikation den nochmals geprüften leeren Verzeichniseintrag per atomarem Rename. Kopierfehler verändern den leeren Zielinhalt nicht. Andere Benutzer/Prozesse dürfen währenddessen weder Bundle noch Zielpfad verändern.

UID und GID des vorgesehenen Containerbenutzers aus **dem ausgewählten Image** ermitteln. Für das derzeitige Node-Image sind typischerweise `1000:1000` zu erwarten; vor Anwendung prüfen. Die Option ist zwingend explizit. Auf dem Host sind für fremde UID/GID und Docker-Verzeichnisse Root-Rechte erforderlich:

```bash
sudo node ops/volume-migration.mjs restore \
  --bundle /secure/radar-transfer/run-001/bundle \
  --target /TATSAECHLICHER/LEERER/DOCKER-VOLUME-PFAD \
  --manifest-sha256 'HIER_DEN_64_STELLIGEN_CAPTURE_HASH_EINSETZEN' \
  --owner 1000:1000
```

Alle wiederhergestellten Dateien erhalten `0600`, Verzeichnisse `0700` und die ausdrücklich angegebene UID/GID. Dateiinhalte bleiben unverändert. Alte Quellrechte, Eigentümer, Änderungszeiten oder Hardlink-Beziehungen werden nicht als wiederhergestellte Metadaten ausgegeben; Hardlinks werden als unabhängige Inhaltskopien übertragen. Damit werden etwaige Rechte des Downloadbenutzers nicht blind zur Produktivkonfiguration. Das vorhandene Container-Entrypoint bereitet später das Wurzelverzeichnis für den Laufzeitbenutzer vor.

Eine zweite Wiederherstellung auf dasselbe nun gefüllte Ziel wird abgelehnt. Weder Quelle, Bundle noch vorhandene Dateien werden entfernt. Bei einem Abbruch während des Kopierens, vor dem atomaren Abschluss, bleiben `<bundle>.partial` beziehungsweise `<target>.radar-import.partial` als private Spuren erhalten; derselbe Auftrag überschreibt sie nicht. Ursache prüfen und mit einem neuen Ziel/Stage arbeiten, statt Beweisdaten automatisch zu löschen. Bei Platzmangel, Hashfehler oder einem Mountpoint-Fehler den Radar nicht starten. Schlägt die abschließende Verzeichnissynchronisation nach dem Rename fehl, kann das vollständige Ziel bereits existieren; dann Zustand prüfen, nicht blind erneut importieren oder löschen.

## 3. Tatsächlichen Betrieb gesondert abnehmen

Nach erfolgreichem Restore müssen vorhandene Historie, Duplikatsperren und ausstehende Outbox-Einträge am Ziel nachweisbar sein. Erst anschließend genau einen Radar starten. Quellen, Alpaca-Authentifizierung, Telegram-Zustellbeleg, Gesundheitsendpunkte und Neustartfestigkeit wie in `FREE-HOSTING.md` prüfen. Der Plattformwechsel entfernt weder Aufwärmzeiten noch Datenlücken.

Auf Oracle ARM64 den überprüften Commit nativ bauen oder ein tatsächlich geprüftes ARM64-Image verwenden. Ein bisheriger ARM-Buildtest ist kein erfolgreicher Produktivlauf. Ein erfolgreiches `capture`, `verify` oder `restore` ist ausdrücklich **kein** Beleg für aktive Oracle-/Railway-Konten, funktionierende Provider oder zugestellte Alarme.

## Tests

`node --test test/volume-migration.test.mjs` verwendet ausschließlich lokale Wegwerfverzeichnisse mit künstlichen Journal-/Outbox-/Recovery-Daten. Es prüft vollständige Inhaltsübernahme, Hashanker, Symlinks/Pfadmanipulation, Platzmangel, Änderungen während der Kopie, Teilabbruch und No-Overwrite. Produktionsdaten werden dabei weder erzeugt noch übernommen.
