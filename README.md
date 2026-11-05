# 777 Signal Radar Pro

Der technische Betriebs- und Analysekontext steht in [README-RADAR.md](README-RADAR.md).

Mit `RADAR_GENERAL_INFO_MODE=true` melden die bestehenden Politik-, EIA- und ECB-Quellen relevante Ereignisse als Informationshinweise, auch ohne Alpaca. Meldungen enthalten Quelle, Datum und Ereignis-ID; sie bestätigen keine Kursbewegung und erteilen keine Handelsfreigabe. Der spezialisierte Primärquellenradar für Energy Fuels wird separat über `RADAR_EF_PRIMARY_ENABLED=true` aktiviert. Beide verwenden denselben privaten Telegram-Transport.

Vor dem regulären Versand kann `RADAR_DELIVERY_MODE=probe-only` mit einer einmaligen `RADAR_DELIVERY_PROBE_ID` den Telegram-Weg prüfen. Erst `RADAR_DELIVERY_MODE=live` schaltet die gewöhnlichen Meldungen frei. Neue Ereignisse werden vor dem Versand dauerhaft gespeichert; ein Telegram-Erfolg benötigt einen echten Empfangsbeleg. Anfangsbestände werden still eingelesen. Fehlerhafte oder abgelaufene Zustellungen bleiben sichtbar. Nach verloren gegangener Telegram-Antwort sind Doppelmeldungen möglich.

Eine gespeicherte Energy-Fuels-Übergabe beweist keine Verarbeitung durch den separaten Fokus-Chat. Solange kein echter Empfängerbeleg vorliegt, bleibt im Informationsmodus auch der entsprechende allgemeine Quellenhinweis zustellbar; mögliche Überschneidungen werden benannt. Der bisherige Modus bleibt bei `RADAR_GENERAL_INFO_MODE=false` erhalten. Ein kostenloses Hosting-Guthaben begrenzt die Laufzeit und garantiert keinen unterbrechungsfreien Monatsbetrieb.

Fuer einen hostunabhaengigen Gratisbetrieb stehen ein Docker-Image, `compose.yaml` und der Leitfaden [ops/FREE-HOSTING.md](ops/FREE-HOSTING.md) bereit.

Ein optionaler interner Kurskontext ohne Alpaca verwendet Twelve Data Basic mit dauerhaften Kontingentgrenzen. Aktivierung, Teilmarktabdeckung und Grenzen der Veröffentlichung sind in [ops/TWELVE-BASIC-CONTEXT.md](ops/TWELVE-BASIC-CONTEXT.md) beschrieben. Dieser Kontext beeinflusst keine Handelsfreigaben und blockiert keine Quellenmeldung.

Die kontrollierte Kimi-K3-/Swarm-Anbindung ist in [ops/KIMI-INTEGRATION.md](ops/KIMI-INTEGRATION.md) beschrieben und bleibt zunächst strikt im Shadow-Modus.
