# 777 Signal Radar Pro

## Production

- Railway service: `chic-caring`
- Runtime: `server-v4.js`
- Market engine: `market-engine-v4.js`
- Policy/social catalyst engine: `catalyst-v4.js`
- Official EIA engine: `eia-v4.js`
- Persistent signal journal: `signal-journal-v4.js` -> `/data/signal-journal.json`
- Futures provider: `massive-futures-v1.js`
- Trump/oil anomaly engine: `trump-oil-monitor-v1.js` -> `/data/trump-oil-monitor.json`
- Dashboard: `public/dashboard-v4.html`
- Primary market data: Alpaca IEX
- Market-data fallback: Twelve Data after bounded Alpaca retries
- Federal Reserve: aggregate official feed with official category-feed fallback
- Alerts: Telegram
- Futures data: Massive Futures Advanced, real-time trades, top-of-book quotes and aggregates
- Futures contracts: automatically rolled WTI (`CL`) and Brent (`BZ`) front contracts, avoiding the final five maturity days when possible
- Core symbols: GLD, SLV, USO, UNG, COPX, DBA
- Context only: SPY, QQQ, TLT, UUP
- Core scan: 5 minutes during US extended market window (07:00-20:00 America/New_York, weekdays)
- Context scan: 20 minutes
- Signal gate: price anomaly + at least one independent directional confirmation
- Extreme override: GLD, SLV, USO, UNG only
- Options: GLD, SLV, USO; indicative confirmation only; not a standalone signal
- Outcome checks: automatic 30m and 2h evaluation, persisted across restarts

## Trump/oil monitor

- Polls Donald Trump's public Truth Social account every 2 minutes through the official public account endpoint, with a mirror used only as a marked fallback, and only admits oil-relevant posts to the event linker.
- Consumes real-time WTI and Brent futures trades and best bid/offer updates over a persistent WebSocket.
- Builds one-minute features for price return, intraminute range, volume, trade count, aggressor-side volume imbalance, quote order-flow imbalance and spread.
- Uses robust median/MAD baselines by 15-minute time-of-day slot. Price history is bootstrapped from 21 days of one-minute aggregates; microstructure alerts remain disabled until at least 120 live minutes exist.
- Requires an extreme price/activity component, an extreme microstructure component and directional agreement from at least two of return, trade imbalance and quote order flow.
- Classifies each event as unexplained flow, known public catalyst, post-event anomaly or a pre-post temporal link.
- Links anomalies from 45 minutes before through 30 minutes after an oil-related post. The alert explicitly distinguishes timing evidence from proof of cause or insider knowledge.
- Clusters same-direction anomaly minutes across WTI and Brent into one fixed 30-minute market incident. The first market adds one primary alert; the other market can add one cross-market escalation, but repeated bars never become independent events.
- Clusters oil-related Trump posts within 30 minutes into one post burst, so a rapid sequence of posts cannot repeatedly confirm the same market incident.
- Tracks one primary outcome per incident after 30 and 120 minutes. Thresholds remain fixed until at least 30 valid 120-minute outcomes can be reviewed.
- Persists baselines, posts, anomalies, incidents, outcomes and counters for 45 days across deploys/restarts.
- Alerts Telegram if the Massive stream remains unavailable for five minutes after having been live, or for ten minutes during startup, and sends a recovery notice. Repeated outage notices are limited to one every six hours.

The production monitor needs Massive Futures Advanced. The Basic plan does not provide real-time WebSocket trades/quotes; Starter has delayed aggregates, and Developer remains delayed. Without Advanced the service stays visible as offline and emits no pseudo-live anomaly alerts.

## Alert contract

Every futures alert includes the contract, direction, score, basis-point move, volume/trade Z-scores, trade-imbalance Z-score, quote-OFI Z-score, effective baseline counts, event window and any linked post or known public catalyst. No alert is presented as a buy/sell instruction.

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
- Do not emit a futures anomaly until both price and live microstructure baselines meet their minimum sample counts.
- Do not describe temporal proximity to a post as proof of causation, coordination or insider trading.
- Do not commit API keys, bot tokens, chat IDs, or other secrets. Secrets stay in Railway variables.
