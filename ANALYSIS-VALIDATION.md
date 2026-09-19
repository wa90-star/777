# Validierung der April-Auswertung zu Trump-Posts und Öl-Orderflow

## Ergebnis

Die alte Auswertung liefert eine interessante Hypothese, aber kein belastbares Live-Signal. Der zentrale Dollarwert und die behauptete Zahl unabhängiger Ereignisse sind durch Mehrfachzählungen desselben Marktfensters verzerrt. Die Ergebnisse dürfen deshalb weder als Beleg für Insiderhandel noch als Grundlage für einen Handelsalarm verwendet werden.

Bewertung: **Needs revision / hypothesis only**

## Geprüfte Quelle

- Öffentliche Replikation: <https://github.com/timothyjgraham/trump-truth-social-replication>
- Geprüfter Commit: `c196da2192a6c82bc4cae7463c8eba059ece2adb`
- Reproduktion: `make reproduce` wurde vollständig in einer isolierten Umgebung ausgeführt.
- Prüfdatum: 19. September 2026

## Wesentliche Befunde

### 1. Dokumentation und tatsächlicher Datensatz widersprechen sich

| Prüfung | Dokumentation | Tatsächliche Datei |
|---|---:|---:|
| Alle Posts | 1.847 | 1.341 |
| Ölbezogene Posts | 165 | 173 |
| Zeitraum | in den Begleittexten nicht konsistent | 26. Januar bis 9. April 2026 |

Auch die dokumentierten Spalten stimmen nicht vollständig mit dem Parquet-Schema überein. Das ist kein bloßer Darstellungsfehler, weil Stichprobengröße und Zeitraum direkt in die Interpretation der Signifikanz eingehen.

### 2. Der Dollar-Headlinewert enthält Pseudoreplikation

Die 81 als einzelne Treffer gezählten Post-Zeilen beruhen auf nur 17 unterschiedlichen 5-Minuten-Marktpositionen. Bei einer konservativen Zusammenfassung mit 60 Minuten Mindestabstand bleiben 15 Marktcluster übrig.

| Zählweise | Zahl der Einheiten | Summierter Wert |
|---|---:|---:|
| Jede ausgelöste Post-Zeile | 81 | +159,88 Mio. USD |
| Einmal je eindeutigem 5-Minuten-Marktfenster | 17 | -3,45 Mio. USD |
| Einmal je 60-Minuten-Marktcluster | 15 | -26,85 Mio. USD |

Am 7. April liegen allein 28 Posts in ungefähr 14 Minuten. Dieselben Marktbewegungen werden dadurch mehrfach denselben oder nahezu identischen Ereignisfenstern zugerechnet. Nach elementarer Deduplizierung verschwindet der Headlinewert und wechselt sogar das Vorzeichen.

### 3. Die ETF-Balken tragen kein belastbares After-Hours-Orderflow-Signal

Die zwischengespeicherten 5-Minuten-Balken für USO und XLE enthalten jeweils ungefähr 10.700 Zeilen. Rund 57,5 Prozent dieser Balken haben Volumen null; diese Fälle liegen im erweiterten Handelszeitraum. Gleichzeitig verändern sich Preise in Balken mit ausgewiesenem Volumen null.

Von den 81 ausgelösten Vorfenstern enthalten 34 ausschließlich Null-Volumen-Balken. In 35 von 81 Vorfenstern besteht mindestens die Hälfte der Balken aus Null-Volumen-Daten. Bar-basierte Näherungen für BVC, VPIN oder OFI können daraus kein tatsächliches aggressorseitiges Orderflow-Verhalten ableiten.

### 4. Der Placebo-Test prüft nicht die behauptete Differenz

Die Placebo-Zeitpunkte werden aus der Stunden- und Wochentagsverteilung aller Trump-Posts gezogen, nicht aus der Verteilung der ölbezogenen Posts. Zudem wird dasselbe Placebo für verschiedene Themen wiederverwendet und Ereigniszeiten werden nicht konsequent ausgeschlossen.

Die Kennzeichnung `robust` entsteht aus einer Differenz der Signifikanzentscheidungen:

- reales Ergebnis: `p < 0,05`
- Placebo: `p > 0,05`
- reales FDR-Ergebnis: `q < 0,10`

Das ist kein direkter Test der Differenz zwischen realem und Placebo-Effekt. „Signifikant“ gegenüber „nicht signifikant“ beweist selbst keine signifikante Differenz.

Beim hervorgehobenen XLE-OFI-Ergebnis ist auch das Placebo hochsignifikant. Der Code markiert diese Zeile deshalb selbst als `robust: false`, obwohl die Begleitdarstellung sie als wichtigen Treffer behandelt.

### 5. Die Zeitverschiebungsprüfung ist unzureichend

Ein Shift um 24 Stunden verändert den Wochentag. Die ausgelösten Ereignisse häufen sich aber insbesondere an Sonntag, Montag und Dienstag. Damit kontrolliert der Test den Wochentagseffekt nicht sauber. Erforderlich wären mindestens ein Shift um sieben Tage, mehrere positive und negative Lags sowie ein Ausschluss überlappender Ereignisfenster.

## Konsequenz für den produktiven Monitor

Der neue Monitor zählt Marktvorfälle statt Post-Zeilen oder einzelne auffällige Minuten:

1. Reale WTI- und Brent-Futures-Trades sowie Best-Bid/Best-Ask-Quotes ersetzen ETF-Balken als Orderflow-Grundlage.
2. Auffällige Minuten gleicher Richtung werden innerhalb eines festen 30-Minuten-Fensters zu genau einem Vorfall zusammengefasst. Das Fenster wird am ersten Ereignis verankert und kann nicht endlos weiterlaufen.
3. WTI und Brent im selben Vorfall erhöhen die Evidenz, erzeugen aber keinen zweiten unabhängigen Vorfall.
4. Mehrere ölbezogene Trump-Posts innerhalb von 30 Minuten bilden einen Post-Schub. Ein Vorfall kann dadurch nur einmal bestätigt werden.
5. Preis, Volumen, Trade-Imbalance und Quote-OFI werden gegen robuste Median/MAD-Baselines derselben Tageszeit geprüft.
6. Bekannte öffentliche Auslöser wie das planmäßige EIA-Fenster werden separat klassifiziert und nicht als unerklärter Flow alarmiert.
7. Jeder Vorfall erhält nur einen primären Outcome-Anker. Die richtungsbereinigte Entwicklung wird nach 30 und 120 Minuten protokolliert.
8. Schwellen bleiben fest, bis mindestens 30 auswertbare 120-Minuten-Vorfälle vorliegen. Es gibt keine automatische Optimierung anhand einer kleinen Stichprobe.

## Zulässige Aussage

Ein Alert bedeutet ausschließlich: In den Live-Futures ist ein statistisch ungewöhnlicher, richtungskonsistenter Marktvorfall aufgetreten, der nicht sofort durch einen bekannten öffentlichen Katalysator erklärt wurde oder zeitlich mit einem ölbezogenen Trump-Post zusammenfällt.

Er bedeutet nicht, dass ein Post die Bewegung verursacht hat, dass ein bestimmter Händler beteiligt war oder dass Insiderwissen vorlag. Diese Unterscheidung muss in Dashboard, Telegram und jeder späteren Auswertung erhalten bleiben.
