# Deployment checkpoint

Recorded: 2026-09-20, after the successful v5.1.0 image deployment and the first independent health-watch run.

## Non-negotiable operating constraints

- Do not buy or activate a paid subscription.
- Railway is transitional because its trial expires.
- Telegram remains the alert channel.
- Keep full radar capability; reduce waste, not analytical coverage.
- Never store API keys, Telegram tokens or chat IDs in this repository or this checkpoint.

## Durable repository and image state

- GitHub repository: `wa90-star/777`
- Main incident-monitor implementation: `e79e10ba76405836dd1256d26c4fe27815d8da1f`
- Portable-container publication commit: `90e074669b6ddbdbe528585617053b5bb5248a70`
- Public immutable image: `ghcr.io/wa90-star/777-radar:90e074669b6ddbdbe528585617053b5bb5248a70`
- GitHub Actions image build completed successfully and the package is public.
- The repository contains the Docker/Compose runtime, Alpaca-IEX oil proxy, incident monitor, tests and health-check logic.

## Verified live v5.1.0 instance

- Railway service: `radar-v5-image`
- Service ID: `9b834ba4-9b55-4535-acb4-093475bb03de`
- Deployment: `0affd744-06db-4490-bd48-97f7e21892a6` (`SUCCESS`)
- URL: `https://radar-v5-image-production.up.railway.app`
- Image: the immutable GHCR image listed above.
- Last independent endpoint check: `2026-09-20T04:23:16.799Z`
- Verified: version `5.1.0`, `publicApiMode=read-only`, Telegram configured, oil monitor `live`, data mode `free-proxy`, Alpaca-IEX configured/authenticated/connected, no source error.
- Limitation: `RADAR_DATA_DIR=/tmp/radar-data`; this service has no volume. Runtime state is writable but ephemeral and must not be treated as durable.

## Legacy Railway service

- Project: `accomplished-creation` (`129edff7-1574-4a45-8187-57046ff1fe0b`)
- Environment: `production` (`4d9e8751-cbf8-4cbd-822a-81c47a6bdade`)
- Service: `chic-caring` (`26a16471-2551-4163-a269-b8c9faf648f6`)
- Domain: `https://chic-caring-production-d403.up.railway.app`
- Persistent volume: `radar-data` (`0833eef0-51ec-4bdf-abda-41204722fd53`), mounted at `/data`, 500 MB.
- Last known running release: deployment `0851b97a-4931-48cd-8e17-5d9f1529600b`, version 4.9.1.
- New repo-source deployments fail before application build on Railway's Metal/V3 builder. The latest failed attempt is `5ec44001-cc26-478b-8637-5965f1fb3269`.
- The legacy domain and volume must be preserved until durable v5 state has been migrated and verified.

## Temporary service to remove later

- Service: `radar-v5-canary` (`3015e039-f2ff-45a5-a88e-38589643e4a9`)
- Current deployment: `2ab4a6bd-17d0-4f74-a5ca-98a1aae096fa` (`SUCCESS`)
- It only serves a minimal Node health response and provides no radar value.
- Remove or suspend it after the fallback path is verified so it does not consume trial resources.

## Independent watch already active

- ChatGPT condition watch: `Radar-Ausfallwache`
- Automation ID: `6aaf5f5e9b388191938f7e4951134553`
- It checks the v5 status and oil-monitor endpoints hourly and stays silent while healthy.
- It alerts only for endpoint failure, version regression, non-read-only public mode, missing Telegram setup, non-live oil monitor, missing/unauthenticated Alpaca-IEX source or a concrete provider error.

## Exact continuation plan

1. Add a no-cost scheduled GitHub Actions runner for the radar's analysis/Telegram path so alerts do not depend on the Railway trial.
2. Make the scheduled run deterministic and testable, with explicit concurrency protection and failure reporting.
3. Decide the durable-state mechanism without paid services. Prefer an already-owned always-on Linux device or an Oracle Always Free eligible VM for the full public API and `/data` volume. Do not enable a paid plan.
4. Only after the free fallback is live and verified, migrate any required state from the legacy `/data` volume.
5. Then remove the temporary canary and redundant Railway image service; keep the immutable GHCR image as the portable recovery artifact.

## Safe restart point

If work stops because of a usage limit, resume from step 1 above. Before making infrastructure changes, re-check this file, current Git status, the two public endpoints and Railway service status. Do not repeat completed image-build work and do not expose or rotate secrets unless a verified deployment requires it.
