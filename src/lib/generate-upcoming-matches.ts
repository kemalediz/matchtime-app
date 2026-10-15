/**
 * THE ONE FIXTURE GENERATOR: for each active Activity of a club that may
 * have fixtures, the Match for its next weekday + London wall clock.
 *
 * Two callers, one code path (2026-10-15):
 *   - the nightly cron `/api/cron/generate-matches` (vercel.json, 00:00
 *     UTC), for every club;
 *   - going live (`goLiveClub` in club-setup.ts), for that one club, right
 *     after the go-live commits. Club FNF went live at 22:12 London on
 *     2026-10-15 and had no game until the cron ran, so the squad list its
 *     organiser pasted a minute later had nothing to go on.
 *
 * Time is stored as a London wall clock on the Activity (`time: "21:30"`)
 * and converted to a UTC instant here (`nextLondonKickoff`), so
 * Match.date is a real, unambiguous timestamp. DST is handled there.
 *
 * 2026-09-09: generation used to ask only whether the ACTIVITY was
 * active, never whether the ORGANISATION still existed, so a churned club
 * (Sutton Lads) kept getting fixtures. It now checks both axes via
 * `src/lib/org-lifecycle.ts` (dormant, not approved, paused for the club
 * fee).
 *
 * What is NOT copied onto the Match: `Activity.feePerPlayer`.
 * `Match.feePerPlayer` is the amount the money collector confirmed for
 * that game (payment-flow.ts): the scheduler asks the collector only
 * while it is null, and only the collector's confirmation releases the
 * pay links. A Match born with a fee would never be asked about and
 * never release its links.
 */
import { db } from "./db";
import { nextLondonKickoff } from "./london-time";
import { hasMatchForSlot } from "./match-slot";
import { partitionGeneratable } from "./org-lifecycle";

export interface GenerateUpcomingMatchesResult {
  created: number;
  createdMatchIds: string[];
  skippedDormantOrgs: number;
  skippedNotApprovedOrgs: number;
  skippedBillingPausedOrgs: number;
}

export async function generateUpcomingMatches(
  opts: { orgId?: string; now?: Date } = {},
): Promise<GenerateUpcomingMatchesResult> {
  const now = opts.now ?? new Date();
  const tag = opts.orgId ? `[generate-matches ${opts.orgId}]` : "[generate-matches]";

  // `isActive` narrows at the DB; the ORG's lifecycle is then decided by
  // the pure rule below. Dormancy is deliberately NOT pushed into this
  // `where`: a skipped club has to be countable, otherwise "we stopped
  // generating for a dead club" and "there was nothing to generate" look
  // identical in the cron log, which is how that bug survived a quarter.
  const candidates = await db.activity.findMany({
    where: { isActive: true, ...(opts.orgId ? { orgId: opts.orgId } : {}) },
    include: { sport: true, org: { select: { name: true, dormantAt: true, approvalStatus: true, billingStatus: true } } },
  });

  // Filtered BEFORE the loop, not with a `continue` inside it: this repo
  // has had six terminal-short-circuit incidents where an early exit
  // added near the top of a loop silently deleted the guards beneath it,
  // and the guard beneath this one is the ghost-match slot dedupe. An
  // activity that reaches the loop has already cleared every axis.
  const { generate: activities, skipped, skippedDormantOrgs, skippedNotApprovedOrgs, skippedBillingPausedOrgs } =
    partitionGeneratable(candidates);

  // `activity-inactive` skips are routine and stay silent.
  for (const s of skipped) {
    if (s.reason === "org-dormant") {
      console.log(`${tag} skipping "${s.item.name}": org "${s.item.org.name}" is dormant (since ${s.item.org.dormantAt?.toISOString()})`);
    } else if (s.reason === "org-not-approved") {
      // A club that is not approved (self-join: waiting, rejected or
      // suspended) gets no fixture: nothing may post or spend for it.
      console.log(`${tag} skipping "${s.item.name}": org "${s.item.org.name}" is not approved (${s.item.org.approvalStatus})`);
    } else if (s.reason === "org-billing-paused") {
      // Club fee billing (B1, plan 4.3 point 6). Never while
      // BILLING_ENABLED is off (the rule reads the kill switch).
      console.log(`${tag} skipping "${s.item.name}": org "${s.item.org.name}" is paused for the club fee`);
    }
  }

  const createdMatchIds: string[] = [];

  for (const activity of activities) {
    // The next occurrence of the activity's weekday at its London wall
    // clock, as a UTC instant. Shared with the admin "Generate match"
    // button.
    const matchDate = nextLondonKickoff(now, activity.dayOfWeek, activity.time);

    // Dedupe window: ±12h around the intended match time.
    const dayStart = new Date(matchDate.getTime() - 12 * 60 * 60 * 1000);
    const dayEnd = new Date(matchDate.getTime() + 12 * 60 * 60 * 1000);

    // Dedupe on the recurring SLOT, (orgId, venue, dayOfWeek) + match
    // INSTANT proximity, NOT on activityId and NOT on the activity `time`
    // string. A format switch (`switchMatchFormat`) re-points the existing
    // Match to a different Activity but leaves the old Activity active;
    // keying on activityId alone regenerates an empty "ghost" match. And
    // the two formats of one fixture can carry DIFFERENT configured times
    // (21:30 vs 21:15), so exact-`time` equality also fails. The decision
    // is the pure predicate in match-slot.ts (±90 min).
    const existingInWindow = await db.match.findMany({
      where: {
        date: { gte: dayStart, lte: dayEnd },
        activity: { orgId: activity.orgId },
      },
      select: {
        date: true,
        activity: { select: { orgId: true, venue: true, dayOfWeek: true } },
      },
    });
    const slot = { orgId: activity.orgId, venue: activity.venue, dayOfWeek: activity.dayOfWeek, instant: matchDate };
    const existingSlots = existingInWindow.map((existing) => ({
      orgId: existing.activity.orgId,
      venue: existing.activity.venue,
      dayOfWeek: existing.activity.dayOfWeek,
      instant: existing.date,
    }));
    if (hasMatchForSlot(slot, existingSlots)) continue;

    const deadline = new Date(matchDate.getTime() - activity.deadlineHours * 60 * 60 * 1000);
    const created = await db.match.create({
      data: {
        activityId: activity.id,
        date: matchDate,
        maxPlayers: activity.sport.playersPerTeam * 2,
        attendanceDeadline: deadline,
      },
    });
    createdMatchIds.push(created.id);
  }

  return {
    created: createdMatchIds.length,
    createdMatchIds,
    skippedDormantOrgs,
    skippedNotApprovedOrgs,
    skippedBillingPausedOrgs,
  };
}
