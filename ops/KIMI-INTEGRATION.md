# Kimi K3 → Signal Radar Pro

Stand: 22. September 2026  
Status: **Phase 1 – kontrollierter Shadow-Betrieb**

## Zielbild

Kimi erweitert die Recherchekapazität, ersetzt aber weder Marktdaten noch die deterministische Signalprüfung.

```text
Kimi Project / Work
  → privates aktienradar-control (Task, Draft-PR, Research-Paket)
  → ChatGPT/Codex-Review + Approval mit Paket-Hash
  → lokaler Importer
  → /data/kimi-research-shadow.json
  → Radar-Status/Shadow-Auswertung
  → keine Telegram-Wirkung, kein Trade, keine Schwellenänderung
```

Das öffentliche Produktionsrepository `wa90-star/777` ist **kein** Research-Postfach. Rohrecherche, private Arbeitsstände und Review-Kommentare bleiben im privaten Control-Repository.

## Welcher Kimi-Modus übernimmt was?

| Bedarf | Modus | Regel im Radar-Projekt |
| --- | --- | --- |
| Einzelne Meldung, Filing oder Quellenprüfung | K3 High / einzelner Agent | Standardfall; kleinster ausreichender Modus |
| Historische Studie, viele Quellen, Unternehmen + Politik + Marktreaktion, Red Team | Swarm | 4–8 klar getrennte Arbeitsströme, höchstens zwei Suchrunden je Strom |
| Ein kohärenter, zitierter Themenbericht | Deep Research | Bericht/Orientierung; ersetzt kein schema-validiertes Research-Paket |
| Repository bearbeiten und Tests ausführen | Kimi Code oder Codex | Im lokalen Clone, normaler Git-Branch und Draft-PR |
| Dauerhafte Dateien, Regeln und Kontext | Project / Kimi Work | Projektgedächtnis; führt ohne Auftrag nichts autonom weiter |
| Zeitgesteuerte Routine | Scheduled Task | Erst nach zwei bestandenen End-to-End-Testläufen; erzeugt nur Research-Aufträge |
| 24/7-Assistent, Messenger, dauerhafter Zustand | Claw | Noch nicht Teil des Produktionspfads; erst nach Kosten-, Rechte- und Ausfalltest |

Claw und Swarm sind nicht austauschbar: Swarm zerlegt **einen großen Auftrag parallel**. Claw bleibt **dauerhaft erreichbar und zustandsbehaftet**. Für eine einmalige Quellenstudie ist Swarm richtig; für einen späteren rund um die Uhr laufenden Research-Orchestrator könnte Claw sinnvoll werden. Der Radar selbst muss in beiden Fällen unabhängig weiterlaufen.

## Verbindlicher Freigabepfad

1. Kimi bearbeitet nur einen gültigen Task mit Status `ai:to-kimi`.
2. Das Ergebnis liegt als Draft-PR mit `research_packet.json`, `brief.md`, `source_ledger.csv` und `qa_report.md` vor.
3. ChatGPT/Codex prüft Quellen, Originalzeiten, Unabhängigkeit, Gegenbelege, Statistik und Schema.
4. Nur Andreas, ChatGPT oder Codex darf ein separates `approval.json` erstellen.
5. `approval.json` bindet die Freigabe an `task_id`, `run_id`, `revision` und den SHA-256 der **exakten Paketbytes**.
6. Der Importer verwirft jede Abweichung und erzeugt ausschließlich ein minimiertes `SHADOW_ONLY`-Bundle.
7. Der Server zeigt nur Metadaten zum Shadow-Stand. Kandidaten beeinflussen weder Signalberechnung noch Telegram.

Minimaler Freigabenachweis:

```json
{
  "schema_version": "1.0",
  "task_id": "uuuu-policy-scan-001",
  "run_id": "run-20260922-001",
  "revision": 1,
  "verdict": "approved",
  "approved_by": "codex",
  "approved_at_utc": "2026-09-22T14:45:00Z",
  "packet_sha256": "64-stelliger-sha256-hexwert",
  "source_pr": "private-control-pr-reference"
}
```

## Import und Shadow-Aktivierung

Der Import erfolgt außerhalb des öffentlichen HTTP-Servers:

```bash
npm run import:kimi -- \
  --packet /sicherer/pfad/research_packet.json \
  --approval /sicherer/pfad/approval.json \
  --out ./data/kimi-research-shadow.json
```

Ein vorhandenes, anderes Bundle wird nur mit dem bewussten Schalter `--replace` ersetzt. Danach:

```dotenv
KIMI_RESEARCH_MODE=shadow
KIMI_RESEARCH_FILE=/data/kimi-research-shadow.json
```

Der Runtime-Code akzeptiert nur `off` und `shadow`. Ein Wert wie `live` fällt geschlossen auf `off` zurück. Die öffentliche API bleibt read-only; es gibt absichtlich keinen Upload-Endpunkt.

## Harte Prüfungen

Der Import scheitert unter anderem bei:

- fehlendem oder falschem SHA-256,
- wiederverwendeter Freigabe aus einem anderen Task/Run/einer anderen Revision,
- unbekanntem Freigebenden,
- zukünftigem oder ungültigem Freigabezeitpunkt,
- unvollständigen QA-Flags,
- fehlender GPT-Review-Pflicht,
- künstlich aufgeblähter Zahl unabhängiger Quellen,
- als Primärquelle markierten Social-Aggregatoren,
- Live-/Telegram-Anforderung im importierten Bundle.

## Offener April-Öl-/Trump-Task

Der Kimi-Task im privaten Control-Repository ist korrekt mit `ai:blocked` gestoppt. Beim Lauf fehlten das `inputs/`-Material, das exakt belegte Untersuchungsjahr, Trade-/Instrumentdaten sowie Zeitzone und Auflösung.

Im Produktionsrepository existiert inzwischen ein relevanter, aber nicht automatisch vollständiger Input: `ANALYSIS-VALIDATION.md`. Er dokumentiert die geprüfte öffentliche Replikation `timothyjgraham/trump-truth-social-replication` am Commit `c196da2192a6c82bc4cae7463c8eba059ece2adb`, den tatsächlichen Datensatzzeitraum 26. Januar bis 9. April 2026 sowie USO/XLE als analysierte ETF-Proxys. Diese Datei darf als klar gekennzeichnete Voranalyse in einen **neuen Revisionslauf** übernommen werden. Sie ersetzt keinen fehlenden Original-Screenshot oder eine konkret behauptete Trade-Liste.

Vor einem Swarm-Restart muss daher explizit feststehen, ob genau diese Replikationsstudie der Untersuchungsgegenstand ist. Kimi darf die Lücke nicht durch Raten schließen.

## Nächste Freigabestufe

Erst nach zwei bestandenen End-to-End-Läufen darf Shadow-Daten eine zusätzliche, klar bezeichnete Research-Bestätigung liefern. Auch dann gelten:

- Preis-/Marktdaten kommen aus dem dafür vorgesehenen Datenprovider, nicht aus Kimi.
- Mindestens zwei wirklich unabhängige Bestätigungskategorien.
- Frische Quote, akzeptabler Spread, Anti-Late- und Gegen-Signal-Prüfung.
- Kimi-Research allein ist niemals ein Alarmgrund.
- Kein automatisches Tuning vor ausreichend großen, vorab definierten Stichproben.
