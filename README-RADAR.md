# 777 Signal Radar Pro

## Production

- Railway service: `chic-caring`
- Runtime: `server-v4.js`
- Market engine: `market-engine-v4.js`
- Policy/social catalyst engine: `catalyst-v4.js`
- Official EIA engine: `eia-v4.js`
- Persistent signal journal: `signal-journal-v4.js` -> `/data/signal-journal.json`
- Dashboard: `public/dashboard-v4.html`
- Primary market data: Alpaca IEX
- Market-data fallback: Twelve Data
- Alerts: Telegram
- Core symbols: GLD, SLV, USO, UNG, COPX, DBA
- Context only: SPY, QQQ, TLT, UUP
- Core scan: 5 minutes during US extended market window (07:00-20:00 America/New_York, weekdays)
- Context scan: 20 minutes
- Signal gate: price anomaly + at least one independent directional confirmation
- Extreme override: GLD, SLV, USO, UNG only
- Options: GLD, SLV, USO; indicative confirmation only; not a standalone signal
- Outcome checks: automatic 30m and 2h evaluation, persisted across restarts

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
- Do not commit API keys, bot tokens, chat IDs, or other secrets. Secrets stay in Railway variables.
