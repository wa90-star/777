# Combined free-mode runtime

The existing market/commodity and focused-equity engines remain in one Node 24
process with a new Energy Fuels primary-source collector. This is source monitoring,
not automatic valuation, a complete global-market feed or order execution.

Set `RADAR_EF_PRIMARY_ENABLED=true`, `EF_POLL_MINUTES=10`,
`OIL_DATA_MODE=free-proxy`, `KIMI_RESEARCH_MODE=off` and `RADAR_FREE_ONLY=true`.
Free-only mode bypasses the optional Twelve Data fallback without deleting its
stored credential. Alpaca requests explicitly use IEX/indicative data, with their
limited market coverage. No trade endpoint is called.

EF source events, content revisions, separate risk-review inputs and delivery
receipts live in `RADAR_DATA_DIR/ef-primary/state.sqlite`. Each source starts with
a quiet baseline. SQLite transactions preserve event/outbox consistency and
recover process death. Old versions do not expire automatically. Listing windows
are finite; a detected coverage gap stays visible instead of being cleared merely
because another fetch succeeds. Source errors are not interpreted as no news.

`/api/ef-primary/status` shows source and delivery health.
`/api/ef-primary/context` includes a bounded pending-review queue. Nonclassified
items stay retained for review and are not falsely acknowledged as delivered.
Classification is keyword triage; economic significance, EF transmission and
thesis risk are **not independently established** by this collector.

Telegram uses the already configured private recipient. Before sending, getChat
must confirm the configured numeric ID and private type; sendMessage must return
a positive message ID for exactly that recipient. This proves provider acceptance,
not reading on a device. The outbox retries failures. Delivery is at least once:
a timeout or crash between provider acceptance and local receipt can cause a
duplicate carrying the same notice ID. A receipt-storage failure pauses the
process's EF sender instead of repeatedly sending during a disk failure.

For first acceptance set `RADAR_DELIVERY_MODE=probe-only` and a unique
`RADAR_DELIVERY_PROBE_ID` (8–80 letters/digits/underscore/hyphen). Market and EF
live alerts stay inactive while sources collect. One explicitly labelled connection
test is allowed; its receipt binds to a hashed bot/recipient configuration. A
reused ID with a changed target fails closed. After confirming real source health
and receipt, change delivery mode to `live`.

The native Energy Fuels Fokus automation and its analytical decisions are a
separate consumer. The context endpoint does **not** prove that automation read
it. Existing general-engine handoffs remain durable and pending; their
ownerReadConfirmed/deliveryConfirmed fields stay false. Primary-source Telegram
delivery is reported separately and does not silently acknowledge those handoffs.

Railway Free was verified in the account with $1 monthly credit, no payment card,
and shutdown at exhausted credit. It requires serverless deployments. Genuine
existing news polling can keep the service active, but there is no guaranteed
uptime or 15-minute delivery SLA. Do not add fake keep-alive traffic. Check actual
Railway container memory/CPU/egress against the included allowance; short CI
profiles are software acceptance, not a month of billing evidence. No paid upgrade
or purchased credit is part of this setup.

The optional authenticated `/api/private-backup` exports only the configured
completed recovery snapshot, never environment variables or live SQLite files.
It is disabled without a strong `RADAR_BACKUP_ACCESS_KEY`. Keep its bearer key
outside the repository and reports. Validate the manifest and all file hashes
after download before calling the copy an external backup.
