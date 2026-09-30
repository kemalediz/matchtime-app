-- Data only (2026-09-30). Sutton FC has collected payments through
-- MatchTime since 2026-06-09, so its group is never sent the
-- "payments are now live" announcement (lib/payments-live-announce.ts).
-- The code only announces on a transition to live, which already covers
-- a deploy; this row also covers an admin switching collection off and
-- back on with the same connected account. Idempotent.
INSERT INTO "SentNotification" ("id", "key", "kind", "createdAt")
SELECT
  'seed-payments-live-' || o."id",
  'org-' || o."id" || ':payments-live:' || o."stripeConnectAccountId",
  'payments-live',
  NOW()
FROM "Organisation" o
WHERE o."id" = 'cmnnwhdx30000zfr85q18lyy9'
  AND o."stripeConnectAccountId" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;
