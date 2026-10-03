# 777 Signal Radar Pro

## Production

- Railway project/environment/service: `accomplished-creation` / `production` / `radar-v5-image`
- Production image policy: deploy only immutable `ghcr.io/wa90-star/777-radar:<commit-sha>` tags; never deploy `latest`
- Host-independent runtime: `Dockerfile` and `compose.yaml`; Railway is the current instance, not a permanent dependency
- Railway build configuration: `railway.json` pins the Dockerfile and the non-Metal V2 fallback build environment
- Free failover guide: `ops/FREE-HOSTING.md`
- Independent public-repository watchdog: `.github/workflows/radar-health.yml`
- Runtime: `server-v4.js`
- Market engine: `market-engine-v4.js`
- Policy/social catalyst engine: `catalyst-v4.js`
- Structural supply/demand discovery: `structural-intelligence-v1.js` -> `/data/structural-intelligence.json`
- Focused equity confirmation engine: `equity-structural-v1.js`
- Free House PTR filing discovery: `house-disclosures-v1.js` -> `/data/house-disclosures-state.json`; dashboard + `/api/politician-disclosures`, research-only. Scope, budget and source checks: [ops/POLITICIAN-DISCLOSURES.md](ops/POLITICIAN-DISCLOSURES.md).
- Official EIA engine: `eia-v4.js`
- Persistent signal journal: `signal-journal-v4.js` -> `/data/signal-journal.json`
- Free oil-proxy provider: `alpaca-oil-proxy-v1.js`
- Optional futures provider: `massive-futures-v1.js`
- Trump/oil anomaly engine: `trump-oil-monitor-v1.js` -> `/data/trump-oil-monitor.json`
- Radar-2 deterministic decision gate: `decision-engine-v5.js`; its execution-quality gate is integrated into the production market alert path, while the decision module itself remains side-effect free
- Kimi approval/import gate: `kimi-research-v1.js` + `scripts/import-kimi-research.js`
- Kimi shadow store: `research-store-v1.js` -> optional `/data/kimi-research-shadow.json`
- Dashboard: `public/dashboard-v4.html`
- Primary market data: Alpaca IEX
- Market-data fallback: Twelve Data after bounded Alpaca retries
- Federal Reserve: aggregate official feed with official category-feed fallback
- Alerts: Telegram
- Oil data: the default `free-proxy` mode uses the existing free Alpaca IEX connection for USO and BNO. The optional futures source is enabled only with `OIL_DATA_MODE=massive` and a compatible `MASSIVE_API_KEY`.
- Free-mode instruments: USO as a WTI proxy and BNO as a Brent proxy. Both are explicitly labeled as ETF proxies and never presented as futures.
- Optional futures contracts: automatically rolled WTI (`CL`) and Brent (`BZ`) front contracts, avoiding the final five maturity days when possible
- Core symbols: GLD, SLV, USO, UNG, COPX, DBA
- Context only: SPY, QQQ, TLT, UUP
- Core scan: 5 minutes during US extended market window (07:00-20:00 America/New_York, weekdays)
- Context scan: 20 minutes
- Signal gate: price anomaly + at least one independent directional confirmation
- Extreme price moves on GLD, SLV, USO and UNG are discovery inputs only; they do not bypass the independent-evidence or execution-quality alert gates
- Options: GLD, SLV, USO; indicative confirmation only; not a standalone signal
- Outcome checks: automatic 30m and 2h evaluation, persisted across restarts
- Focused equity watchlist default: UUUU, MU, MP, INTC; override with `RADAR_EQUITY_WATCHLIST`, hard-capped at eight symbols
- Structural discovery interval: 15 minutes by default; override with `STRUCTURAL_SCAN_MINUTES` (10-60 minutes)
- Structural discovery has no direct Telegram path. A structural event must first be seen across at least two independent publisher groups, then the affected equity must confirm the same direction in live market data and pass the existing execution-quality gate.

## Structural equity intelligence

This layer is designed for developments that are easy to miss in a ticker-only scanner: production-capacity changes, mass-production milestones, supply constraints, export restrictions, new competitive entrants, technology steps, customer/offtake agreements and similar supply-demand shifts.

Google News RSS is used only as a low-cost discovery index. A single article cannot create an alert. Matching reports are clustered by theme, entity and structural mechanism; promotion requires at least two independent publisher groups, a directional hypothesis for a symbol on the focused watchlist and a structural score of at least 70. The promoted event remains a hypothesis until the affected stock confirms the same direction in Alpaca market data. Twelve Data remains fallback-only and cannot bypass the execution-quality gate.

Example: verified CXMT DRAM capacity/technology expansion can create a bearish competition/supply hypothesis for MU. It does not itself create a SHORT alert. Only a same-direction MU price/velocity confirmation with executable market data can do that. The same architecture covers Energy Fuels/rare-earth or uranium progress, MP Materials and Intel-specific structural milestones.

Endpoints:
- `/api/structural`: raw structural discoveries, verified clusters, source health and verification state
- `/api/equities`: focused equity watchlist, current structural hypotheses, market confirmation and execution-gate state

## Kimi research layer

Kimi K3 is an external research layer, not a market-data provider or alert engine. Research travels through the private `aktienradar-control` workflow, receives a separate human/Codex approval bound to the packet SHA-256, and is then imported with `npm run import:kimi`. The runtime accepts only `off` or `shadow`; imported candidates have no production or Telegram influence.

The full operating contract, mode selection (K3 Agent vs Swarm vs Claw), approval format, importer command, and the blocked April-study handoff are documented in [`ops/KIMI-INTEGRATION.md`](ops/KIMI-INTEGRATION.md).

## Trump/oil monitor

- Reads Donald Trump's publicly archived Truth posts every 2 minutes from `trump.fm-public-api`. The runtime does not automate the licensed official Truth Social endpoint.
- Admits an archive row only after platform, numeric Truth ID, UTC timestamp and archive checksum validation; it emits a canonical Truth URL from the validated ID.
- Archive posts are discovery/timing evidence only: `requiresIndependentConfirmation=true` and `directTelegramAlerts=false`. Only oil-relevant posts enter the event linker.
- In the no-cost production mode, consumes real-time IEX trades and best bid/offer updates for USO and BNO over one persistent Alpaca WebSocket.
- In proxy mode, the public API reports these under `oilData*`; every `futuresData*` field stays explicitly unconfigured so an ETF proxy cannot be mistaken for a futures feed.
- The free feed is an exchange subset and follows US equity extended hours. It cannot observe the full WTI/Brent futures market or futures trading outside those hours.
- If `OIL_DATA_MODE=massive` and a compatible `MASSIVE_API_KEY` are supplied later, the same incident engine switches to real WTI and Brent futures. Stored proxy and futures baselines and calibration samples remain separated.
- Builds one-minute features for price return, intraminute range, volume, trade count, aggressor-side volume imbalance, quote order-flow imbalance and spread.
- Uses robust median/MAD baselines by 15-minute time-of-day slot. Price history is bootstrapped from 21 days of one-minute aggregates; microstructure alerts remain disabled until at least 120 live minutes exist.
- Requires an extreme price/activity component, an extreme microstructure component and directional agreement from at least two of return, trade imbalance and quote order flow.
- Classifies each event as unexplained flow, known public catalyst, post-event anomaly or a pre-post temporal link.
- Links anomalies from 45 minutes before through 30 minutes after an oil-related post. The alert explicitly distinguishes timing evidence from proof of cause or insider knowledge.
- Clusters same-direction anomaly minutes across WTI and Brent into one fixed 30-minute market incident. The first market adds one primary alert; the other market can add one cross-market escalation, but repeated bars never become independent events.
- Clusters oil-related Trump posts within 30 minutes into one post burst, so a rapid sequence of posts cannot repeatedly confirm the same market incident.
- Tracks one primary outcome per incident after 30 and 120 minutes. Thresholds remain fixed until at least 30 valid 120-minute outcomes can be reviewed.
- Persists baselines, posts, anomalies, incidents, outcomes and counters for 45 days across deploys/restarts.
- Alerts Telegram if the selected stream remains unavailable for five minutes after having been live, or for ten minutes during startup, and sends a recovery notice. Repeated outage notices are limited to one every six hours.

The default production monitor has no additional data fee. It uses the already configured Alpaca Basic IEX feed. Massive Basic remains useful for historical futures research but does not provide the real-time futures trades and quotes required by the stronger futures mode. The service therefore never labels the free ETF mode as futures order flow.

## Alert contract

Every oil alert includes the instrument, data scope, direction, score, basis-point move, volume/trade Z-scores, trade-imbalance Z-score, quote-OFI Z-score, effective baseline counts, event window and any linked post or known public catalyst. No alert is presented as a buy/sell instruction. Free-mode Telegram alerts state that USO/BNO and IEX are proxies with limited market coverage.

The audit of the prior April event study and the reasons its headline result is not treated as a valid signal are documented in `ANALYSIS-VALIDATION.md`.

## External performance log

Google Sheet: `SIGNAL_RADAR_MASTER_LOG`

- Historical manual/legacy records remain in `Signal-Log` and are never overwritten by the v4 runtime.
- Current automated 777 records are mirrored into `777-Auto` by the low-frequency sync task.
- Calibration remains observation-only until at least 20 decisive trusted 2h samples exist.

## Rules

- Commodity-first; do not scan the entire equity market. Structural equity monitoring is restricted to the explicit watchlist and hard-capped at eight symbols.
- Do not use general news as the primary trigger when an official/primary source exists. Secondary news discovery can only promote a structural event after independent multi-publisher confirmation and still requires market confirmation.
- Avoid duplicate alerts and startup alerts.
- Do not auto-tune production thresholds before sufficient samples exist.
- Never turn raw or merely Kimi-produced research into an alert; require an exact packet hash, explicit approval, and the deterministic radar gate.
- Keep Kimi research in shadow mode until two complete end-to-end test runs pass.
- Do not emit an oil anomaly until both price and live microstructure baselines meet their minimum sample counts.
- Never mix proxy and futures baselines or describe USO/BNO observations as WTI/Brent futures activity.
- Do not describe temporal proximity to a post as proof of causation, coordination or insider trading.
- Do not commit API keys, bot tokens, chat IDs, or other secrets. Keep them only in each host's protected environment or local `.env`; `.env` is ignored by Git.
