-- Who ended a membership (Kemal, 2026-10-31): a person an ORGANISER removed
-- from a club is never brought back into that club's games as a guest, by a
-- player pool offer or by a friend link.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261101120000_membership_removed_by_organiser/migration.sql
--
-- APPLY BEFORE DEPLOYING THE CODE: the pool candidate query, the friend link
-- booking and the players page Remove all read or write this column.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NEW nullable column, "Membership"."removedByOrganiserAt",
-- NULL on every existing row. No backfill: a membership ended before this
-- column existed cannot be told apart (an organiser's Remove and a person
-- leaving the group both only set "leftAt"), so those rows stay exactly as
-- they behave today. No existing row is changed, no index, no constraint.
--
-- IDEMPOTENT: IF NOT EXISTS.

ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "removedByOrganiserAt" TIMESTAMP(3);
