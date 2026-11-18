/**
 * The send-time check on queued pay links (Sutton, 2026-11-17; the rule and
 * the story are in pay-link-job-rules.ts). Read by the scheduler's BotJob
 * block just before it hands due jobs to the Pi.
 *
 * Verdict per pay-link job (any other job gets none and goes as before):
 *   send  the player still owes: hand it to the Pi;
 *   drop  they no longer owe: the unsent job is deleted, never sent. A
 *         delete, not a `sentAt` stamp, because the chat context reads
 *         stamped BotJobs as messages MatchTime sent (reply-context.ts);
 *   hold  not handed out this poll and left exactly as it is:
 *           - already claimed (its `botjob-<id>` SentNotification row
 *             exists): it went to the Pi and may have been sent, only not
 *             acked yet, so it is a real message and is never deleted. The
 *             scheduler's own sent-key read does not load these rows (they
 *             carry no matchId and no `org-` key), so they are read here;
 *           - preview (`x-no-claim`, tests only): nothing is written;
 *           - the check could not be made (a read or the delete failed):
 *             looked at again next poll. Never "send on failure": that is
 *             the bug this fixes.
 */
import { db } from "./db";
import { parsePayLinkAboutKey, payLinkNotOwedReason, type PayLinkAttendance, type PayLinkMatch } from "./pay-link-job-rules";

export type PayLinkVerdict = "send" | "drop" | "hold";

export async function payLinkJobVerdicts(
  jobs: ReadonlyArray<{ id: string; aboutKey: string | null }>,
  opts: { preview?: boolean } = {},
): Promise<Map<string, PayLinkVerdict>> {
  const out = new Map<string, PayLinkVerdict>();
  const links = jobs.flatMap((j) => {
    const about = parsePayLinkAboutKey(j.aboutKey);
    return about ? [{ id: j.id, ...about }] : [];
  });
  if (links.length === 0) return out;

  let matches: Map<string, PayLinkMatch>;
  let rows: Map<string, PayLinkAttendance>;
  let claimed: Set<string>;
  try {
    const matchIds = [...new Set(links.map((l) => l.matchId))];
    const [ms, as, cs] = await Promise.all([
      db.match.findMany({
        where: { id: { in: matchIds } },
        select: {
          id: true,
          status: true,
          feePerPlayer: true,
          paymentLinksReleasedAt: true,
          activity: { select: { org: { select: { paymentHolderId: true, paymentCollectionEnabled: true } } } },
        },
      }),
      db.attendance.findMany({
        where: { OR: links.map((l) => ({ matchId: l.matchId, userId: l.userId })) },
        select: {
          matchId: true,
          userId: true,
          status: true,
          paidAt: true,
          feeWaivedAt: true,
          directPendingAt: true,
          paymentMethod: true,
        },
      }),
      db.sentNotification.findMany({
        where: { key: { in: links.map((l) => `botjob-${l.id}`) } },
        select: { key: true },
      }),
    ]);
    matches = new Map(
      ms.map((m) => [
        m.id,
        {
          status: String(m.status),
          feePerPlayer: m.feePerPlayer,
          paymentLinksReleasedAt: m.paymentLinksReleasedAt,
          collectorId: m.activity.org.paymentHolderId ?? null,
          collectionEnabled: m.activity.org.paymentCollectionEnabled === true,
        },
      ]),
    );
    rows = new Map(as.map((a) => [`${a.matchId}:${a.userId}`, { ...a, status: String(a.status) }]));
    claimed = new Set(cs.map((c) => c.key));
  } catch (err) {
    console.error("[pay-link] send-time check failed, holding the pay links this poll:", err instanceof Error ? err.message : "failed");
    for (const l of links) out.set(l.id, "hold");
    return out;
  }

  for (const l of links) {
    if (claimed.has(`botjob-${l.id}`)) {
      out.set(l.id, "hold");
      continue;
    }
    const reason = payLinkNotOwedReason({
      userId: l.userId,
      attendance: rows.get(`${l.matchId}:${l.userId}`) ?? null,
      match: matches.get(l.matchId) ?? null,
    });
    if (!reason) {
      out.set(l.id, "send");
      continue;
    }
    if (opts.preview) {
      out.set(l.id, "hold");
      continue;
    }
    try {
      await db.botJob.deleteMany({ where: { id: l.id, sentAt: null } });
      console.log(`[pay-link] job ${l.id} (match ${l.matchId} user ${l.userId}): not sent, ${reason} since it was queued`);
      out.set(l.id, "drop");
    } catch (err) {
      console.error(`[pay-link] job ${l.id}: could not delete (${reason}), holding:`, err instanceof Error ? err.message : "failed");
      out.set(l.id, "hold");
    }
  }
  return out;
}
