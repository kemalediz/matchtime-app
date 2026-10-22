/**
 * PARTNER DISCOVERY, slice P1: the weekly venue reminder (2026-10-22).
 * Plan: MDs/partner-discovery-plan-2026-10-21.md, section 2.1.
 *
 * Daily from vercel.json, behind CRON_SECRET like every other cron. The
 * work is `runVenueReminderSweep` (src/lib/club-partnership.ts): every
 * live club with no geocoded venue (no active game linked to one, and no
 * club venue) that was not reminded in the last 7 days gets ONE notice to
 * its owners and admins, through its admin channel, linking straight to
 * the venue lookup on the settings page. Once a venue is set the club is
 * never reminded again.
 *
 * Daily runs with a 7-day claim: a missed run only delays a reminder by a
 * day, and two runs at once send one (the claim is a compare-and-set on
 * `Organisation.venueReminderSentAt`). Notices queued in the club's quiet
 * hours wait until they end (`sendAdminNotice`).
 *
 * Its own cron, not a step of the players' group poll: that poll runs
 * every minute for every club, and this is a weekly message.
 *
 * TEST-ONLY clock override (e2e suite), gated on MT_TEST_MODE=1 exactly
 * like the other crons, and never set in production.
 */
import { NextResponse } from "next/server";
import { runVenueReminderSweep } from "@/lib/club-partnership";

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let now = new Date();
  if (process.env.MT_TEST_MODE === "1") {
    const pinned = new Date(request.headers.get("x-test-now") ?? "");
    if (!Number.isNaN(pinned.getTime())) now = pinned;
  }
  try {
    return NextResponse.json(await runVenueReminderSweep(now));
  } catch (err) {
    console.error("[venue-reminder] sweep failed:", (err as Error)?.name ?? "error");
    return NextResponse.json({ error: "sweep failed" }, { status: 500 });
  }
}
