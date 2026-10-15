/**
 * Nightly cron (vercel.json, 00:00 UTC): for each active Activity OF A
 * CLUB THAT MAY HAVE FIXTURES, generate the upcoming Match for its next
 * scheduled weekday + time.
 *
 * The generation itself lives in `src/lib/generate-upcoming-matches.ts`
 * (2026-10-15), because going live (`goLiveClub`) runs the very same code
 * for the one club that has just gone live. Its header carries the
 * history: the London wall clock, the dormant-club bug of 2026-09-09, the
 * slot dedupe and why the fee is not copied.
 */
import { NextResponse } from "next/server";
import { generateUpcomingMatches } from "@/lib/generate-upcoming-matches";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { created, skippedDormantOrgs, skippedNotApprovedOrgs } = await generateUpcomingMatches();
  // The response body is unchanged: the billing-paused skips are logged only.
  return NextResponse.json({ created, skippedDormantOrgs, skippedNotApprovedOrgs });
}
