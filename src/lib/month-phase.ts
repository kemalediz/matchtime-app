/**
 * ONE MATCH'S MONTH, FOR A DOOR WITH NO CLUB SUMMARY (club summary, slice
 * B2). Reads only what the phase needs (the match, its game's month row by
 * the table's unique key, the held key of that game and month) and runs the
 * summary's own phase function on it (`monthPhaseFor`), so this door and
 * the summary can never disagree. The players' group fallback (the summary
 * could not be read) and "Squad complete" read it.
 */
import { db } from "./db";
import { monthFacts, monthPhaseFor } from "./club-summary/derive";
import type { MatchMonthFacts } from "./club-summary/types";
import { monthFlowOf, stillToPlay, type MonthFlow } from "./monthly-gates";
import { londonMonthStart, monthStartToDate, normaliseSquadMode, type SquadMode } from "./squad-month-rules";

export interface MatchMonth {
  mode: SquadMode;
  /** Null for a weekly club. */
  month: MatchMonthFacts | null;
  flow: MonthFlow;
}

export async function loadMatchMonth(matchId: string, now: Date = new Date()): Promise<MatchMonth | null> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { date: true, status: true, activityId: true, rollingSeededAt: true, activity: { select: { orgId: true, org: { select: { squadMode: true } } } } },
  });
  if (!match) return null;
  const mode = normaliseSquadMode(match.activity.org.squadMode);
  if (mode !== "monthly") return { mode, month: null, flow: "weekly" };
  const orgId = match.activity.orgId;
  const monthStart = londonMonthStart(match.date);
  const heldKey = `org-${orgId}:msu:held:${monthStart}:${match.activityId}`;
  const [row, held] = await Promise.all([
    db.squadMonth.findUnique({
      where: { orgId_activityId_monthStart: { orgId, activityId: match.activityId, monthStart: monthStartToDate(monthStart) } },
      select: { id: true, activityId: true, monthStart: true, status: true, listOpenedAt: true, pricedAt: true, closedAt: true, createdAt: true, startedMidMonthAt: true },
    }),
    db.sentNotification.findUnique({ where: { key: heldKey }, select: { key: true } }),
  ]);
  const months = row ? monthFacts([{ ...row, members: [] }]) : [];
  const month = monthPhaseFor({ orgId, match, months, heldKeys: held ? [held.key] : [] });
  return { mode, month, flow: monthFlowOf({ mode, month, stillToPlay: stillToPlay(match, now) }) };
}
