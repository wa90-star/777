# Private source review journal

Expired Telegram intents remain `failed`. A separate private journal records a
manual source/date/notice-type review; it never sends a message, creates a
provider receipt, changes an EF review cursor, or grants trading permission.

`scripts/import-source-reviews.js` reads the existing policy/EIA/ECB outboxes
without constructing their engines. Run it as the same OS account as the radar
(`node` in the supplied container), not as root. The private directory must be
0700 and its journal 0600; another account's unreadable journal fails closed.

1. `node scripts/import-source-reviews.js --data-dir /data --list-targets`
2. Build a private JSON input with `schema: 1` and `reviews`. Each record contains
   the exact returned `target`, `revision`, `previousReviewSha256` and `review`.
   The review requires `scope: MANUAL_SOURCE_DATE_NOTICE_TYPE`, disposition
   `TRIAGED_NO_REPLAY` or `OPEN_REQUIRES_MORE_EVIDENCE`, `verifiedPublicationDate`
   (date or null), HTTPS `evidenceUrls` without query/fragment, a short
   `explanation`, `reviewer`, and canonical UTC `reviewedAt`. Do not put account,
   position, credential or message identifiers in this input.
3. Preview with `--data-dir /data --input /absolute/private-input.json`.
4. Apply the same reviewed input with `--apply --expected-input-sha256 HASH`.
   An identical import is idempotent. Correct/reopen a review using its next
   revision and previous review hash; never overwrite earlier records.
5. Re-read the private journal and public counters, compare original intents,
   and verify them again after restart. Keep private backups outside source
   packages. The existing whole-directory recovery snapshot includes this
   directory only when a new snapshot is deliberately made; an older snapshot
   does not magically contain later reviews. Public backup export stays disabled
   unless separately configured with its existing authentication mechanism.

Targets bind the engine, Telegram channel, outbox identity and instance time,
the UTF-8 `JSON.stringify(item)` SHA-256, and a canonical delivery-state hash.
Changed content, instances or delivery state require a fresh review. Duplicate
IDs, corrupt journals, unsafe paths and permissions are rejected. The journal
is limited to 4 MiB/10,000 revisions with no silent deletion. A leftover import
lock after interruption requires checking the actual process before recovery.

Public status exposes only review counters and store health. It retains original
failed/sent totals and receipt times. Information health separates reviewed
historical failures from unresolved expired intents; other delivery errors and
source gaps remain failures. Older status schemas are assessed conservatively.
The strict trading health profile and public GET/HEAD-only API are unchanged.

MOFCOM failures additionally identify shell retrieval, query extraction, unit
retrieval or listing parsing. This annotation adds no retry or fallback and is
not evidence that a network failure was repaired.
