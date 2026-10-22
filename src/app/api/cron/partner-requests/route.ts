/**
 * PARTNER DISCOVERY, slice P3: the daily expiry of pairing requests
 * (2026-10-22). Plan: MDs/partner-discovery-plan-2026-10-21.md, section 3.4.
 *
 * Daily from vercel.json, behind CRON_SECRET like every other cron, the
 * same pattern as /api/cron/venue-reminder. The work is
 * `runPartnerRequestExpirySweep` (src/lib/club-partnership.ts): a request
 * still unanswered 14 days after it was sent ends as "expired" and the
 * asking club is told once (a compare-and-set claim per row, so two runs
 * at once tell it once). A missed run only delays an expiry by a day.
 *
 * Only the request to become partners expires. An ask for players never
 * has a 14-day limit: it ends with its match (Kemal, 2026-10-22).
 *
 * TEST-ONLY clock override (e2e suite), gated on MT_TEST_MODE=1 exactly
 * like the other crons, and never set in production.
 */
import { NextResponse } from "next/server";
import { runPartnerRequestExpirySweep } from "@/lib/club-partnership";

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
    return NextResponse.json(await runPartnerRequestExpirySweep(now));
  } catch (err) {
    console.error("[partner-requests] sweep failed:", (err as Error)?.name ?? "error");
    return NextResponse.json({ error: "sweep failed" }, { status: 500 });
  }
}
