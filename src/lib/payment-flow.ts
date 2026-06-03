/**
 * Payment flow orchestration (2026-06-03) — server-side, no "use server".
 * The bits the bot/webhook call directly (the user-facing server actions
 * live in src/app/actions/payments.ts).
 *
 *   releaseMatchPayments(matchId)  — once the fee is confirmed, DM every
 *     confirmed player a link to /pay/<matchId> and stamp
 *     paymentLinksReleasedAt (gates the chaser).
 *   applyCheckoutPaid(session)     — webhook handler: a Stripe Checkout
 *     completed → mark that player's Attendance paid.
 */

import { db } from "./db";
import { signMagicLinkToken, buildMagicLinkUrl, MAGIC_LINK_TTL } from "./magic-link";
import { gbp } from "./payments";
import type Stripe from "stripe";

/** DM each confirmed player (with a phone) a pay link, once. Idempotent
 *  via per-player BotJob dedupe on a stable text marker isn't reliable,
 *  so we gate on paymentLinksReleasedAt: callers set the fee + call this
 *  exactly once. Returns how many links were queued. */
export async function releaseMatchPayments(matchId: string): Promise<number> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { select: { name: true, orgId: true } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { id: true, name: true, phoneNumber: true } } },
      },
    },
  });
  if (!match || match.feePerPlayer == null) return 0;

  const orgId = match.activity.orgId;
  let queued = 0;
  for (const a of match.attendances) {
    if (!a.user.phoneNumber) continue;
    const token = signMagicLinkToken({
      userId: a.user.id,
      purpose: "sign-in",
      nextPath: `/pay/${matchId}`,
      ttlSeconds: MAGIC_LINK_TTL.permanent,
    });
    const first = a.user.name?.split(" ")[0] ?? "there";
    await db.botJob.create({
      data: {
        orgId,
        kind: "dm",
        phone: a.user.phoneNumber.replace(/^\+/, ""),
        text:
          `💷 ${first} — match fee for *${match.activity.name}* is *${gbp(match.feePerPlayer)}*.\n\n` +
          `Tap to pay (choose Pay by Bank, card, or pay the organiser directly):\n${buildMagicLinkUrl(token)}\n\n` +
          `You can also pay for anyone you brought along.`,
      },
    });
    queued++;
  }
  await db.match.update({
    where: { id: matchId },
    data: { paymentLinksReleasedAt: new Date() },
  });
  return queued;
}

/** Webhook: a Checkout Session completed. Mark the player's attendance
 *  paid. The session carries matchId + userId + quantity in metadata. */
export async function applyCheckoutPaid(session: Stripe.Checkout.Session): Promise<void> {
  const matchId = session.metadata?.matchId;
  const userId = session.metadata?.userId;
  if (!matchId || !userId) {
    console.warn("[payments] checkout completed without matchId/userId metadata", session.id);
    return;
  }
  const amount = session.amount_total != null ? session.amount_total / 100 : null;
  const quantity = Number(session.metadata?.quantity ?? "1") || 1;
  await db.attendance.updateMany({
    where: { matchId, userId },
    data: {
      paidAt: new Date(),
      paymentAmount: amount,
      paymentQuantity: quantity,
      stripeSessionId: session.id,
      directPendingAt: null,
    },
  });
  console.log(`[payments] marked paid: match ${matchId} user ${userId} (£${amount}, x${quantity})`);
}
