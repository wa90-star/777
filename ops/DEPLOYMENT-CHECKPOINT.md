# Deployment checkpoint

Recorded: 2026-09-19, after the Railway Metal-builder failures.

## Durable repository state

- GitHub repository: `wa90-star/777`
- Main implementation merge: `e79e10ba76405836dd1256d26c4fe27815d8da1f`
- Current remote main before this checkpoint: `fb514623314bf067a7a3c6e3b3abe593a0dce2ff`
- PR 3 is merged.
- The implementation includes the Alpaca IEX oil-proxy monitor, 21 passing tests, Docker/Compose portability and the independent GitHub health workflow.

## Railway state

- Project: `129edff7-1574-4a45-8187-57046ff1fe0b`
- Environment: `4d9e8751-cbf8-4cbd-822a-81c47a6bdade`
- Service: `26a16471-2551-4163-a269-b8c9faf648f6`
- Domain: `https://chic-caring-production-d403.up.railway.app`
- Still-running deployment: `0851b97a-4931-48cd-8e17-5d9f1529600b`, version 4.9.1
- Failed new deployments: `89e7e6e1-8921-4016-80c7-fa2d13dff209`, `052c7459-359f-4843-85d1-cad15bd176ed`, `30cd5771-4e33-4bff-b916-8c041ca038d8`
- All three failed before any Docker or Node command. Their only build line is `scheduling build on Metal builder "builder-wpdzgx"`.
- The old production instance remains online; there was no production outage.

## Railway configuration already changed

- Builder is now `DOCKERFILE` with path `Dockerfile`.
- Watch patterns now include `alpaca-oil-proxy-v1.js`, `Dockerfile`, `compose.yaml` and `railway.json`.
- The versioned `railway.json` selects production build environment `V2` to avoid the failing V3 Metal builder.
- The unrelated staged patch `ee0aee5d-e22b-4b08-967c-1161743ffc06` remains untouched and must not be accepted.

## Exact continuation

The checkpoint commit containing this file also touches the self-watching `railway.json`, so it should automatically trigger the next Railway deployment.

1. Inspect that automatically triggered Railway deployment. Confirm that its config reports build environment `V2` and that it gets past builder scheduling.
2. Verify `/api/status` reports version `5.1.0`, persistent storage and configured Telegram; verify `/api/oil-monitor` reports `free-proxy`, authenticated Alpaca IEX and persistent state.
3. Run the GitHub health workflow or wait for its first scheduled run, then confirm no incident issue remains open.
4. Create the hourly ChatGPT condition watch for production unavailability.
5. A genuinely independent second live host still requires an Oracle Always Free account or an existing always-on Linux device. The repository is already ready for either; do not purchase anything.
