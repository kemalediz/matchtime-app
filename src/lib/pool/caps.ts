/**
 * THE POOL'S CAPS (slice L4, 2026-10-24). PURE: no database, no clock of
 * its own; every function takes the moment it judges.
 *
 * The numbers are rules.ts `POOL_CAPS` (per player, per club) and
 * `POOL_PLATFORM_CAPS` below (platform-wide, plan 4.3); nothing else holds
 * a copy. Approved spec, "Limits": at most 2 offers a week and 1 a day per
 * player; 3 ignored offers in a row pause him.
 *
 * WHEN AN OFFER COUNTS (decision L4.3). Each offer is counted at the moment
 * it reaches (or will reach) him: its `sentAt`, or, while it waits, the
 * send time its platform job is held to (quiet hours defer, never drop), or
 * its creation. A deferred 08:30 offer therefore uses up the day it is
 * delivered on, not the evening it was queued. The caps are judged at the
 * NEW offer's send time for the same reason. `cancelled` offers never
 * reached him and never count.
 *
 *   week  ROLLING 7 days (rules.ts says so): no 7-day window holding the
 *         new offer may hold more than `perPlayerPerWeek`, queued future
 *         offers included. Half-open: an offer exactly 7 days earlier is
 *         out.
 *   day   the LONDON CALENDAR day (rules.ts says so), so a 25-hour autumn
 *         Sunday is one day and 00:30 BST is the new day.
 *   decline cooldown  `declineCooldownDays` after he declined a club, that
 *         club cannot offer him again (other clubs can).
 *
 * THE PLATFORM CAPS (plan 4.3): at most 20 pool DMs in any rolling hour and
 * 100 a London day, on top of the bot's DM pacing. `platformRoom` says how
 * many more may go at a moment. CONCURRENCY (for L5 to implement; nothing
 * here takes a lock): two pollers or two organisers' rounds must not both
 * see "room 1" and both send. The design:
 *   1. The cap is enforced at DISPATCH, when an offer's platform job is
 *      claimed for sending, not when a round is planned. Planning may
 *      overbook; dispatch never does. An offer with no room stays queued
 *      (deferred, its `sentAt` NULL) and is retried on the next poll; it is
 *      never dropped, and if its cut-off passes first it ends `cancelled`.
 *   2. The claim runs in ONE transaction that first takes
 *      `pg_advisory_xact_lock(hashtext('pool-platform-cap'))` (the
 *      `partner-guest.ts` pattern), then counts PoolOffer rows with
 *      `sentAt` in the last hour and in today's London day, calls
 *      `platformRoom`, and stamps `sentAt = now` on at most that many
 *      offers (oldest queued first) before committing. The lock serialises
 *      every claimer; the count and the stamp are in the same transaction,
 *      so no two claimers can spend the same room.
 *   3. The same transaction re-checks the per-player caps for each offer it
 *      stamps (another club's offer to him may have gone out meanwhile),
 *      under the same lock, with `playerCapRefusal` and the ledger read
 *      inside it. A refused offer ends `cancelled`.
 *   4. A unit test with a fake clock and two interleaved claimers, and an
 *      e2e/sim/pool scenario with a burst of rounds, prove both.
 */
import { formatLondon } from "../london-time";
import { POOL_CAPS } from "./rules";
import type { PoolOfferOutcome } from "./vocab";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Pool DMs MatchTime sends across every club (plan 4.3). */
export const POOL_PLATFORM_CAPS = Object.freeze({
  /** In any rolling 60 minutes. */
  perHour: 20,
  /** Per London calendar day. */
  perLondonDay: 100,
});

/** The London calendar day of an instant, "yyyy-MM-dd". */
export function londonDayKey(d: Date): string {
  return formatLondon(d, "yyyy-MM-dd");
}

/** One earlier offer to the person, as the caps read it. */
export interface OfferLedgerEntry {
  orgId: string;
  /** When it reached him or will (see the header). */
  at: Date;
  outcome: PoolOfferOutcome | null;
  resolvedAt: Date | null;
}

export type PlayerCapRefusal = "day-cap" | "week-cap" | "decline-cooldown";

const counts = (e: OfferLedgerEntry) => e.outcome !== "cancelled";

/** May one more offer, from `orgId`, reach him at `at`? Null: yes. */
export function playerCapRefusal(ledger: readonly OfferLedgerEntry[], orgId: string, at: Date): PlayerCapRefusal | null {
  const live = ledger.filter(counts);
  const t = at.getTime();

  const day = londonDayKey(at);
  if (live.some((e) => londonDayKey(e.at) === day)) return "day-cap";

  // Every 7-day window holding `t` starts in (t - 7d, t]; the fullest one
  // starts at one of the offers in that span, or at `t` itself.
  const near = live.map((e) => e.at.getTime()).filter((x) => x > t - WEEK_MS && x < t + WEEK_MS);
  const starts = [t, ...near.filter((x) => x <= t)];
  for (const w of starts) {
    const inWindow = 1 + near.filter((x) => x >= w && x < w + WEEK_MS).length;
    if (inWindow > POOL_CAPS.perPlayerPerWeek) return "week-cap";
  }

  const cooldownFrom = t - POOL_CAPS.declineCooldownDays * DAY_MS;
  if (ledger.some((e) => e.orgId === orgId && e.outcome === "declined" && (e.resolvedAt ?? e.at).getTime() > cooldownFrom)) {
    return "decline-cooldown";
  }
  return null;
}

/**
 * Offers ignored in a row, newest first (decision log #8). `ignored` (his
 * own offer ran out unanswered) counts; any answer (accepted, declined,
 * filled, stopped) ends the run; `expired` (the ask closed first),
 * `cancelled` (never reached him) and still-open offers are neutral and
 * skipped (decision L4.6). Only offers at or after `since` (when he last
 * resumed) count: "until they say they want more".
 */
export function ignoredStreak(ledger: readonly OfferLedgerEntry[], since: Date | null = null): number {
  const from = since?.getTime() ?? Number.NEGATIVE_INFINITY;
  const newestFirst = ledger.filter((e) => e.at.getTime() >= from).sort((a, b) => b.at.getTime() - a.at.getTime());
  let n = 0;
  for (const e of newestFirst) {
    if (e.outcome === "ignored") n++;
    else if (e.outcome === null || e.outcome === "expired" || e.outcome === "cancelled") continue;
    else break;
  }
  return n;
}

/** Does this run of ignored offers pause his profile ("ignored")? */
export function pausesForIgnored(ledger: readonly OfferLedgerEntry[], since: Date | null = null): boolean {
  return ignoredStreak(ledger, since) >= POOL_CAPS.ignoredInARowPause;
}

export type ClubRoundRefusal = "round-open" | "club-week-cap";

/** May the club open a pool round for `matchId` at `at`? Null: yes. One
 *  open round a match; `roundsPerClubPerWeek` in any rolling 7 days, a
 *  cancelled round (it reached nobody) not counted. */
export function clubRoundRefusal(
  asks: ReadonlyArray<{ matchId: string; status: string; createdAt: Date }>,
  matchId: string,
  at: Date,
): ClubRoundRefusal | null {
  if (asks.some((a) => a.matchId === matchId && a.status === "open")) return "round-open";
  const from = at.getTime() - WEEK_MS;
  const thisWeek = asks.filter((a) => a.status !== "cancelled" && a.createdAt.getTime() > from && a.createdAt.getTime() <= at.getTime());
  return thisWeek.length >= POOL_CAPS.roundsPerClubPerWeek ? "club-week-cap" : null;
}

/** How many more pool DMs may go at `at`, given when the others went. */
export function platformRoom(sentAts: readonly Date[], at: Date): number {
  const t = at.getTime();
  const lastHour = sentAts.filter((d) => d.getTime() > t - HOUR_MS && d.getTime() <= t).length;
  const day = londonDayKey(at);
  const today = sentAts.filter((d) => londonDayKey(d) === day).length;
  return Math.max(0, Math.min(POOL_PLATFORM_CAPS.perHour - lastHour, POOL_PLATFORM_CAPS.perLondonDay - today));
}
