# Deployment checkpoint

Recorded: 2026-09-23, after the verified v5.2.0 social-source deployment.

## Non-negotiable operating constraints

- Do not buy or activate a paid subscription.
- Telegram remains the alert channel, but archive-only social posts never send direct Telegram alerts.
- Never store API keys, Telegram tokens or chat IDs in this repository or checkpoint.
- Keep the public API read-only and keep runtime state on the persistent `/data` volume.
- Do not lower signal, freshness, confirmation, deduplication or calibration thresholds to make a check pass.
- Deploy only immutable `ghcr.io/wa90-star/777-radar:<commit-sha>` images; never deploy `latest`.

## Verified production baseline

- GitHub repository: `wa90-star/777`
- Source baseline: merge commit `11ba379d2a3dc9bc2a0dc57a077cc7ab42eda3af` (PR #8)
- Immutable image: `ghcr.io/wa90-star/777-radar:11ba379d2a3dc9bc2a0dc57a077cc7ab42eda3af`
- Railway project: `accomplished-creation` (`129edff7-1574-4a45-8187-57046ff1fe0b`)
- Environment: `production` (`4d9e8751-cbf8-4cbd-822a-81c47a6bdade`)
- Service: `radar-v5-image` (`9b834ba4-9b55-4535-acb4-093475bb03de`)
- Deployment: `22a07066-ae60-47f2-94d3-ffba5af53bf2` (`SUCCESS`)
- URL: `https://radar-v5-image-production.up.railway.app`
- Volume: `radar-v5-image-volume` (`4bb78e10-f647-4ae1-94bd-76c6148ccf70`), mounted at `/data`, 500 MB
- Healthcheck: `/api/status`, timeout 90 seconds, one replica in `ams`
- Verified at `2026-09-23T20:23:48Z`: version `5.2.0`, `publicApiMode=read-only`, Telegram configured, journal and oil state `persistent:/data`, oil monitor `live`, Alpaca IEX configured/authenticated/connected, provider and monitor errors `null`.

## Verified social-source contract

- Endpoint: `trump.fm-public-api`; provider: `trump.fm`; source class: `public-archive`.
- The runtime does not automate the licensed official Truth Social endpoint.
- Archive rows require the Truth platform, a numeric Truth ID, a valid UTC timestamp and a non-empty archive checksum. A canonical Truth URL is derived from the validated ID.
- `requiresIndependentConfirmation=true`.
- `directTelegramAlerts=false`.
- Production check at `2026-09-23T20:23:48Z`: source `ok=true`, `error=null`, `warning=null`.

## Current production scope

- Core instruments: `GLD`, `SLV`, `USO`, `UNG`, `COPX`, `DBA`.
- Context instruments: `SPY`, `QQQ`, `TLT`, `UUP`.
- Oil proxies: `USO` for WTI and `BNO` for Brent, both explicitly limited to Alpaca Basic/IEX ETF data.
- Market scan window: US extended market window, 07:00-20:00 `America/New_York` on weekdays.
- Kimi mode: `off` unless an exact hash-bound, reviewed packet is deliberately imported into `shadow`; no production or Telegram influence.
- The oil monitor can be `live` while its per-product microstructure alert readiness is still warming up. This is expected after a deployment and is not a reason to lower the 120-live-minute minimum.

## Independent health watch

`.github/workflows/radar-health.yml` checks production four times per hour. The check fails closed on version regression below 5.2.0, writable public API, missing Telegram setup, non-durable state, missing/unauthenticated/disconnected Alpaca IEX oil data, provider/source errors, a non-live oil monitor, or weakening of the Trump archive contract.

## Preserved non-production services

- `chic-caring` retains the older `radar-data` volume at `/data`; its newest deployment is failed and it is not the production endpoint.
- `radar-v5-canary` remains a minimal canary and is not the production radar.
- Neither service is a fallback until it has been deliberately brought to the same immutable image and has passed the same health contract.

## Safe continuation plan

1. Keep the live universe and thresholds unchanged while the private `aktienradar-control` task `global-social-session-lag-001` is researched and reviewed.
2. Use Kimi only for source discovery, global-session timing, historical cases, counterexamples and reproducible research packets in Draft PRs.
3. Add Asian/European session logic or additional stocks only after source licensing, market-data coverage, replay tests, false-positive analysis and two shadow end-to-end runs pass.
4. Keep any future deployment pinned to the exact reviewed commit image and verify `/api/status` plus `/api/oil-monitor` twice after rollout.
5. Maintain a no-cost host-independent recovery path without weakening persistence or source checks.

## Safe restart point

Before any infrastructure change, re-read this file, confirm the exact `main` commit and immutable image, inspect Railway service configuration without changing variables, and verify both public endpoints. Do not touch secrets, thresholds, orders or paid sources.
