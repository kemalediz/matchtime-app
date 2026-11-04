/**
 * THE ONE RULE'S I/O HALF (club summary, slice B6; the rule is
 * `club-voice.ts`): the reads and writes a door needs around it.
 */
import { db } from "./db";
import { clubVoice, voiceFactsOfRow, VOICE_SELECT } from "./club-voice";

export type DmClubsSilence = "club-dormant" | "club-muted" | "club-not-served";

/**
 * The DM door's third rail (after the approval and billing rail and the
 * setting-up rail, dm-reply/route.ts): does this sender belong, today, only
 * to clubs MatchTime does not speak for? null = no (or he is in no club: a
 * pool player), carry on. Otherwise why, for the log: every club muted
 * ("club-muted" when one of them is), dormant ("club-dormant"), or a mix of
 * the reasons the earlier rails name one at a time ("club-not-served").
 * Either way the DM goes nowhere near a model and nothing is queued: his
 * club's players' group would not have read him either.
 */
export async function dmClubsSilence(userId: string): Promise<DmClubsSilence | null> {
  const rows =
    (await db.membership.findMany({
      where: { userId, leftAt: null },
      select: { org: { select: VOICE_SELECT } },
    })) ?? [];
  if (rows.length === 0) return null;
  const voices = rows.map((r) => clubVoice(voiceFactsOfRow(r.org)));
  if (voices.some((v) => v.state === "on")) return null;
  if (voices.some((v) => v.state === "muted")) return "club-muted";
  if (voices.every((v) => v.state === "silent" && v.because === "dormant")) return "club-dormant";
  return "club-not-served";
}

/** What `dropQueuedMessages` writes through: `db`, or a transaction. */
export interface QueueClient {
  botJob: { updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }> };
}

/**
 * NO CATCH-UP (the rule's "what is queued waits, and is dropped when the
 * club comes back"): every message the club queued while it was silent and
 * that is due by now is marked sent without going out. A personal reminder
 * set for later (`sendAfter` still ahead) is kept. The billing resume
 * (club-billing.ts) and the wake from dormancy (actions/org.ts) both call
 * it, so the two ways back say the same thing.
 */
export async function dropQueuedMessages(client: QueueClient, orgId: string, now: Date): Promise<number> {
  const dropped = await client.botJob.updateMany({
    where: {
      orgId,
      sentAt: null,
      createdAt: { lt: now },
      OR: [{ sendAfter: null }, { sendAfter: { lte: now } }],
    },
    data: { sentAt: now },
  });
  return dropped.count;
}
