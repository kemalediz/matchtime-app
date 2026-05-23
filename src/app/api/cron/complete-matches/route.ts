/**
 * Match-completion cron (2026-05-23).
 *
 * Runs every 15 min via `vercel.json`. Calls the shared
 * `completeFinishedMatches` helper which flips matches past their
 * end-time (kickoff + matchDurationMins) to COMPLETED — which is
 * what gates the post-match flow (rating DMs, MoM poll). End-to-end
 * latency from the final whistle to the bot posting in the group is
 * ~20 min:
 *
 *   - within 15 min: this cron tick flips status to COMPLETED
 *   - within 5 min:  bot's next due-posts poll picks up the queued
 *                    rate-dm / mom-poll instructions and posts them
 *
 * Replaces the day-after timing that resulted from the auto-complete
 * being bolted into the daily 12:00 UTC `/api/cron/generate-teams`
 * cron. The daily generate-teams call still runs (and the helper is
 * idempotent), so this is a strict latency improvement.
 *
 * Works equally for Sutton (full-feature) and Amir (MoM/ratings only,
 * no team generation) — the helper picks up matches in UPCOMING /
 * TEAMS_GENERATED / TEAMS_PUBLISHED, gated by `now >= matchEndTime`.
 */
import { NextResponse } from "next/server";
import { completeFinishedMatches } from "@/lib/match-completion";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { completed } = await completeFinishedMatches(new Date());
  return NextResponse.json({ ok: true, completed });
}
