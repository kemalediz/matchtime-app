/**
 * Auto-completion of matches whose duration has expired.
 *
 * Lifted out of `/api/cron/generate-teams` (2026-05-23) so it can be
 * called by a more frequent cron (`/api/cron/complete-matches`, every
 * 15 min per vercel.json) than the daily 12:00 UTC team-generation
 * tick. With the daily-only path, a Tuesday 21:00 BST match would
 * not flip to COMPLETED until Wednesday 13:00 BST — meaning rating
 * DMs and the MoM poll (both gated on COMPLETED) wouldn't fire for
 * ~15h. With the dedicated cron, end-to-end latency from final
 * whistle to post-match group post is ~20 min (≤15 min cron tick +
 * ~5 min bot due-posts poll).
 *
 * Includes matches in UPCOMING / TEAMS_GENERATED / TEAMS_PUBLISHED:
 * a MoM/ratings-only org (teamBalancing off) NEVER generates teams,
 * so its match would otherwise sit UPCOMING forever and the
 * post-match flow would never fire. The `now >= matchEndTime` guard
 * still applies, so a match is only completed once it's genuinely
 * over (kickoff + duration), regardless of whether teams were ever
 * generated.
 *
 * Idempotent: re-running over an already-completed match is a no-op
 * because the `status: { in: [...] }` filter excludes COMPLETED. Safe
 * to call from both the dedicated cron AND the daily generate-teams
 * cron (kept as a backstop).
 */
import { db } from "./db";
import { sendRatingEmails } from "./email";
import { reconcileMatchElo } from "./match-elo";
import { formatLondon } from "./london-time";
import { servingClubWhere } from "./club-approval";

export async function completeFinishedMatches(now: Date = new Date()): Promise<{ completed: number }> {
  const candidates = await db.match.findMany({
    where: {
      status: { in: ["TEAMS_PUBLISHED", "TEAMS_GENERATED", "UPCOMING"] },
      date: { lte: now },
      // Self-join (2026-09-29): a club that is not approved gets no
      // post-match flow. Every pre-existing club is approved by default.
      // Club fee billing (B1): nor does a billing-paused club (flag on);
      // its matches are completed quietly by `resumeClub` instead.
      activity: { org: servingClubWhere() },
    },
    include: {
      activity: true,
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { email: true, name: true } } },
      },
    },
  });

  let completed = 0;
  for (const match of candidates) {
    const matchEndTime = new Date(
      match.date.getTime() + match.activity.matchDurationMins * 60 * 1000,
    );
    if (now < matchEndTime) continue;

    await db.match.update({
      where: { id: match.id },
      data: { status: "COMPLETED" },
    });

    // Auto-complete without a score = no Elo update yet. Admin enters
    // the score manually via /admin/matches/[id]/teams, which triggers
    // the Elo pass via updateMatchScore. Without a score there's no
    // outcome signal, so ratings stay neutral by design.
    if (match.redScore !== null && match.yellowScore !== null) {
      try {
        // Through the one writer (lib/match-elo.ts, 2026-10-07), which
        // decides from the match's stored record:
        //   - a score this codebase wrote and has not applied yet (a
        //     pending record): the points are added now, once, and stored;
        //   - already applied: nothing;
        //   - NO record at all (the column is empty): the match was
        //     scored by something that keeps no record (the code before
        //     2026-10-07, or a script), which added the points itself.
        //     NOTHING is added here, so it cannot be counted twice. If
        //     such a writer did not in fact apply the Elo, saving the
        //     score again on the dashboard does not apply it either:
        //     that match's ratings are a manual job.
        await reconcileMatchElo({ matchId: match.id });
      } catch (err) {
        console.error("[match-completion] Elo update failed:", err);
      }
    }

    const players = match.attendances.map((a) => ({
      email: a.user.email,
      name: a.user.name,
    }));

    sendRatingEmails(
      match.id,
      match.activity.name,
      formatLondon(match.date, "EEEE, d MMMM yyyy"),
      players,
    ).catch((err) => console.error("[match-completion] sendRatingEmails failed:", err));

    completed++;
  }

  return { completed };
}
