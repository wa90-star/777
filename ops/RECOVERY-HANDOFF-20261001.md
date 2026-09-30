# Radar recovery handoff — 1 October 2026

## Actual state

The last production check at 00:08:41 Europe/Berlin returned HTTP 404 from both public endpoints on three attempts. Railway shows `Trial expired`, no active deployment, and the existing 500 MB volume at `/data`. No Oracle server or working Oracle sign-in has been established. No production data has been exported, and no actual Telegram delivery or new Kimi runtime response has been verified.

Preparation, passing local tests, a published container and a staged Railway change do not mean the Radar is online. Keep these distinctions in every continuation report.

## First unblock the two access paths

1. Re-establish access to the official Oracle sign-in. The prior working-browser result was `Site Unavailable`; do not infer a general Oracle outage. If a sign-in form becomes available, use secure authentication. Do not put passwords, one-time codes, API tokens, SSH private keys or Telegram credentials in chat, Git or logs.
2. Inspect the actual Oracle tenancy, region and free allocation before provisioning. Use only resources explicitly eligible for Always Free in that account. Do not enable a paid plan or assume that documentation establishes this account's eligibility or capacity.
3. Resolve export of the original Railway volume. The current official CLI v5.63.1 calls `ensure_service_has_active_deployment` before volume-file operations. Authentication alone will not export an inactive service. A permitted temporary restart within an actually confirmed free plan, or a provider-assisted export, must first be possible. Do not erase, detach or replace the original volume to work around this.

CLI installation itself also remains uncompleted in the working environment: the pinned npm installation reached package metadata but timed out downloading the official Linux binary through the network proxy. No interactive login or credential extraction was attempted. A failed installation is not authentication success.

## Then migrate once, with evidence

- Stop at missing or unverifiable source data. A clean empty target is not a migration.
- Export the complete volume root, including dot directories, delivery outboxes, deduplication state, research state and existing recovery snapshots. Keep the export private and retain the original volume.
- Capture and verify the export with the migration tool before copying it to the target. Validate a second time after transfer. Checksums detect corruption; they cannot prove that an unavailable source was completely exported.
- Restore only while the target Radar is stopped and only into an empty, verified destination. Never use `down -v`, volume pruning or blind overwrite.
- Select an immutable image whose registry manifest contains the target architecture. Record its digest. A multiarchitecture build or emulated test does not prove performance on the actual Oracle VM.
- Preserve `publicApiMode=read-only`, `OIL_DATA_MODE=free-proxy`, Kimi `off` or reviewed `shadow`, disabled Kimi production/Telegram influence, and all source/freshness/confirmation thresholds.
- Start one Radar process with the restored `/data` and private existing credentials. Do not leave two instances sending the same alerts.

## Monitoring and completion criteria

- Run the full health contract against the actual public HTTPS URL. HTTP 200 alone is insufficient: check every mandatory source, freshness, persistent paths, authenticated Alpaca/IEX, live oil monitor and honest ETF/futures labels.
- Prove persistence through a real controlled restart, inspecting historical records and outbox/deduplication continuity without printing their private contents.
- Send a clearly identified test notification and establish an actual Telegram API acknowledgement. This confirms API acceptance, not that a person read it.
- Place the external watchdog on a separately operating host and persistent state directory. A watchdog on the same failed machine cannot report the machine's failure. The supplied systemd files are templates, not an activated monitor or an uptime guarantee.
- Exercise failed delivery, retry and recovery locally first, then verify a real notification path. Existing GitHub Actions checks remain supplementary because their execution may be delayed.
- Measure at least a representative US trading session and 24–72 hours of RAM, CPU, disk and egress on the actual target. Record missing periods; do not count an outage as zero-cost healthy operation.
- Kimi is separate: a fresh challenge needs a real runtime response and a valid reviewed research packet. Core radar operation must not depend on Kimi responding. Prompt B remains unaccepted until its evidence passes review.

## References

- [Current deployment checkpoint](DEPLOYMENT-CHECKPOINT.md)
- [Verified volume migration commands and safeguards](VOLUME-MIGRATION.md)
- [External watchdog implementation](external-watchdog.mjs), [service template](systemd/radar-external-watchdog.service), [timer template](systemd/radar-external-watchdog.timer)
- Local combined validation on 1 October 2026: `npm test` passed 152 tests, zero failures/skips. The 26 added tests cover the external watchdog and migration tooling with temporary data and local HTTP servers. This is not a live provider/Telegram/Oracle acceptance result.
- [Free-host preparation and acceptance](FREE-HOSTING.md)
- [Railway volume commands](https://docs.railway.com/cli/volume)
- [Railway CLI v5.63.1 source](https://github.com/railwayapp/cli/blob/v5.63.1/src/commands/volume.rs)
- [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

No paid subscription, provider migration, destructive volume action or production deployment is authorized by this document itself.
