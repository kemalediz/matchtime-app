/**
 * "SETTLE DIRECTLY", ONCE (2026-09-23). Server-side, no "use server".
 *
 * A player can tell MatchTime they are paying the money collector
 * outside Stripe (cash, a bank transfer) in two ways:
 *
 *   - the pay page's "Pay the collector directly" button
 *     (`payDirect` in app/actions/payments.ts), and
 *   - a DM to MatchTime saying "Paid" (`lib/payment-claim.ts`).
 *
 * Both call `markDirectPaymentPending` and nothing else, so the pending
 * state, the collector's notification and the repeat suppression cannot
 * drift between them.
 *
 * ── WHAT IT NEVER DOES ─────────────────────────────────────────────
 * It never sets `Attendance.paidAt`. MatchTime cannot see money arrive;
 * a player's word is a PENDING state (`directPendingAt`) and a DM to the
 * collector with a link to confirm. Only the collector's confirmation
 * (`confirmDirectPayment`) or a settled Stripe payment
 * (`applyCheckoutEvent`) marks a player paid.
 * `__tests__/paid-claim-never-sets-paid-at.test.ts` holds that line.
 */
import { db } from "./db";
import { ALREADY_PAID_REASON, payBlockedReason } from "./payment-outcome";
import { buildDirectPayCollectorNotice } from "./dm-copy";

/** Which door the player came through. Only the collector's wording
 *  differs: "they'll pay you" from the button, "they've paid you" from a
 *  DM. */
export type DirectPaymentVia = "pay-page" | "dm-claim";

async function loadPayRows(userId: string, matchId: string) {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: {
        select: {
          name: true,
          orgId: true,
          org: {
            select: {
              id: true,
              name: true,
              language: true,
              stripeConnectAccountId: true,
              stripeChargesEnabled: true,
              payMethodPayByBank: true,
              payMethodCard: true,
              payMethodDirect: true,
              paymentHolderId: true,
            },
          },
        },
      },
    },
  });
  if (!match) return { ok: false as const, reason: "Match not found" };
  if (match.feePerPlayer == null) return { ok: false as const, reason: "No fee set for this match yet" };
  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });
  if (!attendance) return { ok: false as const, reason: "You weren't in this squad" };
  // Money guards, shared by every way a player can start paying
  // (2026-08-31). The pay link is a PERMANENT magic link sent over
  // WhatsApp, so these are the only thing between an old message and a
  // second charge. The pay page's "you're all paid" screen is a display,
  // not a guard. Blocked reasons are human sentences (payment-outcome.ts)
  // that surface as a toast on the pay page.
  const blocked = payBlockedReason({
    paidAt: attendance.paidAt,
    attendanceStatus: attendance.status,
    matchStatus: match.status,
  });
  if (blocked) return { ok: false as const, reason: blocked };
  return { ok: true as const, match, org: match.activity.org, attendance, base: match.feePerPlayer };
}

/**
 * Everything a player needs before they may start paying for a match, or
 * the human sentence saying why they may not. Shared by the card / bank
 * checkout and by settle-directly, so the guards are written once.
 */
export const resolvePayContext = loadPayRows;

export type DirectPendingOutcome =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** The player was ALREADY settling directly before this call, so
       *  the collector was not told again. */
      alreadyPending: boolean;
      /** Base fee times quantity, in pounds. */
      amount: number;
      quantity: number;
      collectorNotified: boolean;
    };

/**
 * Flag this player as paying the collector directly for this match, and
 * tell the collector ONCE so they can confirm when the money lands.
 *
 * `quantity`: how many people the payment covers. The pay page always
 * passes it (the guest stepper). A DM claim passes nothing: it keeps the
 * count already chosen on the pay page if the player is already settling
 * directly, and is otherwise 1. MatchTime never guesses a guest count.
 */
export async function markDirectPaymentPending(input: {
  userId: string;
  matchId: string;
  quantity?: number;
  via: DirectPaymentVia;
}): Promise<DirectPendingOutcome> {
  const { userId, matchId, via } = input;
  const ctx = await resolvePayContext(userId, matchId);
  if (!ctx.ok) return ctx;
  const { match, org, base, attendance } = ctx;
  if (!org.payMethodDirect) return { ok: false, reason: "Direct payment is off" };

  const inheritedQty =
    attendance.paymentMethod === "direct" && attendance.directPendingAt != null
      ? attendance.paymentQuantity
      : 1;
  const qty = Math.max(1, Math.min(10, Math.floor(input.quantity ?? inheritedQty)));
  const amount = base * qty;
  const data = {
    paymentMethod: "direct",
    paymentAmount: amount,
    paymentQuantity: qty,
    directPendingAt: new Date(),
  };

  // Was this player ALREADY in "will pay directly" (unpaid) before this
  // call? If so it is a repeat (a second tap, a second "paid", or a tap
  // then a DM): refresh the state silently and do not re-DM the
  // collector. One nudge per player per match. A fresh selection (no
  // prior pending, or after a card attempt cleared it) still notifies.
  //
  // Decided by the WRITE rather than by the read above, so two requests
  // arriving together cannot both conclude they were first: only one of
  // them can move `directPendingAt` from null. Both writes require the
  // row to be unpaid, so nothing here can touch a payment the collector
  // has already confirmed.
  const fresh = await db.attendance.updateMany({
    where: { matchId, userId, paidAt: null, directPendingAt: null },
    data,
  });
  let alreadyPending = false;
  if (fresh.count === 0) {
    const refreshed = await db.attendance.updateMany({
      where: { matchId, userId, paidAt: null },
      data,
    });
    // Paid between the read and the write (the collector confirmed).
    if (refreshed.count === 0) {
      return { ok: false, reason: ALREADY_PAID_REASON };
    }
    alreadyPending = true;
  }

  let collectorNotified = false;
  if (org.paymentHolderId && !alreadyPending) {
    const me = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
    const holder = await db.user.findUnique({
      where: { id: org.paymentHolderId },
      select: { phoneNumber: true },
    });
    if (holder?.phoneNumber) {
      const { signMagicLinkToken, MAGIC_LINK_TTL } = await import("./magic-link");
      const { buildShortMagicLinkUrl } = await import("./short-link");
      const token = signMagicLinkToken({
        userId: org.paymentHolderId,
        purpose: "sign-in",
        nextPath: `/collect/${matchId}`,
        ttlSeconds: MAGIC_LINK_TTL.actionNudge,
      });
      await db.botJob.create({
        data: {
          orgId: org.id,
          kind: "dm",
          phone: holder.phoneNumber.replace(/^\+/, ""),
          text: buildDirectPayCollectorNotice({
            playerName: me?.name ?? null,
            activityName: match.activity.name,
            amount,
            quantity: qty,
            url: await buildShortMagicLinkUrl(token),
            claimedPaid: via === "dm-claim",
            lang: org.language,
          }),
        },
      });
      collectorNotified = true;
    }
  }
  return { ok: true, alreadyPending, amount, quantity: qty, collectorNotified };
}
