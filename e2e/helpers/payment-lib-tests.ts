/**
 * MONEY-PATH semantics against a real database — run under tsx (they
 * import src libs that pull in the Prisma 7 generated client, which
 * Playwright's transpiler can't load). Invoked by
 * e2e/api/payment-webhook.spec.ts via execFile; exits non-zero with a
 * readable diff on any failure.
 *
 * What is proven here (each of these, wrong, costs a real club money):
 *   1. A Pay-by-Bank checkout that COMPLETES but has not settled must not
 *      mark the player paid, and if it later FAILS they must still be
 *      unpaid.
 *   2. A late failure reverses a paid mark — but only for the session
 *      that set it.
 *   3. Duplicate + out-of-order deliveries are no-ops (Stripe retries).
 *   4. The card happy path still marks paid (no regression).
 *   5. Only the org's money collector can set a match fee.
 *
 * The Stripe API is NEVER called: sessions are plain objects, exactly as
 * they arrive in a webhook payload.
 *
 * Requires the fixture world to be seeded (the spec reseeds first) and
 * MT_E2E_DATABASE_URL to point at the embedded test DB.
 */
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";
import { U, MATCH } from "./constants";

/** A Checkout Session as the webhook receives it. */
function session(over: {
  id: string;
  payment_status: string;
  userId: string;
  matchId?: string;
  amount_total?: number;
  quantity?: string;
}): Stripe.Checkout.Session {
  return {
    id: over.id,
    object: "checkout.session",
    payment_status: over.payment_status,
    amount_total: over.amount_total ?? 833,
    metadata: {
      matchId: over.matchId ?? MATCH.pay,
      userId: over.userId,
      quantity: over.quantity ?? "1",
    },
  } as unknown as Stripe.Checkout.Session;
}

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  // The libs read DATABASE_URL via src/lib/db — pin it to the test DB
  // BEFORE the first import.
  process.env.DATABASE_URL = url;

  const { applyCheckoutEvent, handleCollectorFeeReply } = await import("@/lib/payment-flow");
  const { db } = await import("@/lib/db");

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };
  const attendance = (userId: string, matchId = MATCH.pay) =>
    db.attendance.findUnique({
      where: { matchId_userId: { matchId, userId } },
      select: { paidAt: true, stripeSessionId: true, paymentAmount: true, paymentQuantity: true },
    });

  // ── 1. Pay by Bank: completed ≠ paid ───────────────────────────────
  {
    const res = await applyCheckoutEvent(
      "checkout.session.completed",
      session({ id: "cs_bank_1", payment_status: "unpaid", userId: U.player }),
    );
    assert.equal(res.action, "awaiting-settlement");
    const a = await attendance(U.player);
    assert.equal(a?.paidAt, null, "an unsettled bank debit must NOT mark the player paid");
    assert.equal(a?.stripeSessionId, "cs_bank_1", "the pending session is recorded for later");
    ok("pay-by-bank completed+unpaid → awaiting settlement, still unpaid");
  }

  // ── 2. …and when the debit later FAILS they stay unpaid ────────────
  {
    const res = await applyCheckoutEvent(
      "checkout.session.async_payment_failed",
      session({ id: "cs_bank_1", payment_status: "unpaid", userId: U.player }),
    );
    assert.equal(res.action, "nothing-to-reverse");
    const a = await attendance(U.player);
    assert.equal(a?.paidAt, null, "a FAILED bank payment must never read as paid");
    ok("pay-by-bank async_payment_failed → player still unpaid");
  }

  // ── 3. The async SUCCESS event is what settles a bank payment ──────
  let paidAtFirst: Date | null = null;
  {
    const res = await applyCheckoutEvent(
      "checkout.session.async_payment_succeeded",
      session({ id: "cs_bank_1", payment_status: "paid", userId: U.player }),
    );
    assert.equal(res.action, "marked-paid");
    const a = await attendance(U.player);
    assert.ok(a?.paidAt, "a settled bank payment marks the player paid");
    assert.equal(a?.paymentAmount, 8.33);
    paidAtFirst = a!.paidAt;
    ok("pay-by-bank async_payment_succeeded → marked paid");
  }

  // ── 4. Duplicate delivery is a no-op (Stripe retries events) ───────
  {
    const res = await applyCheckoutEvent(
      "checkout.session.async_payment_succeeded",
      session({ id: "cs_bank_1", payment_status: "paid", userId: U.player }),
    );
    assert.equal(res.action, "already-settled");
    const a = await attendance(U.player);
    assert.equal(a?.paidAt?.getTime(), paidAtFirst?.getTime(), "paidAt is not re-stamped");
    ok("duplicate paid event → no-op, paidAt untouched");
  }

  // ── 5. Out-of-order: a late `completed` (unpaid) cannot un-pay ─────
  {
    const res = await applyCheckoutEvent(
      "checkout.session.completed",
      session({ id: "cs_bank_1", payment_status: "unpaid", userId: U.player }),
    );
    assert.equal(res.action, "awaiting-settlement");
    const a = await attendance(U.player);
    assert.equal(a?.paidAt?.getTime(), paidAtFirst?.getTime(), "a settled player stays settled");
    ok("late out-of-order completed(unpaid) → paid player unaffected");
  }

  // ── 6. A failure for a DIFFERENT session cannot un-pay ─────────────
  {
    const res = await applyCheckoutEvent(
      "checkout.session.async_payment_failed",
      session({ id: "cs_someone_else", payment_status: "unpaid", userId: U.player }),
    );
    assert.equal(res.action, "nothing-to-reverse");
    const a = await attendance(U.player);
    assert.ok(a?.paidAt, "another session's failure must not touch this payment");
    ok("failure for a different session → paid player unaffected");
  }

  // ── 7. A genuine late failure DOES reverse the paid mark ───────────
  {
    const res = await applyCheckoutEvent(
      "checkout.session.async_payment_failed",
      session({ id: "cs_bank_1", payment_status: "unpaid", userId: U.player }),
    );
    assert.equal(res.action, "reversed");
    const a = await attendance(U.player);
    assert.equal(a?.paidAt, null, "a payment that failed after settling is un-paid again");
    ok("late async_payment_failed for THIS session → paid mark reversed");
  }

  // ── 8. Card happy path unchanged ───────────────────────────────────
  {
    const res = await applyCheckoutEvent(
      "checkout.session.completed",
      session({ id: "cs_card_1", payment_status: "paid", userId: U.fresh, amount_total: 841 }),
    );
    assert.equal(res.action, "marked-paid");
    const a = await attendance(U.fresh);
    assert.ok(a?.paidAt, "card checkout still marks paid on completion");
    assert.equal(a?.stripeSessionId, "cs_card_1");
    ok("card completed+paid → marked paid (happy path intact)");
  }

  // ── 9. Missing metadata is ignored, not guessed at ─────────────────
  {
    const bare = { id: "cs_nometa", object: "checkout.session", payment_status: "paid" };
    const res = await applyCheckoutEvent(
      "checkout.session.completed",
      bare as unknown as Stripe.Checkout.Session,
    );
    assert.equal(res.action, "ignored");
    ok("session without matchId/userId metadata → ignored");
  }

  // ── 10. Only the money collector can set a fee ─────────────────────
  {
    const notCollector = await handleCollectorFeeReply(U.player, "£50 each");
    assert.equal(notCollector, null, "a non-collector's amount is not a fee instruction");
    const m = await db.match.findUnique({
      where: { id: MATCH.rate },
      select: { feePendingConfirm: true, feePerPlayer: true },
    });
    assert.equal(m?.feePendingConfirm, null, "no fee was staged");
    assert.equal(m?.feePerPlayer, null, "no fee was set");
    ok("non-collector cannot set a match fee");
  }

  // ── 11. …and the collector still can (happy path intact) ───────────
  {
    const asCollector = await handleCollectorFeeReply(U.collector, "£7 each");
    assert.ok(asCollector, "the collector's amount is captured");
    assert.match(asCollector!.reply, /£7/);
    const m = await db.match.findUnique({
      where: { id: MATCH.rate },
      select: { feePendingConfirm: true },
    });
    assert.equal(m?.feePendingConfirm, 7, "the amount is staged for confirmation");
    ok("collector CAN set a match fee (happy path intact)");
  }

  // Leave the fixture world as we found it — later specs assume the seed.
  await db.match.update({
    where: { id: MATCH.rate },
    data: { feePendingConfirm: null, feeSetByUserId: null },
  });
  await db.attendance.updateMany({
    where: { matchId: MATCH.pay, userId: { in: [U.player, U.fresh] } },
    data: { paidAt: null, stripeSessionId: null, paymentAmount: null, paymentQuantity: 1 },
  });

  console.log(`OK ${n} money-path assertions`);
  process.exit(0);
}

main().catch((err) => {
  console.error("PAYMENT-LIB-TESTS FAILED:", err);
  process.exit(1);
});
