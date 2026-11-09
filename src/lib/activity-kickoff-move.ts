/**
 * A WEEKLY GAME'S KICKOFF CHANGED: MOVE ITS GAMES STILL TO BE PLAYED, AND
 * EVERYTHING THAT HANGS OFF THEIR KICKOFF, QUIETLY (Kemal, 2026-11-09).
 *
 * The one place this happens. Every save of an Activity's day or time
 * calls it, in the same transaction as the Activity write:
 *   - the edit form on /admin/activities (`updateActivity`,
 *     app/actions/activities.ts);
 *   - finishing a club's setup (`applyEnrichment`,
 *     app/actions/finish-setup.ts).
 * No WhatsApp path changes an Activity's day or time today.
 *
 * Where each game goes is the pure rule in activity-kickoff-move-rules.ts.
 * What follows a moved game here, each in the same transaction:
 *
 *   Match.date, Match.attendanceDeadline
 *       the new kickoff, and the deadline moved by as much. Guarded on the
 *       kickoff and status the game was read at, so a game played,
 *       cancelled or moved by somebody else meanwhile is left alone.
 *   PartnerAsk.closesAt / postBy (open asks; `asksFollowMovedKickoff`,
 *       partner-ask.ts)
 *       the new kickoff and the club's cut-off before it, exactly what the
 *       sweep's "moved game" path would write. Written HERE so the sweep
 *       finds nothing moved and sends nothing: that path DMs the partner's
 *       guests the new time (`tellGuestsMoved`), and this change is silent.
 *   TentativeAvailability.dueAt (a maybe not yet followed up)
 *       re-timed from the new kickoff (`computeFollowupDueAt`).
 *   PoolOffer.expiresAt (offers still open; `offersFollowMovedKickoff`,
 *       pool/round.ts)
 *       the new kickoff (`offerEndsAt`). Every decision already reads the
 *       match's kickoff live; the column is kept true.
 *
 * What needs nothing, read live from Match.date at the moment it is used:
 * the scheduler's posts and their windows (every key is the match id, or
 * the match id and a London date, never a time; a moved game does not send
 * anything a second time), pool rounds and their cut-off, the friend
 * link's code, team proposals' reminder, the drop-out and list deadlines,
 * the matches pages. The generators (nightly cron, monthly lists) dedupe a
 * game by its slot and kickoff (match-slot.ts), and the moved game sits
 * exactly where they would put it, so no second game is made.
 *
 * NOTHING IS POSTED OR SENT. No BotJob, no SentNotification, no
 * PlatformJob is written here.
 */
import type { db } from "./db";
import {
  kickoffChanged,
  planActivityKickoffMove,
  type ActivityKickoff,
  type KickoffStayReason,
} from "./activity-kickoff-move-rules";
import { asksFollowMovedKickoff } from "./partner-ask";
import { offersFollowMovedKickoff } from "./pool/round";
import { computeFollowupDueAt } from "./tentative-followup";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** A game still to be played: not COMPLETED, not CANCELLED. */
export const NOT_PLAYED_STATUSES = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

export interface GamesMoved {
  moved: Array<{ matchId: string; from: Date; to: Date }>;
  stayed: Array<{ matchId: string; reason: KickoffStayReason }>;
}

export async function moveGamesWithActivity(
  tx: Tx,
  p: { activityId: string; orgId: string; before: ActivityKickoff; after: ActivityKickoff; now: Date },
): Promise<GamesMoved> {
  const out: GamesMoved = { moved: [], stayed: [] };
  if (!kickoffChanged(p.before, p.after)) return out;

  const games = await tx.match.findMany({
    where: { activityId: p.activityId, status: { in: [...NOT_PLAYED_STATUSES] }, isHistorical: false, date: { gt: p.now } },
    select: { id: true, date: true, attendanceDeadline: true },
    orderBy: { date: "asc" },
  });

  for (const game of games) {
    const plan = planActivityKickoffMove({ match: game, before: p.before, after: p.after, now: p.now });
    if (!plan.move) {
      if (plan.reason !== "unchanged") out.stayed.push({ matchId: game.id, reason: plan.reason });
      continue;
    }
    const done = await tx.match.updateMany({
      where: { id: game.id, date: game.date, status: { in: [...NOT_PLAYED_STATUSES] } },
      data: { date: plan.kickoff, attendanceDeadline: plan.attendanceDeadline },
    });
    if (done.count === 0) continue;

    // What hangs off the kickoff follows, each through its own module's
    // writer (one writer per table: the source guards).
    await asksFollowMovedKickoff(tx, { matchId: game.id, askerOrgId: p.orgId, kickoff: plan.kickoff });
    await tx.tentativeAvailability.updateMany({
      where: { matchId: game.id, resolvedAt: null, notifiedAt: null, dueAt: { gt: p.now } },
      data: { dueAt: computeFollowupDueAt(plan.kickoff, p.now) },
    });
    await offersFollowMovedKickoff(tx, { matchId: game.id, kickoff: plan.kickoff });
    out.moved.push({ matchId: game.id, from: game.date, to: plan.kickoff });
  }
  return out;
}
