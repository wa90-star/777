# 777 Signal Radar Pro

## Production

- Railway service: `chic-caring`
- Host-independent runtime: `Dockerfile` and `compose.yaml`; Railway is the current instance, not a permanent dependency
- Railway build configuration: `railway.json` pins the Dockerfile and the non-Metal V2 fallback build environment
- Free failover guide: `ops/FREE-HOSTING.md`
- Independent public-repository watchdog: `.github/workflows/radar-health.yml`
- Runtime: `server-v4.js`
- Market engine: `market-engine-v4.js`
- Policy/social catalyst engine: `catalyst-v4.js`
- Official EIA engine: `eia-v4.js`
- Persistent signal journal: `signal-journal-v4.js` -> `/data/signal-journal.json`
- Free oil-proxy provider: `alpaca-oil-proxy-v1.js`
- Optional futures provider: `massive-futures-v1.js`
- Trump/oil anomaly engine: `trump-oil-monitor-v1.js` -> `/data/trump-oil-monitor.json`
- Radar-2 deterministic decision gate: `decision-engine-v5.js` (side-effect free; not yet the production alert path)
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
- Extreme override: GLD, SLV, USO, UNG only
- Options: GLD, SLV, USO; indicative confirmation only; not a standalone signal
- Outcome checks: automatic 30m and 2h evaluation, persisted across restarts

## Kimi research layer

Kimi K3 is an external research layer, not a market-data provider or alert engine. Research travels through the private `aktienradar-control` workflow, receives a separate human/Codex approval bound to the packet SHA-256, and is then imported with `npm run import:kimi`. The runtime accepts only `off` or `shadow`; imported candidates have no production or Telegram influence.

The full operating contract, mode selection (K3 Agent vs Swarm vs Claw), approval format, importer command, and the blocked April-study handoff are documented in [`ops/KIMI-INTEGRATION.md`](ops/KIMI-INTEGRATION.md).

## Trump/oil monitor

- Polls Donald Trump's public Truth Social account every 2 minutes through the official public account endpoint, with a mirror used only as a marked fallback, and only admits oil-relevant posts to the event linker.
- In the no-cost production mode, consumes real-time IEX trades and best bid/offer updates for USO and BNO over one persistent Alpaca WebSocket.
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

- Commodity-first; do not scan the entire equity market.
- Do not use general news as the primary trigger when an official/primary source exists.
- Avoid duplicate alerts and startup alerts.
- Do not auto-tune production thresholds before sufficient samples exist.
- Never turn raw or merely Kimi-produced research into an alert; require an exact packet hash, explicit approval, and the deterministic radar gate.
- Keep Kimi research in shadow mode until two complete end-to-end test runs pass.
- Do not emit an oil anomaly until both price and live microstructure baselines meet their minimum sample counts.
- Never mix proxy and futures baselines or describe USO/BNO observations as WTI/Brent futures activity.
- Do not describe temporal proximity to a post as proof of causation, coordination or insider trading.
- Do not commit API keys, bot tokens, chat IDs, or other secrets. Keep them only in each host's protected environment or local `.env`; `.env` is ignored by Git.
