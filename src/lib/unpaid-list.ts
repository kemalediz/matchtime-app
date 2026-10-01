/**
 * U1, THE ORGANISERS' UNPAID LIST (2026-10-01), section 2.12 of
 * MDs/friday-group-features-plan-2026-09-30.md.
 *
 * At 10:00 London two days after a COMPLETED match, a club with payment
 * tracking on and at least one unpaid CONFIRMED player gets one message
 * in its admin channel: who has not paid and how many have. The count is
 * the group tail's rule (`summariseUnpaid`: the payment holder left out,
 * bulk credits subtracted, nothing when nobody has paid yet).
 *
 * ONLY clubs on "one-person" or "admin-group". A club on "each-admin" (the
 * migration put every club that existed before the admin channel there,
 * Sutton FC included) gets nothing new.
 *
 * Called from `/api/whatsapp/due-posts` on each poll of the club's group,
 * before the posts are computed, like the deadline summary
 * (`deadline-summary.ts`): it queues through `sendAdminNotice`, the admin
 * channel's one door, which posts in the admin group when the Pi can and
 * falls back to the owner by DM when it cannot. Not part of
 * `computeDuePosts`, which must stay free of side effects.
 *
 * Once per match: claimed by the `SentNotification` key
 * `<matchId>:unpaid-list` (unique; first writer wins), released when the
 * notice could not be queued so the next poll tries again. Missed at
 * 10:00, it retries 10:00 to 20:59 on the following days
 * (`unpaidFollowUpDue`).
 */
import { db } from "./db";
import { sendAdminNotice } from "./admin-channel";
import { normaliseAdminChannelMode } from "./admin-channel-rules";
import { buildUnpaidListAdminNotice } from "./dm-copy";
import { dayTimeLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { isClubOperational } from "./club-approval-state";
import { summariseUnpaid, unpaidFollowUpDue, UNPAID_FOLLOW_UP_RETRY_DAYS } from "./unpaid-rules";

export function unpaidListKey(matchId: string): string {
  return `${matchId}:unpaid-list`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function sendDueUnpaidLists(orgId: string, now: Date = new Date()): Promise<{ sent: number }> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      language: true,
      approvalStatus: true,
      dormantAt: true,
      billingStatus: true,
      adminChannelMode: true,
      paymentTrackingEnabled: true,
      paymentHolderId: true,
    },
  });
  if (!org || !org.paymentTrackingEnabled) return { sent: 0 };
  if (normaliseAdminChannelMode(org.adminChannelMode) === "each-admin") return { sent: 0 };
  if (!isClubOperational(org)) return { sent: 0 };

  // Only a match whose follow-up window can still be open: two days to the
  // first try, the retry days, and one day of slack.
  const since = new Date(now.getTime() - (2 + UNPAID_FOLLOW_UP_RETRY_DAYS + 1) * DAY_MS);
  const matches = await db.match.findMany({
    where: {
      activity: { orgId },
      status: "COMPLETED",
      isHistorical: false,
      postMatchEndFlow: true,
      date: { gte: since },
    },
    include: {
      activity: { select: { name: true } },
      attendances: {
        where: { status: "CONFIRMED" },
        select: { userId: true, position: true, paidAt: true, user: { select: { name: true } } },
      },
      paymentCredits: { select: { count: true } },
    },
    orderBy: { date: "asc" },
  });

  const s = t(org.language);
  let sent = 0;
  for (const m of matches) {
    if (!unpaidFollowUpDue(now, m.date)) continue;
    const summary = summariseUnpaid({
      confirmed: [...m.attendances]
        .sort((a, b) => a.position - b.position)
        .map((a) => ({ userId: a.userId, paidAt: a.paidAt, name: a.user.name })),
      payerId: org.paymentHolderId ?? null,
      creditCount: (m.paymentCredits ?? []).reduce((sum, c) => sum + c.count, 0),
    });
    if (!summary) continue;

    const key = unpaidListKey(m.id);
    try {
      await db.sentNotification.create({ data: { key, kind: "admin-notice", matchId: m.id } });
    } catch {
      continue; // already sent, or another poll won the claim
    }

    try {
      await sendAdminNotice({
        orgId,
        now,
        text: buildUnpaidListAdminNotice({
          activityName: m.activity.name,
          whenLabel: dayTimeLabel(org.language, m.date),
          names: summary.unpaidNames.map((n) => n ?? s.unnamed),
          paid: summary.paid,
          n: summary.n,
          lang: org.language,
        }),
      });
      sent++;
    } catch (err) {
      console.error(`[unpaid-list] org ${orgId} match ${m.id}: notice not queued, claim released:`, err);
      await db.sentNotification.deleteMany({ where: { key } }).catch(() => {});
    }
  }
  return { sent };
}
