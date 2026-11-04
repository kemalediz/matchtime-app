/**
 * THE DROP-OUT DEADLINE SUMMARY (2026-09-30), D2 of slice 3 of
 * MDs/friday-group-features-plan-2026-09-30.md (section 3.2).
 *
 * When a club's weekly drop-out deadline has passed, its organisers get
 * one message: the squad count, who is out this week, which confirmed
 * players said "maybe", the waiting list, and the places open. It goes
 * through `sendAdminNotice`, the one door slice 2a turns into the admin
 * channel router, so this module never picks recipients.
 *
 * Called from `/api/whatsapp/due-posts` on each poll of the club's group,
 * before the posts are computed, so the notice's BotJob goes out in the
 * same poll. It is NOT part of `computeDuePosts`, which must stay free of
 * side effects: the preview mode of that route relies on it.
 *
 * Once per match: claimed by the `SentNotification` key
 * `<matchId>:deadline-summary` (unique; first writer wins). If the notice
 * cannot be queued the claim is released so the next poll tries again.
 * Due outside the club's quiet hours (by default 09:00 to 22:59 London), after the deadline and before kickoff, for
 * the next live match of its fixture only, and never for a match made
 * after its own deadline (2026-10-15, `madeAfterDropOutDeadline`). The
 * first line names the deadline and the kick-off, each for what it is. A club without the setting
 * (Sutton FC), a club that is not operational (not approved or dormant)
 * and a club with the attendance feature off get nothing: each read from
 * the club's summary (club summary A1), not from a query of its own.
 *
 * With organiser pick (slice 2b) and something to pick (a free place and
 * somebody waiting), this summary IS the first pick round:
 * `sweepOrganiserPicks` (src/lib/organiser-pick.ts) runs first in the same
 * poll, sends the pick message with the "Drop-out deadline passed" lead,
 * and claims `<matchId>:deadline-summary`, so the claim below finds it
 * taken and nothing is sent twice. With nothing to pick, this summary goes
 * out as for any club.
 */
import { db } from "./db";
import { sendAdminNotice } from "./admin-channel";
import { buildDeadlineSummaryAdminNotice } from "./dm-copy";
import { dayTimeLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { isNextUpcomingForPosting } from "./next-upcoming-match";
import { postingMatchWhere } from "./scheduler-windows";
import { deadlineSummaryDue, madeAfterDropOutDeadline, weeklyDeadlinesFor } from "./weekly-deadlines";
import type { ClubSummary } from "./club-summary/types";
import { placesOpen } from "./squad-short";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

export function deadlineSummaryKey(matchId: string): string {
  return `${matchId}:deadline-summary`;
}

/**
 * The club's facts come from its summary (club summary A1): the poll's one
 * summary of the club, read before this runs. Null (the club could not be
 * read): nothing.
 */
export async function sendDueDeadlineSummaries(club: ClubSummary | null, now: Date = new Date()): Promise<{ sent: number }> {
  if (!club) return { sent: 0 };
  const orgId = club.orgId;
  const deadlines = club.routine.weeklyDeadlineSettings;
  if (deadlines.dropOutDeadlineDay == null || deadlines.dropOutDeadlineTime == null) return { sent: 0 };
  if (!club.lifecycle.operational) return { sent: 0 };
  if (!club.features.attendance) return { sent: 0 };

  // The posting rule's matches (`postingMatchWhere`): every live match, past
  // kickoff or not (the gate needs this week's match even when next week's is
  // the one being looked at), and the cancelled ones whose London day may
  // still hold the fixture's next match (club summary B4, decision K5). Only
  // the live ones are summed up.
  const matches = await db.match.findMany({
    where: postingMatchWhere(orgId, now),
    include: {
      activity: { select: { orgId: true, name: true, venue: true, dayOfWeek: true } },
      attendances: { select: { userId: true, status: true, position: true, user: { select: { name: true } } } },
    },
    orderBy: { date: "asc" },
  });

  const s = t(club.language);
  let sent = 0;
  for (const m of matches) {
    if (!(LIVE as readonly string[]).includes(m.status)) continue;
    const { dropOut } = weeklyDeadlinesFor(m.date, deadlines);
    if (!dropOut || !deadlineSummaryDue(now, dropOut, m.date, club.routine.quietHours)) continue;
    // A game made after its own deadline (a club that went live late in
    // the week, 2026-10-15): nobody could drop out of it, nothing to sum up.
    if (madeAfterDropOutDeadline(m.createdAt, dropOut)) continue;
    if (!isNextUpcomingForPosting(matches, m, now)) continue;

    const key = deadlineSummaryKey(m.id);
    try {
      await db.sentNotification.create({ data: { key, kind: "admin-notice", matchId: m.id } });
    } catch {
      continue; // already sent, or another poll won the claim
    }

    try {
      const byPosition = [...m.attendances].sort((a, b) => a.position - b.position);
      const named = (rows: typeof byPosition) => rows.map((a) => a.user.name ?? s.unnamed);
      const confirmed = byPosition.filter((a) => a.status === "CONFIRMED");
      const maybes = await db.tentativeAvailability.findMany({
        where: { matchId: m.id, resolvedAt: null, userId: { in: confirmed.map((a) => a.userId) } },
        select: { userId: true },
      });
      const maybeIds = new Set(maybes.map((r) => r.userId));
      await sendAdminNotice({
        orgId,
        now,
        text: buildDeadlineSummaryAdminNotice({
          activityName: m.activity.name,
          whenLabel: dayTimeLabel(club.language, m.date),
          deadlineLabel: dayTimeLabel(club.language, dropOut),
          confirmed: confirmed.length,
          maxPlayers: m.maxPlayers,
          out: named(byPosition.filter((a) => a.status === "DROPPED")),
          maybe: named(confirmed.filter((a) => maybeIds.has(a.userId))),
          waiting: named(byPosition.filter((a) => a.status === "BENCH")),
          open: placesOpen(m.maxPlayers, confirmed.length),
          lang: club.language,
        }),
      });
      sent++;
    } catch (err) {
      console.error(`[deadline-summary] org ${orgId} match ${m.id}: notice not queued, claim released:`, err);
      await db.sentNotification.deleteMany({ where: { key } }).catch(() => {});
    }
  }
  return { sent };
}
