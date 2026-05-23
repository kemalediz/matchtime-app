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
import { computeEloDeltas } from "./elo";
import { format } from "date-fns";

export async function completeFinishedMatches(now: Date = new Date()): Promise<{ completed: number }> {
  const candidates = await db.match.findMany({
    where: {
      status: { in: ["TEAMS_PUBLISHED", "TEAMS_GENERATED", "UPCOMING"] },
      date: { lte: now },
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
        const teams = await db.teamAssignment.findMany({
          where: { matchId: match.id },
          include: { user: { select: { id: true, matchRating: true } } },
        });
        const deltas = computeEloDeltas(
          teams.map((t) => ({ userId: t.userId, team: t.team, matchRating: t.user.matchRating })),
          match.redScore,
          match.yellowScore,
        );
        await db.$transaction(
          deltas.map((d) =>
            db.user.update({ where: { id: d.userId }, data: { matchRating: d.after } }),
          ),
        );
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
      format(match.date, "EEEE, d MMMM yyyy"),
      players,
    ).catch((err) => console.error("[match-completion] sendRatingEmails failed:", err));

    completed++;
  }

  return { completed };
}
