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
 * Due 08:00 to 21:59 London, after the deadline and before kickoff, for
 * the next live match of its fixture only. A club without the setting
 * (Sutton FC), a club that is not operational (not approved or dormant)
 * and a club with the attendance feature off get nothing.
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
import { isClubOperational } from "./club-approval-state";
import { getOrgFeatures } from "./org-features";
import { isNextUpcomingForPosting } from "./next-upcoming-match";
import { deadlineSummaryDue, weeklyDeadlinesFor } from "./weekly-deadlines";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

export function deadlineSummaryKey(matchId: string): string {
  return `${matchId}:deadline-summary`;
}

export async function sendDueDeadlineSummaries(orgId: string, now: Date = new Date()): Promise<{ sent: number }> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      language: true,
      approvalStatus: true,
      dormantAt: true,
      dropOutDeadlineDay: true,
      dropOutDeadlineTime: true,
      listPublishDay: true,
      listPublishTime: true,
    },
  });
  if (!org || org.dropOutDeadlineDay == null || org.dropOutDeadlineTime == null) return { sent: 0 };
  if (!isClubOperational(org)) return { sent: 0 };
  if (!(await getOrgFeatures(orgId)).attendance) return { sent: 0 };

  // Every live match, past kickoff or not: the next-upcoming gate needs
  // this week's match even when next week's is the one being looked at.
  const matches = await db.match.findMany({
    where: { activity: { orgId }, isHistorical: false, status: { in: [...LIVE] } },
    include: {
      activity: { select: { orgId: true, name: true, venue: true, dayOfWeek: true } },
      attendances: { select: { userId: true, status: true, position: true, user: { select: { name: true } } } },
    },
    orderBy: { date: "asc" },
  });

  const s = t(org.language);
  let sent = 0;
  for (const m of matches) {
    const { dropOut } = weeklyDeadlinesFor(m.date, org);
    if (!dropOut || !deadlineSummaryDue(now, dropOut, m.date)) continue;
    if (!isNextUpcomingForPosting(matches, m)) continue;

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
          whenLabel: dayTimeLabel(org.language, m.date),
          confirmed: confirmed.length,
          maxPlayers: m.maxPlayers,
          out: named(byPosition.filter((a) => a.status === "DROPPED")),
          maybe: named(confirmed.filter((a) => maybeIds.has(a.userId))),
          waiting: named(byPosition.filter((a) => a.status === "BENCH")),
          open: Math.max(0, m.maxPlayers - confirmed.length),
          lang: org.language,
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
