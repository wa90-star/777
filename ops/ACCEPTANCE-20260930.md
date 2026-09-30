# Free-runtime preparation: acceptance evidence

This change prepares a portable host and fixes observable delivery gaps. It is not a declaration of live readiness or trading performance.

## Implemented

- Persistent per-channel delivery outbox for eligible policy/EIA events. The two-message batch limit no longer discards the remaining events. Retry exhaustion, expiry and storage errors stay visible.
- Telegram receipts and sanitized errors are exposed separately from mere credential presence. No live credentials are required by tests.
- HTTP health checks retain both endpoint failures, enforce source age boundaries, and detect delivery failures/backlogs and market errors.
- Independent GitHub health workflow accepts a repository `RADAR_BASE_URL` variable for the verified replacement host, while retaining the current fallback URL.
- A separate loopback-only Compose configuration and read-only preflight verify host prerequisites and backup structure without revealing secrets.
- A pull-request acceptance workflow builds an isolated container with no network or credentials, verifies API write rejection, non-root volume access and restart persistence, and verifies an ARM64 build. It does not deploy or publish an image.

## Verification levels

1. `npm test`: simulated source/provider failures, real temporary state files, real local HTTP responses. No successful live Telegram/Alpaca session is implied.
2. `node ops/container-smoke.mjs <local-image>`: real container process and anonymous volume, isolated from external networks. Requires Docker. This cannot run in the current workspace because Docker is absent; CI is the execution environment.
3. `node ops/free-host-preflight.mjs`: real workspace result is not ready because target Docker, private configuration, source backup and target runtime are unavailable.
4. Live acceptance remains open: actual free account/resource eligibility, target access, full `/data` recovery and restore, HTTPS reachability, current authenticated sources, two post-restart health checks and a clearly labeled Telegram test receipt.

## Limits and follow-up

- The old Railway endpoint returned HTTP 404 on 2026-09-30; prior historical deployment success is not current availability.
- There is no verified Oracle VM or SSH access. The Oracle console currently returned `Site Unavailable` in the available browser; this does not prove a provider-wide outage.
- GitHub schedules can be delayed; the existing watchdog is independent monitoring, not a realtime process or a guaranteed 15-minute alarm channel.
- Kimi's present authenticated end-to-end handoff remains unverified. Keep off/shadow and require a reviewed hash-bound packet. Do not infer present connectivity from an old PR.
- Outbox callbacks and Telegram are separate acknowledgements. Lost Telegram acknowledgement can cause an at-least-once duplicate; exactly-once is not claimed.
- Failed entries remain available for explicit review. Delayed messages older than the 30-minute delivery window are failed rather than presented as fresh.
- This patch does not add new paid sources, weaken confirmation requirements, expand the instrument universe, or prove news-source coverage such as WSJ/Hertha.
- Before claiming a time advantage, record source publication, first detection and confirmed delivery times on live events. Before claiming signal quality, evaluate the existing 30/120-minute outcome records and comparable longer-horizon samples; passing infrastructure tests is not evidence of profitability.
