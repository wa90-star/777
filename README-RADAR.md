# 777 Signal Radar Pro

Production setup:

- Railway service: `chic-caring`
- Runtime launcher: `start-v2.js`
- Market scanner: `index.js` (runtime-patched on deploy)
- Dashboard: `public/dashboard-v2.html`
- Market data: Twelve Data
- Alerts: Telegram
- Watchlist: SPY, QQQ, AAPL, MSFT, NVDA, TSLA
- Automatic scan cadence: 7 minutes during US extended market window (07:00-20:00 America/New_York, weekdays)
- High-priority alerts: Telegram

Do not commit API keys, bot tokens, or chat IDs. Secrets stay in Railway variables.
