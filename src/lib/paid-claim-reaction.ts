/**
 * A ✅ ON THE PLAYER'S OWN "PAID" DM (Kemal, 2026-10-16).
 *
 * When a player DMs MatchTime that they have paid and the claim is
 * recorded (`payment-claim.ts`, including the "already done" repeat),
 * MatchTime reacts ✅ to that DM, so the player sees at a glance that the
 * message was read, on top of the written reply.
 *
 * THE PATH IS THE EXISTING ONE. The reaction is a `RetroReaction` row.
 * The due-posts poll emits every unsent row as an `update-reaction`
 * instruction (`bot-scheduler.ts`, "Retroactive reactions"), the Pi
 * places it with `reactAndReport` → `driver.sendReaction`, the same code
 * that places the players' group reactions, and ACKs `retro-react-<id>`
 * (`/api/whatsapp/ack` sets `sentAt`). The Pi needs no change: it has
 * understood `update-reaction` for months, and a DM id
 * (`false_<lid>@lid_<id>`) parses into a message key exactly like a group
 * one. A reaction that fails on the Pi is logged there with its reason
 * and still ACKed; nobody is told anything.
 *
 * It arrives on the same poll that delivers the written reply (a `dm`
 * BotJob), so the ✅ and the thanks land together.
 *
 * The functions take the Prisma client as an argument so the backfill
 * script (`scripts/react-paid-claims.ts`) can pass its own.
 */

export const PAID_CLAIM_REACTION = "✅";

/** `whatsapp-bot/src/message-id.ts` SYNTHETIC_WA_ID_PREFIX: an id the Pi
 *  invented because the real one was unreadable. WhatsApp never issued
 *  it, so there is no message to react to. */
const SYNTHETIC_WA_ID_PREFIX = "synthetic:";

/** The replay guard `payment-claim.ts` writes for every claim it acts on. */
export const PAID_CLAIM_KEY_PREFIX = "paid-claim:";

export interface RetroReactionClient {
  retroReaction: {
    findFirst(args: { where: { waMessageId: string; emoji: string }; select: { id: true } }): Promise<unknown>;
    create(args: {
      data: { orgId: string; waMessageId: string; emoji: string; reason?: string | null };
    }): Promise<unknown>;
  };
}

export type QueuePaidClaimReactionOutcome = "queued" | "already-queued" | "no-real-id";

function isRealWaMessageId(id: string): boolean {
  return id.length > 0 && !id.startsWith(SYNTHETIC_WA_ID_PREFIX);
}

/**
 * Queue a ✅ on the player's DM. Never twice on the same message, sent or
 * not, so a re-run of the backfill (or a backfill after the live path
 * already reacted) is a no-op.
 */
export async function queuePaidClaimReaction(
  client: RetroReactionClient,
  input: { orgId: string; waMessageId: string; reason?: string },
): Promise<QueuePaidClaimReactionOutcome> {
  const { orgId, waMessageId } = input;
  if (!isRealWaMessageId(waMessageId)) return "no-real-id";
  const existing = await client.retroReaction.findFirst({
    where: { waMessageId, emoji: PAID_CLAIM_REACTION },
    select: { id: true },
  });
  if (existing) return "already-queued";
  await client.retroReaction.create({
    data: { orgId, waMessageId, emoji: PAID_CLAIM_REACTION, reason: input.reason ?? "paid claim" },
  });
  return "queued";
}

// ── The backfill's selection ─────────────────────────────────────────

/** A `paid-claim:<waMessageId>` SentNotification joined with the
 *  player's Attendance row on that match. */
export interface PaidClaimLedgerRow {
  key: string;
  createdAt: Date;
  matchId: string;
  userId: string;
  paymentMethod: string | null;
  directPendingAt: Date | null;
  paidAt: Date | null;
}

export interface PaidClaimReactionTarget {
  waMessageId: string;
  matchId: string;
  userId: string;
  claimedAt: Date;
}

export function waMessageIdOfPaidClaimKey(key: string): string | null {
  if (!key.startsWith(PAID_CLAIM_KEY_PREFIX)) return null;
  const id = key.slice(PAID_CLAIM_KEY_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * The claims that were RECORDED. The replay guard is written before the
 * write is attempted, so it also exists for a "paid for my mate" (nothing
 * written) and a claim blocked at write time. A recorded claim is one
 * whose own write is visible: the row is on direct payment and its
 * pending stamp (or, once the collector confirmed, its paid stamp) is not
 * older than the claim.
 */
export function selectPaidClaimReactionTargets(rows: PaidClaimLedgerRow[]): PaidClaimReactionTarget[] {
  const out: PaidClaimReactionTarget[] = [];
  for (const r of rows) {
    const id = waMessageIdOfPaidClaimKey(r.key);
    if (!id || !isRealWaMessageId(id)) continue;
    if (r.paymentMethod !== "direct") continue;
    const t = r.createdAt.getTime();
    const recorded =
      (r.directPendingAt != null && r.directPendingAt.getTime() >= t) ||
      (r.paidAt != null && r.paidAt.getTime() >= t);
    if (!recorded) continue;
    out.push({ waMessageId: id, matchId: r.matchId, userId: r.userId, claimedAt: r.createdAt });
  }
  return out;
}
