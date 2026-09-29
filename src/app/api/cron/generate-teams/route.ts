/**
 * The daily maintenance sweep: auto-complete, and nothing else.
 *
 * IT NO LONGER BUILDS OR PUBLISHES TEAMS. Until 2026-09-29 this route,
 * running at `0 12 * * *` UTC (`vercel.json`), also generated teams for
 * every UPCOMING match past its attendance deadline (through
 * `lib/team-generation.ts#generateTeamsForMatch`) and flipped any
 * TEAMS_GENERATED match older than an hour to TEAMS_PUBLISHED. Kemal's
 * rule: teams are built only when a human asks, on match day, through
 * "@Match Time generate the teams" or the admin dashboard's Generate
 * button. A noon job that drafts a sheet nobody asked for, days before
 * kickoff, and then publishes it an hour later on nobody's say-so is
 * exactly what that rule forbids. Both steps are deleted, not gated.
 *
 * THE PATH AND THE CRON ENTRY STAY. What is left is the auto-complete
 * backstop below, and it still needs a caller. Renaming the route would
 * mean touching the Vercel schedule for a cosmetic gain, so the name
 * `generate-teams` is now historical. `__tests__/cron-never-builds-teams.test.ts`
 * pins that it writes no TeamAssignment row and changes no match status.
 */
import { NextResponse } from "next/server";
import { completeFinishedMatches } from "@/lib/match-completion";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Auto-complete matches whose duration has expired. The actual logic
  // lives in `src/lib/match-completion.ts` and is also called every
  // 15 min by `/api/cron/complete-matches` (which is the primary
  // trigger — that gives ~20 min end-to-end from whistle to post-match
  // bot post). Calling it here too keeps the daily generate-teams as
  // a backstop; the helper is idempotent.
  const { completed } = await completeFinishedMatches(now);

  return NextResponse.json({ completed });
}
