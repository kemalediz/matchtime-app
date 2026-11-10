/**
 * A WEEKLY GAME'S KICKOFF CHANGED: MOVE ITS GAMES STILL TO BE PLAYED, AND
 * EVERYTHING THAT HANGS OFF THEIR KICKOFF, QUIETLY (Kemal, 2026-11-09).
 *
 * The one place this happens. Every save of an Activity's day or time
 * calls it, in the same transaction as the Activity write:
 *   - the edit form on /admin/activities (`updateActivity`,
 *     app/actions/activities.ts);
 *   - finishing a club's setup (`applyEnrichment`,
 *     app/actions/finish-setup.ts);
 *   - an organiser tagging MatchTime, "@Match Time from now on we kick
 *     off at 8:15" (2026-11-10, `changeActivityKickoff` below, called by
 *     `game-move-words.ts`).
 * And ONE game moved by an organiser ("@Match Time move Monday's game to
 * 8:15", 2026-11-10) goes through `moveOneGame` below: the same rule for
 * the game (`planGameKickoff`) and the same writes for what hangs off it
 * (`followNewKickoff`). A game moved alone no longer sits on its
 * activity's own time, so a later weekly change leaves it where it is
 * (the rule's "set-by-hand"): no flag is needed to say so.
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
import { db } from "./db";
import { activityUpdateData } from "./activity-update";
import {
  kickoffChanged,
  planActivityKickoffMove,
  planGameKickoff,
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
  /** `at`: the kickoff it keeps, for the WhatsApp reply that lists it. */
  stayed: Array<{ matchId: string; reason: KickoffStayReason; at: Date }>;
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
      if (plan.reason !== "unchanged") out.stayed.push({ matchId: game.id, reason: plan.reason, at: game.date });
      continue;
    }
    if (!(await followNewKickoff(tx, { game, orgId: p.orgId, plan, now: p.now }))) continue;
    out.moved.push({ matchId: game.id, from: game.date, to: plan.kickoff });
  }
  return out;
}

/**
 * One game to its planned kickoff, and what hangs off the kickoff with it,
 * in the caller's transaction. False when the game changed under us
 * (played, cancelled or moved by somebody else since it was read): then
 * nothing is written. Shared by the weekly change and the one-game move.
 */
async function followNewKickoff(
  tx: Tx,
  p: { game: { id: string; date: Date }; orgId: string; plan: { kickoff: Date; attendanceDeadline: Date }; now: Date },
): Promise<boolean> {
  const { game, plan } = p;
  const done = await tx.match.updateMany({
    where: { id: game.id, date: game.date, status: { in: [...NOT_PLAYED_STATUSES] } },
    data: { date: plan.kickoff, attendanceDeadline: plan.attendanceDeadline },
  });
  if (done.count === 0) return false;

  // What hangs off the kickoff follows, each through its own module's
  // writer (one writer per table: the source guards).
  await asksFollowMovedKickoff(tx, { matchId: game.id, askerOrgId: p.orgId, kickoff: plan.kickoff });
  await tx.tentativeAvailability.updateMany({
    where: { matchId: game.id, resolvedAt: null, notifiedAt: null, dueAt: { gt: p.now } },
    data: { dueAt: computeFollowupDueAt(plan.kickoff, p.now) },
  });
  await offersFollowMovedKickoff(tx, { matchId: game.id, kickoff: plan.kickoff });
  return true;
}

export type OneGameMoved =
  | { moved: true; matchId: string; from: Date; to: Date }
  /** `gone`: not the club's, or no longer to be played (or it changed
   *  under us); `from` is null when it was not found at all. */
  | { moved: false; matchId: string; reason: KickoffStayReason | "gone"; from: Date | null };

/**
 * ONE GAME TO A NEW KICKOFF (2026-11-10, "@Match Time move Monday's game
 * to 8:15"): the club's game still to be played, to `toTime` London and,
 * when given, to `toDayOfWeek` in the same Monday-to-Sunday week. In its
 * own transaction. Nothing is posted or sent.
 */
export async function moveOneGame(p: {
  matchId: string;
  orgId: string;
  toDayOfWeek: number | null;
  toTime: string;
  now: Date;
}): Promise<OneGameMoved> {
  return db.$transaction(async (tx) => {
    const game = await tx.match.findFirst({
      where: { id: p.matchId, activity: { orgId: p.orgId }, status: { in: [...NOT_PLAYED_STATUSES] }, isHistorical: false },
      select: { id: true, date: true, attendanceDeadline: true, status: true },
    });
    if (!game) return { moved: false, matchId: p.matchId, reason: "gone", from: null };
    const plan = planGameKickoff({ match: game, toDayOfWeek: p.toDayOfWeek, toTime: p.toTime, now: p.now });
    if (!plan.move) return { moved: false, matchId: game.id, reason: plan.reason, from: game.date };
    if (!(await followNewKickoff(tx, { game, orgId: p.orgId, plan, now: p.now }))) {
      return { moved: false, matchId: game.id, reason: "gone", from: game.date };
    }
    return { moved: true, matchId: game.id, from: game.date, to: plan.kickoff };
  });
}

export type ActivityKickoffChanged =
  | ({ ok: true; activityName: string; before: ActivityKickoff; after: ActivityKickoff } & GamesMoved)
  | { ok: false; reason: "not-found" | "invalid" }
  | { ok: false; reason: "unchanged"; activityName: string; kickoff: ActivityKickoff };

/**
 * THE WEEKLY GAME'S DAY OR TIME, FROM NOW ON (2026-11-10, "@Match Time
 * from now on we kick off at 8:15"): the club's activity gets its new day
 * or time, checked exactly as the edit form checks them
 * (`activityUpdateData`), and its games still to be played move with it
 * (`moveGamesWithActivity`), in one transaction, as `updateActivity` does.
 * Nothing is posted or sent.
 */
export async function changeActivityKickoff(p: {
  activityId: string;
  orgId: string;
  dayOfWeek?: number;
  time?: string;
  now: Date;
}): Promise<ActivityKickoffChanged> {
  return db.$transaction(async (tx) => {
    const activity = await tx.activity.findFirst({
      where: { id: p.activityId, orgId: p.orgId },
      select: { id: true, name: true, dayOfWeek: true, time: true, feeSplitTotal: true, venue: true },
    });
    if (!activity) return { ok: false, reason: "not-found" };
    const asked: { dayOfWeek?: number; time?: string } = {};
    if (p.dayOfWeek !== undefined) asked.dayOfWeek = p.dayOfWeek;
    if (p.time !== undefined) asked.time = p.time;
    const checked = activityUpdateData(asked, { feeSplitTotal: activity.feeSplitTotal, venue: activity.venue });
    if (!checked.ok) return { ok: false, reason: "invalid" };
    const before = { dayOfWeek: activity.dayOfWeek, time: activity.time };
    const after = { dayOfWeek: checked.data.dayOfWeek ?? activity.dayOfWeek, time: checked.data.time ?? activity.time };
    if (!kickoffChanged(before, after)) return { ok: false, reason: "unchanged", activityName: activity.name, kickoff: before };

    const data: { dayOfWeek?: number; time?: string } = {};
    if (after.dayOfWeek !== before.dayOfWeek) data.dayOfWeek = after.dayOfWeek;
    if (after.time !== before.time) data.time = after.time;
    await tx.activity.update({ where: { id: activity.id }, data });
    const games = await moveGamesWithActivity(tx, { activityId: activity.id, orgId: p.orgId, before, after, now: p.now });
    return { ok: true, activityName: activity.name, before, after, ...games };
  });
}
