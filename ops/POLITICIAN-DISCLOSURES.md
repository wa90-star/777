# Politiker-Offenlegungen: kostenlose Recherche-Ergänzung

## Nutzen und Umfang

Der Radar beobachtet die kostenlose jährliche PTR-Dateiliste des US House Clerk
für Nancy Pelosi und Marjorie Taylor Greene. Das ergänzt `pelosiOfficial`, das
weiterhin ausschließlich Pelosis Pressemitteilungen verarbeitet. Ein neu
erkannter Originalbeleg erscheint im Dashboard und unter dem lesenden Endpunkt
`/api/politician-disclosures`. Die Quellenlage, Datenmenge und Fehler stehen auch
unter `politicianDisclosures` in `/api/status`.

Dies ist **Offenlegungs-Erkennung**, noch keine automatische Auswertung einzelner
Transaktionen. Das verhindert eine erfundene Zuordnung zu Aktien, Handelstagen,
Kauf/Verkauf oder Optionsgeschäften. Der PDF-Originalbeleg muss diese Angaben erst
belegen. Ein Kauf des Ehepartners ist beispielsweise nicht automatisch ein Kauf
der Politikerin. `transactionDate` und `publishedAt` bleiben bis dahin `null`;
`filingDate` ist ein Datum ohne erfundene Uhrzeit/Zeitzone. `firstSeenAt` bezeichnet
nur den ersten Abruf durch diesen Radar, unabhängig von Einreichung und Handel.

Die Quelle liefert nur das Repräsentantenhaus, keine Senats- oder Bundestagsdaten.
Jede Dokument-ID ist genau eine Ursprungsquelle. Kopien bei Quiver, Autopilot,
Dub oder anderen Trackern sind keine zusätzlichen unabhängigen Bestätigungen.
Der neue Kanal hat keine Verbindung zu Signal-Scoring, Broker, Telegram oder
Kimi-Freigaben. Bestehende Bestätigungs- und Marktdaten-Gates bleiben erhalten.

## Effizienz und Persistenz

- Ein bedingter Abruf alle 15 Minuten, mit `ETag` und `Last-Modified`.
- Höchstens 2 MiB je ZIP und 4 MiB entpackter Index; keine PDF-Massenabrufe,
  keine zusätzlichen Pakete oder bezahlten APIs.
- 8 MiB tägliches Budget für empfangene ZIP-Nutzdaten. Überschreitung stoppt
  weitere Abrufe bis zum nächsten UTC-Tag; der auslösende Stream-Chunk kann
  die Grenze geringfügig überschreiten. HTTP/TLS-Overhead ist nicht enthalten.
  Der Zähler wird nach dem Abruf gespeichert; ein harter Prozessabbruch während
  des Downloads kann diesen einzelnen Abruf im Tageszähler fehlen lassen.
- Rate-Limit-Antworten respektieren `Retry-After`; keine sofortige Retry-Schleife.
- `/data/house-disclosures-state.json` hält bekannte IDs, Fingerprints,
  unveränderliche Ersterkennungszeiten, Cache-Validatoren und Budget.
- Erster Start stellt einen ruhigen Bestand her. Neue IDs sind `newly-observed`,
  Änderungen von Indexmetadaten `index-update`; dies behauptet keine inhaltliche
  Änderung des PDFs. Der Monitor lädt PDF-Inhalte nicht automatisch nach.
- Im Januar/Februar wird ein bereits beobachtetes Vorjahr mitgeprüft. Ein neuer
  Jahresindex nach bestehender Überwachung zählt als neue Beobachtung. Spätere
  rückwirkende Änderungen älterer Jahresindizes sind außerhalb des Umfangs.
- Nach 45 Minuten ohne erfolgreichen Abruf ist die Quelle als veraltet markiert.
  Ein fehlgeschlagener Abruf oder defekte Zustandsdatei wird sichtbar und nicht
  als leere/gesunde Quelle ausgegeben. Persistenzfehler blockieren Netzwerkzugriff.

Die Prüfung am 2026-10-03 UTC ergab eine 62.080-Byte-ZIP mit `2026FD.txt` und
`2026FD.xml`, `ETag` und `Last-Modified`. Der echte Parser erkannte drei passende
Pelosi-PTRs; ein Original-PDF wurde erfolgreich geöffnet. Bei unveränderter Größe
wären selbst 96 vollständige Downloads/Tag etwa 5,96 MB/Tag bzw. 179 MB/30 Tage.
304-Antworten sparen die ZIP-Nutzdaten. Dies ist eingehender Quellenverkehr,
keine Aussage über Railway-Egress, Gesamtkosten oder Betriebsfähigkeit.

## Warum keine App-Anbindung?

- Quiver stellt strukturierte Daten bereit, verlangt für die API aber 30 USD
  monatlich (25 USD/Monat bei jährlicher Zahlung). Premium-Webabo und API sind
  getrennt. Keine bestehende API-Berechtigung wurde vorausgesetzt oder erworben.
- Autopilot/Dub automatisieren Modellportfolios nach verspäteten Offenlegungen;
  sie ersetzen keinen früheren Originaldatenzugang. Dub setzt gemäß seiner
  veröffentlichten Zulassung US-Wohnsitz, SSN sowie US-Staatsbürgerschaft oder
  dauerhafte Aufenthaltsberechtigung voraus. Eine Autopilot/IBKR-Anbindung und
  allgemeine Verfügbarkeit in Deutschland sind nicht belegt.
- Der Screenshot nennt keinen eindeutig identifizierbaren „Pelosi Tracker“ als
  separaten API-Anbieter. Dafür wird kein Datenvertrag erfunden.

## Offizielle Quellen (geprüft 2026-10-03 UTC)

- https://disclosures-clerk.house.gov/FinancialDisclosure/ViewReport
- https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip
- https://disclosures-clerk.house.gov/FinancialDisclosure/ViewSearch
- https://ethics.house.gov/periodic-transaction-report-calculator/
- https://api.quiverquant.com/pricing/
- https://www.quiverquant.com/premium-vs-api/
- https://www.joinautopilot.com/pelosi-tracker
- https://start.joinautopilot.com/blog/autopilot-outside-the-us
- https://support.dubapp.com/hc/en-us/articles/20011390716187-Politician-Portfolios
- https://support.dubapp.com/hc/en-us/articles/35548026115483-Eligibility-Requirements-and-Account-Opening-Timeline

PTRs müssen nach House-Ethics-Angabe grundsätzlich bis zum früheren Zeitpunkt
von 30 Tagen nach Kenntnis oder 45 Tagen nach der Transaktion eingereicht werden.
Das ist keine garantierte maximale Veröffentlichungslatenz. Die Clerk-Seite
nennt Nutzungsbeschränkungen, insbesondere kommerzielle Zwecke (mit Ausnahme
bestimmter Nachrichten-/Mediennutzung), Kreditwürdigkeitsprüfung, Werbung und
unrechtmäßige Zwecke. Dieser Adapter ist für persönliche Recherche vorgesehen,
nicht als Lizenz für eine öffentliche kommerzielle Datenweiterverwertung.

Eine Codeintegration ist kein Deployment-Nachweis. Ohne laufenden Radar-Host
finden keine periodischen Abrufe statt. Es wurden keine Produktionskonfiguration,
Konten, Broker-Verbindungen oder kostenpflichtigen Ressourcen verändert.
