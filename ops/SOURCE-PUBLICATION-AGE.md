# Official statement publication dates

The Pelosi press-release listing publishes a calendar date immediately after
each article heading. The collector now reads and validates that date and keeps
its precision as `day`. Existing fourteen-day eligibility rules can therefore
exclude older articles that remain on the first listing page.

An undated, invalid or future-dated entry is held out of fresh notifications;
source health reports the coverage gap. Valid dated neighbours still run. An
empty/unrecognized listing is an error. The parser does not borrow a date from
the next article, and it never supplies detection time as publication time.

The November 5 audit found the Sable pipeline statement dated September 8 on
the official listing, while its legacy saved item had `publishedAt: null`.
Historical failed outbox entries are preserved; this change does not erase
delivery failures, mark them delivered, or replay them as new warnings.
