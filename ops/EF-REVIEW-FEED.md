# Energy Fuels review feed

This is a read-only source-history feed, not a connected native Fokus consumer or an economic assessment engine.

`GET /api/ef-primary/review-feed?afterSequence=0&limit=20`

The first response returns `throughSequence`, `nextAfterSequence`, `hasMore` and `items`. To finish that snapshot, retain `throughSequence` and request the next page with `afterSequence=nextAfterSequence`. At the next review cycle, omit `throughSequence` to include later source notices. `limit` is 1–50 (default20); cursors are nonnegative safe integers. Unknown, repeated, noncanonical or future query values fail with400. Unavailable or disabled existing history returns503 without filesystem details. POST and other public writes remain405.

Both delivered and pending SOURCE_NEW/SOURCE_UPDATED notices are included, including UNCLASSIFIED_REVIEW. Historical source title and publication metadata come from the original revision, not the latest event. A→B→A observations retain separate sequence/notice identities. Missing historical snapshots fail closed. Pages omit full article bodies, private risk reviews, portfolio details and Telegram receipt identifiers. Source classification remains unassessed; transport status does not acknowledge review.

The SQLite connection is read-only. A GET neither initializes missing history nor changes delivery, review or cursor state. Snapshot pagination is bounded and uses the existing outbox sequence; no migration or separate event copy is needed. The payload is projected in SQL before loading, excluding large historical bodies.

Baseline-only events and the general radar's separate persistent EF handoff stream are outside this incremental feed. Read the existing handoff view separately when assessing that stream. Recording a cursor/version in a Fokus chat proves only what that chat actually recorded, not an authenticated database review acknowledgement.

No existing production CLI for review acknowledgements was found. This patch intentionally adds none: a future private authenticated maintenance path would validate consumer, source sequence/version, decision version, evidence and disposition, append its independent review receipt, and advance a cursor only over contiguous completed work. It must never reuse Telegram ACK as a review ACK or expose a public write endpoint. `nativeFokusAutomationConnected` and `consumerAcknowledged` remainfalse until an actual integration is separately demonstrated.

DOE article-date enrichment is outside this change. An unknown source publication time remains unknown; scanstart is not a guaranteed first-publication time or a15-minute service guarantee.
