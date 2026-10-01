/**
 * Weekly cron: for each active Activity OF A CLUB THAT STILL EXISTS,
 * generate the upcoming Match record for its next scheduled weekday +
 * time. Time is stored as a London wall clock on the Activity
 * (`time: "21:30"`) — we convert that to a UTC instant here so
 * Match.date is a real, unambiguous timestamp. DST is handled via
 * date-fns-tz.
 *
 * Before this version the code used `setHours()` which, running on
 * Vercel's UTC servers, mis-stamped every match by +1h (BST offset).
 *
 * 2026-09-09: this route used to ask only whether the ACTIVITY was
 * active, and never whether the ORGANISATION still existed. So a club
 * that churned kept generating fixtures forever — Sutton Lads churned
 * on 2026-06-18 and was still being handed a Thursday fixture in
 * September, spotted only because one appeared in a status report. It
 * now checks both axes via `src/lib/org-lifecycle.ts`, which is also
 * where the argument for `Organisation.dormantAt` (an explicit,
 * human-set field) over `whatsappBotEnabled` (a mute switch, routinely
 * flipped on live clubs) lives.
 */
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { londonWallClockToUtc, formatLondon } from "@/lib/london-time";
import { hasMatchForSlot } from "@/lib/match-slot";
import { partitionGeneratable } from "@/lib/org-lifecycle";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // `isActive` narrows at the DB; the ORG's lifecycle is then decided by
  // the pure rule below. Dormancy is deliberately NOT pushed into this
  // `where` — a skipped club has to be countable, otherwise "we stopped
  // generating for a dead club" and "there was nothing to generate" look
  // identical in the cron log, which is how this bug survived a quarter.
  const candidates = await db.activity.findMany({
    where: { isActive: true },
    include: { sport: true, org: { select: { name: true, dormantAt: true, approvalStatus: true, billingStatus: true } } },
  });

  // Filtered BEFORE the loop, not with a `continue` inside it: this repo
  // has had six terminal-short-circuit incidents where an early exit
  // added near the top of a loop silently deleted the guards beneath it,
  // and the guard beneath this one is the ghost-match slot dedupe. An
  // activity that reaches the loop has already cleared both axes.
  const { generate: activities, skipped, skippedDormantOrgs, skippedNotApprovedOrgs } =
    partitionGeneratable(candidates);

  // Dormant skips are logged; `activity-inactive` skips are routine and
  // stay silent. (A `filter`, not a `continue` — same reason as above.)
  for (const s of skipped.filter((x) => x.reason === "org-dormant")) {
    console.log(
      `[generate-matches] skipping "${s.item.name}" — org "${s.item.org.name}" is dormant ` +
        `(since ${s.item.org.dormantAt?.toISOString()})`,
    );
  }

  // A club that is not approved (self-join: waiting, rejected or
  // suspended) gets no fixture: nothing may post or spend for it.
  for (const s of skipped.filter((x) => x.reason === "org-not-approved")) {
    console.log(
      `[generate-matches] skipping "${s.item.name}" — org "${s.item.org.name}" is not approved ` +
        `(${s.item.org.approvalStatus})`,
    );
  }

  // Club fee billing (B1, plan 4.3 point 6): a club paused for the club
  // fee gets no fixture while it is quiet. Never while BILLING_ENABLED is
  // off (the rule reads the kill switch). Logged only: the response body
  // is unchanged.
  for (const s of skipped.filter((x) => x.reason === "org-billing-paused")) {
    console.log(`[generate-matches] skipping "${s.item.name}" — org "${s.item.org.name}" is paused for the club fee`);
  }

  let created = 0;

  for (const activity of activities) {
    // Find the London-local calendar day of the next occurrence of the
    // activity's weekday. `Date#getDay()` returns the weekday in local
    // server time — on Vercel that's UTC, which for most of the year
    // disagrees with London for 0-1 hours per day. Safest to read the
    // weekday directly via Intl so near-midnight edge cases don't slip.
    const now = new Date();
    const londonWeekday = Number(formatLondon(now, "i")) % 7; // Mon=1..Sun=7 → 0..6; convert to JS Sun=0..Sat=6
    let daysUntil = activity.dayOfWeek - londonWeekday;
    if (daysUntil <= 0) daysUntil += 7;

    // Anchor at midnight London time of the target day — fromZonedTime
    // inside the helper handles the wall-clock → UTC translation.
    const todayLondonMidnight = londonWallClockToUtc(now, "00:00");
    const anchor = new Date(todayLondonMidnight.getTime() + daysUntil * 24 * 60 * 60 * 1000);
    const matchDate = londonWallClockToUtc(anchor, activity.time);

    // Dedupe window: ±12h around the intended match time — enough to
    // catch a pre-existing record even if the prior run used a slightly
    // different representation.
    const dayStart = new Date(matchDate.getTime() - 12 * 60 * 60 * 1000);
    const dayEnd = new Date(matchDate.getTime() + 12 * 60 * 60 * 1000);

    // Dedupe on the recurring SLOT — (orgId, venue, dayOfWeek) + match
    // INSTANT proximity — NOT on activityId, and NOT on the activity `time`
    // string. A format switch (`switchMatchFormat`) re-points the existing
    // Match to a different Activity but leaves the old Activity active;
    // keying on activityId alone regenerates an empty "ghost" match. And the
    // two formats of one fixture can carry DIFFERENT configured times
    // (21:30 vs 21:15), so exact-`time` equality also fails. We compare the
    // existing Match's real `date` instant against the computed `matchDate`
    // within ±90 min (see match-slot.ts). We scope to the org, load every
    // match in the window, then delegate the same-slot decision to a pure
    // (unit-tested) predicate.
    const existingInWindow = await db.match.findMany({
      where: {
        date: { gte: dayStart, lte: dayEnd },
        activity: { orgId: activity.orgId },
      },
      select: {
        date: true,
        activity: {
          select: { orgId: true, venue: true, dayOfWeek: true },
        },
      },
    });
    const slot = {
      orgId: activity.orgId,
      venue: activity.venue,
      dayOfWeek: activity.dayOfWeek,
      instant: matchDate,
    };
    const existingSlots = existingInWindow.map((existing) => ({
      orgId: existing.activity.orgId,
      venue: existing.activity.venue,
      dayOfWeek: existing.activity.dayOfWeek,
      instant: existing.date,
    }));
    if (hasMatchForSlot(slot, existingSlots)) continue;

    const deadline = new Date(matchDate.getTime() - activity.deadlineHours * 60 * 60 * 1000);
    await db.match.create({
      data: {
        activityId: activity.id,
        date: matchDate,
        maxPlayers: activity.sport.playersPerTeam * 2,
        attendanceDeadline: deadline,
      },
    });
    created++;
  }

  return NextResponse.json({ created, skippedDormantOrgs, skippedNotApprovedOrgs });
}
