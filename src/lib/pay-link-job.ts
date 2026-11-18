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
 *   hold  the check could not be made (a read or the delete failed): not
 *         sent this poll, still queued, looked at again on the next one.
 *         Never "send on failure": that is the bug this fixes.
 */
import { db } from "./db";
import { parsePayLinkAboutKey, payLinkNotOwedReason, type PayLinkAttendance } from "./pay-link-job-rules";

export type PayLinkVerdict = "send" | "drop" | "hold";

export async function payLinkJobVerdicts(
  jobs: ReadonlyArray<{ id: string; aboutKey: string | null }>,
): Promise<Map<string, PayLinkVerdict>> {
  const out = new Map<string, PayLinkVerdict>();
  const links = jobs.flatMap((j) => {
    const about = parsePayLinkAboutKey(j.aboutKey);
    return about ? [{ id: j.id, ...about }] : [];
  });
  if (links.length === 0) return out;

  let matches: Map<string, { status: string; feePerPlayer: number | null; paymentLinksReleasedAt: Date | null; collectorId: string | null }>;
  let rows: Map<string, PayLinkAttendance>;
  try {
    const matchIds = [...new Set(links.map((l) => l.matchId))];
    const [ms, as] = await Promise.all([
      db.match.findMany({
        where: { id: { in: matchIds } },
        select: {
          id: true,
          status: true,
          feePerPlayer: true,
          paymentLinksReleasedAt: true,
          activity: { select: { org: { select: { paymentHolderId: true } } } },
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
    ]);
    matches = new Map(
      ms.map((m) => [
        m.id,
        {
          status: String(m.status),
          feePerPlayer: m.feePerPlayer,
          paymentLinksReleasedAt: m.paymentLinksReleasedAt,
          collectorId: m.activity.org.paymentHolderId ?? null,
        },
      ]),
    );
    rows = new Map(as.map((a) => [`${a.matchId}:${a.userId}`, { ...a, status: String(a.status) }]));
  } catch (err) {
    console.error("[pay-link] send-time check failed, holding the pay links this poll:", err instanceof Error ? err.message : "failed");
    for (const l of links) out.set(l.id, "hold");
    return out;
  }

  for (const l of links) {
    const reason = payLinkNotOwedReason({
      userId: l.userId,
      attendance: rows.get(`${l.matchId}:${l.userId}`) ?? null,
      match: matches.get(l.matchId) ?? null,
    });
    if (!reason) {
      out.set(l.id, "send");
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
