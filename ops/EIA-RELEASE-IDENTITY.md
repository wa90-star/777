# Repeated EIA report addresses

EIA monthly and weekly reports can retain their URL when a new edition is
published. The delivery identity now combines the normalized URL and the RSS
publication instant. Equivalent timezone spellings collapse to one identity;
the same URL with a later publication can enter the existing durable outbox.
This does not infer a price reaction, surprise, or trading recommendation.

State version 3 retains the prior outbox entries and receipts. It reconstructs
known editions from saved items and outbox evidence. Legacy URLs with no saved
publication receive one quiet baseline on their next dated observation; the
remaining count is exposed as `pendingLegacyReleaseBaselines` and persisted
across partial feed reads and restarts. That initial unknown edition cannot be
claimed as newly detected. URL aliases remain for rollback compatibility.

Future-dated entries beyond five minutes of clock allowance are not delivered
or consumed. Missing/invalid publication dates retain URL-only deduplication;
their edition changes remain unverified. Content-only corrections under the
same publication timestamp are outside this identity change.

Tests use synthetic feeds and an isolated directory, with no external messages.
They reproduce the original same-URL suppression, test the next edition,
restart deduplication, timestamp equivalence, preserved failed deliveries,
partial legacy migration, and missing/future dates. They do not prove a new
edition has already been delivered in live operation.
