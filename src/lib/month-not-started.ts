/**
 * A MONTHLY CLUB WHOSE MONTH IS NOT STARTED (Vets MNF, 2026-11-03). Kemal:
 * for a monthly club the squad STARTS from the posted monthly list; nobody
 * joins by saying IN before it exists. True only when the club is on
 * "monthly" and the match's London month has NO SquadMonth for its fixture,
 * in any status: a month in sign-up, priced, running, held or closed is the
 * monthly flow's own business and behaves exactly as before (review of
 * #502). A fact from the database, never the words.
 */
import { db } from "./db";
import { londonMonthStart, monthStartToDate, normaliseSquadMode } from "./squad-month-rules";

export async function monthNotStartedFor(matchId: string): Promise<boolean> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { date: true, activityId: true, activity: { select: { orgId: true, org: { select: { squadMode: true } } } } },
  });
  if (!match || normaliseSquadMode(match.activity.org.squadMode) !== "monthly") return false;
  const month = await db.squadMonth.findFirst({
    where: { orgId: match.activity.orgId, activityId: match.activityId, monthStart: monthStartToDate(londonMonthStart(match.date)) },
    select: { id: true },
  });
  return month === null;
}
