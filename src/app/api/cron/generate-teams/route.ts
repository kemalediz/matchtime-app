/**
 * The daily maintenance sweep: generate, auto-publish, auto-complete.
 *
 * IT NO LONGER HAS A RATING FORMULA. Until 2026-09-19 this route
 * computed its own number inline (`ratings.length >= 3 ? mean of the
 * last 60 peer scores : User.seedRating ?? 5.0`), called `balanceTeams`
 * itself, and kept its own copy of the deleteMany, createMany and
 * status write. That was a global, un-club-scoped step function and a
 * THIRD implementation of team selection, running live at `0 12 * * *`
 * (`vercel.json`), so a squad whose attendance deadline fell before
 * noon UTC could get a sheet neither human button could reproduce.
 *
 * It now calls `lib/team-generation.ts#generateTeamsForMatch`, the same
 * club-scoped, LLM-adjusted implementation behind "@Match Time generate
 * the teams" and the admin dashboard's Generate button. With this
 * change that helper really is the only code in MatchTime that decides
 * who is on which team. Slice 3 of
 * `MDs/club-scoped-ratings-design-2026-09-18.md`.
 *
 * IT STILL DOES NOT POST. `generateTeamsForMatch` RETURNS a
 * ready-to-send group message and queues no `BotJob`; whether the club
 * hears about it is the caller's decision. The WhatsApp route posts it,
 * the dashboard discards it, and this cron discards it too. A silent
 * maintenance job must not start announcing line-ups at noon just
 * because it changed which function builds them.
 */
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { completeFinishedMatches } from "@/lib/match-completion";
import { getOrgFeatures } from "@/lib/org-features";
import { generateTeamsForMatch } from "@/lib/team-generation";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Find matches past deadline that need team generation.
  const matches = await db.match.findMany({
    where: {
      status: "UPCOMING",
      attendanceDeadline: { lte: now },
    },
    include: {
      activity: { include: { sport: true } },
      // Only the COUNT is needed here now, for the squad-size guard
      // below. The players, their positions and their ratings are read
      // by `generateTeamsForMatch`, which is the only thing entitled to
      // an opinion about them.
      attendances: {
        where: { status: "CONFIRMED" },
        select: { userId: true },
      },
    },
  });

  let generated = 0;
  let skippedNoTeamBalancing = 0;

  for (const match of matches) {
    // Skip orgs that have team-balancing turned off — they pick teams
    // manually in the group. Without this gate, a fully-attended
    // MoM-only org (e.g. Amir's Thursday group via squad-from-list)
    // would silently get TeamAssignment rows that never reach the
    // group (the bot-scheduler post-compute filter drops match-teams
    // posts), polluting the DB.
    const features = await getOrgFeatures(match.activity.orgId);
    if (!features.teamBalancing) {
      skippedNoTeamBalancing++;
      continue;
    }

    // Cheap local guard, kept even though `generateTeamsForMatch`
    // refuses a short squad too. The count is already in hand from the
    // sweep above, so skipping here saves the helper's reads and its
    // LLM adjuster call on a match that was never going to produce a
    // sheet. A sweep over every club runs this on every unplayed match
    // in the estate, most of which are short.
    const perTeam = match.activity.sport.playersPerTeam;
    if (match.attendances.length < perTeam * 2) continue;

    // The group post comes back in `result.groupPost` and is
    // DELIBERATELY DISCARDED. See the header: the cron has never
    // announced a line-up and this refactor does not make it start.
    const result = await generateTeamsForMatch(match.id);
    if (!result.ok) {
      // The helper's own guards (match vanished, already COMPLETED or
      // CANCELLED between the sweep and its read, squad short after a
      // late drop-out). Nothing to fix here, but a silent skip on a job
      // nobody watches is how the PJR cron failed every morning for two
      // days, so it gets a line in the log.
      console.warn(`[cron/generate-teams] ${match.id} skipped: ${result.reason}`);
      continue;
    }

    generated++;
  }

  // Auto-publish teams generated more than 1 hour ago.
  const autoPublishCutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const toPublish = await db.match.findMany({
    where: {
      status: "TEAMS_GENERATED",
      updatedAt: { lte: autoPublishCutoff },
    },
  });

  let published = 0;
  for (const match of toPublish) {
    await db.match.update({
      where: { id: match.id },
      data: { status: "TEAMS_PUBLISHED" },
    });
    published++;
  }

  // Auto-complete matches whose duration has expired. The actual logic
  // lives in `src/lib/match-completion.ts` and is also called every
  // 15 min by `/api/cron/complete-matches` (which is the primary
  // trigger — that gives ~20 min end-to-end from whistle to post-match
  // bot post). Calling it here too keeps the daily generate-teams as
  // a backstop; the helper is idempotent.
  const { completed } = await completeFinishedMatches(now);

  return NextResponse.json({ generated, published, completed, skippedNoTeamBalancing });
}
