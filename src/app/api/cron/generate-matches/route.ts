/**
 * Weekly cron: for each active Activity, generate the upcoming Match
 * record for its next scheduled weekday + time. Time is stored as a
 * London wall clock on the Activity (`time: "21:30"`) — we convert
 * that to a UTC instant here so Match.date is a real, unambiguous
 * timestamp. DST is handled via date-fns-tz.
 *
 * Before this version the code used `setHours()` which, running on
 * Vercel's UTC servers, mis-stamped every match by +1h (BST offset).
 */
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { londonWallClockToUtc, formatLondon } from "@/lib/london-time";
import { hasMatchForSlot } from "@/lib/match-slot";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const activities = await db.activity.findMany({
    where: { isActive: true },
    include: { sport: true },
  });
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

    // Dedupe on the recurring SLOT — (orgId, venue, dayOfWeek, time) — NOT
    // on activityId. A format switch (`switchMatchFormat`) re-points the
    // existing Match to a different Activity but leaves the old Activity
    // active; keying on activityId alone would regenerate an empty "ghost"
    // match for the old format's still-active Activity. We scope to the
    // org and load every match in the window, then delegate the same-slot
    // decision to a pure (unit-tested) predicate.
    const existingInWindow = await db.match.findMany({
      where: {
        date: { gte: dayStart, lte: dayEnd },
        activity: { orgId: activity.orgId },
      },
      select: {
        activity: {
          select: { orgId: true, venue: true, dayOfWeek: true, time: true },
        },
      },
    });
    const slot = {
      orgId: activity.orgId,
      venue: activity.venue,
      dayOfWeek: activity.dayOfWeek,
      time: activity.time,
    };
    if (hasMatchForSlot(slot, existingInWindow.map((existing) => existing.activity)))
      continue;

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

  return NextResponse.json({ created });
}
