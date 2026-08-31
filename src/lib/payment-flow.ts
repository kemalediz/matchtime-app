/**
 * Payment flow orchestration (2026-06-03) — server-side, no "use server".
 * The bits the bot/webhook call directly (the user-facing server actions
 * live in src/app/actions/payments.ts).
 *
 *   releaseMatchPayments(matchId)  — once the fee is confirmed, DM every
 *     confirmed player a link to /pay/<matchId> and stamp
 *     paymentLinksReleasedAt (gates the chaser).
 *   applyCheckoutEvent(type, session) — webhook handler: applies a
 *     Stripe Checkout event to that player's Attendance. Only a
 *     genuinely-settled payment marks them paid (Pay by Bank settles
 *     asynchronously and can fail after the session completes).
 */

import { db } from "./db";
import { signMagicLinkToken, MAGIC_LINK_TTL } from "./magic-link";
import { buildShortMagicLinkUrl } from "./short-link";
import { gbp, parseFeeReply } from "./payments";
import { decideCheckoutEvent } from "./payment-outcome";
import type Stripe from "stripe";

/** DM each confirmed player (with a phone) a pay link, once. Idempotent
 *  via per-player BotJob dedupe on a stable text marker isn't reliable,
 *  so we gate on paymentLinksReleasedAt: callers set the fee + call this
 *  exactly once. Returns how many links were queued. */
export async function releaseMatchPayments(matchId: string): Promise<number> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: {
        select: { name: true, orgId: true, org: { select: { paymentHolderId: true } } },
      },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { id: true, name: true, phoneNumber: true } } },
      },
    },
  });
  if (!match || match.feePerPlayer == null) return 0;

  const orgId = match.activity.orgId;
  // The money collector doesn't pay themselves — never DM them a pay link.
  const collectorId = match.activity.org.paymentHolderId;
  let queued = 0;
  for (const a of match.attendances) {
    if (a.user.id === collectorId) continue; // collector collects, doesn't pay
    if (!a.user.phoneNumber) continue;
    const token = signMagicLinkToken({
      userId: a.user.id,
      purpose: "sign-in",
      nextPath: `/pay/${matchId}`,
      ttlSeconds: MAGIC_LINK_TTL.bookmark,
    });
    const first = a.user.name?.split(" ")[0] ?? "there";
    await db.botJob.create({
      data: {
        orgId,
        kind: "dm",
        phone: a.user.phoneNumber.replace(/^\+/, ""),
        text:
          `💷 ${first} — match fee for *${match.activity.name}* is *${gbp(match.feePerPlayer)}*.\n\n` +
          `Tap to pay (bank, card, Apple or Google Pay, or pay the organiser directly):\n${await buildShortMagicLinkUrl(token)}\n\n` +
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

/** What `applyCheckoutEvent` did, for logs + tests. */
export type CheckoutApplyResult =
  | { action: "ignored"; reason: string }
  | { action: "marked-paid" }
  | { action: "already-settled" }
  | { action: "awaiting-settlement" }
  | { action: "reversed" }
  | { action: "nothing-to-reverse" };

/**
 * Webhook: apply a Stripe Checkout Session event to the player's
 * attendance. The session carries matchId + userId + quantity in
 * metadata.
 *
 * The decision of WHETHER this event means "paid" is pure and lives in
 * lib/payment-outcome.ts — see the long note there on why
 * `checkout.session.completed` is NOT proof of payment for Pay by Bank.
 *
 * Idempotent + order-independent, because Stripe retries events and can
 * deliver them more than once and out of order:
 *   - marking paid only touches rows that are still unpaid, so a repeat
 *     delivery never re-stamps `paidAt` and never overwrites a payment
 *     the collector already confirmed by hand;
 *   - a reversal only touches a row still carrying THIS session id, so a
 *     stale failure can't un-pay a later, genuine payment.
 */
export async function applyCheckoutEvent(
  eventType: string,
  session: Stripe.Checkout.Session,
): Promise<CheckoutApplyResult> {
  const matchId = session.metadata?.matchId;
  const userId = session.metadata?.userId;
  if (!matchId || !userId) {
    console.warn(`[payments] ${eventType} without matchId/userId metadata`, session.id);
    return { action: "ignored", reason: "no-metadata" };
  }

  const decision = decideCheckoutEvent(eventType, session.payment_status);
  const who = `match ${matchId} user ${userId} session ${session.id}`;

  if (decision === "ignore") return { action: "ignored", reason: eventType };

  if (decision === "reverse-unpaid") {
    // The delayed (bank) debit failed after the fact. Undo the paid mark
    // IF this exact session is the one that set it. No message is sent
    // from here on purpose: the player is now unpaid + not
    // direct-pending, so the existing daily chaser picks them back up
    // (bot-scheduler §pay chase) — no new outbound path, no flood risk.
    const res = await db.attendance.updateMany({
      where: { matchId, userId, stripeSessionId: session.id, paidAt: { not: null } },
      data: { paidAt: null },
    });
    if (res.count > 0) {
      console.warn(`[payments] payment FAILED after completion — un-paid ${who}`);
      return { action: "reversed" };
    }
    console.warn(`[payments] payment failed, nothing to reverse (already unpaid): ${who}`);
    return { action: "nothing-to-reverse" };
  }

  const amount = session.amount_total != null ? session.amount_total / 100 : null;
  const quantity = Number(session.metadata?.quantity ?? "1") || 1;

  if (decision === "await-settlement") {
    // Session finished but the money has NOT landed (Pay by Bank in
    // flight). Record which session we're waiting on so a later
    // async_payment_failed can be attributed to it — but leave paidAt
    // alone: as far as the club is concerned this player still owes.
    await db.attendance.updateMany({
      where: { matchId, userId, paidAt: null },
      data: { stripeSessionId: session.id },
    });
    console.log(
      `[payments] checkout complete but payment_status=${session.payment_status ?? "?"} — NOT marking paid, awaiting settlement: ${who}`,
    );
    return { action: "awaiting-settlement" };
  }

  // decision === "mark-paid"
  const res = await db.attendance.updateMany({
    where: { matchId, userId, paidAt: null },
    data: {
      paidAt: new Date(),
      paymentAmount: amount,
      paymentQuantity: quantity,
      stripeSessionId: session.id,
      directPendingAt: null,
    },
  });
  if (res.count > 0) {
    console.log(`[payments] marked paid: ${who} (£${amount}, x${quantity})`);
    return { action: "marked-paid" };
  }
  // Nothing to update: either a duplicate delivery of this same event, or
  // the row was already settled another way (collector marked it
  // received). Never re-stamp — but shout if a DIFFERENT session paid for
  // an already-paid attendance, which would mean a genuine double charge.
  const existing = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { stripeSessionId: true, paidAt: true },
  });
  if (!existing) {
    console.warn(`[payments] paid event for an attendance that no longer exists: ${who}`);
  } else if (existing.paidAt && existing.stripeSessionId !== session.id) {
    console.warn(
      `[payments] POSSIBLE DOUBLE PAYMENT — ${who} but attendance already settled by ${existing.stripeSessionId ?? "another method"}`,
    );
  }
  return { action: "already-settled" };
}

// ─── Collector chat fee-capture (2026-06-04) ──────────────────────────
//   The money collector (Organisation.paymentHolderId) DMs MatchTime the
//   per-player fee for a just-played match. We echo a confirm step, and
//   on ✅ release the per-player pay links. All gated on
//   paymentCollectionEnabled so non-paying orgs are untouched.

/** Window after a match within which the collector's "how much?" reply is
 *  attributed to it. Long enough to cover "I'll sort it tonight". */
const FEE_CAPTURE_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

/** A short "yes, send them" reply. Emoji are matched directly (a regex
 *  `\b` never matches after a lone emoji, which silently broke "✅"). */
function isAffirmative(text: string): boolean {
  if (/[✅✔👍]/u.test(text)) return true; // ✅ ✔ 👍
  const t = text.trim().toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (!t) return false;
  const AFF = new Set([
    "y", "ye", "yes", "yep", "yeah", "yup", "ya", "ok", "oki", "okay", "k", "kk",
    "confirm", "confirmed", "correct", "send", "send it", "send them", "release",
    "go", "go on", "do it", "sure", "right", "thats right", "that is right",
    "yes please", "ok send", "yes send",
  ]);
  return AFF.has(t) || /^(yes|yeah|yep|yup|ok|okay|confirm|send|correct|sure|go)\b/.test(t);
}

/** A short "no / not yet" reply. */
function isNegative(text: string): boolean {
  if (/[❌✖🚫]/u.test(text)) return true; // ❌ ✖ 🚫
  const t = text.trim().toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (!t) return false;
  const NEG = new Set(["n", "no", "nope", "nah", "cancel", "stop", "wait", "hold", "not yet", "dont", "do not"]);
  return NEG.has(t) || /^(no|nope|nah|cancel|stop|wait|dont|do not)\b/.test(t);
}

/** Does this message look like a fee amount (vs. arbitrary chat that
 *  merely contains a number, e.g. "we had 10 players")? Used to gate the
 *  UNPROMPTED capture so a stray number doesn't become a fee. */
function looksLikeFeeAmount(text: string): boolean {
  const t = text.trim();
  if (/£/.test(t)) return true;
  // Bare amount, optionally with a fee unit.
  if (/^\s*\d+(\.\d{1,2})?\s*(each|pp|per|per person|per head|a head|quid|q|pounds?|total|split)?\s*$/i.test(t)) {
    return true;
  }
  // Number followed (anywhere) by a clear fee unit.
  if (/\d/.test(t) && /\b(each|pp|per person|per head|a head|quid|total|split|altogether)\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Find the single most relevant match for which `userId` (a money
 *  collector) might be setting/confirming a fee: a recently-played match
 *  in a payment-collecting org they collect for, not yet released.
 *  Prefers one already awaiting confirmation. */
async function findCollectorPendingMatch(userId: string) {
  const orgs = await db.organisation.findMany({
    where: { paymentHolderId: userId, paymentCollectionEnabled: true },
    select: { id: true },
  });
  if (orgs.length === 0) return null;
  const orgIds = orgs.map((o) => o.id);

  const match = await db.match.findFirst({
    where: {
      activity: { orgId: { in: orgIds } },
      isHistorical: false,
      status: { not: "CANCELLED" },
      paymentLinksReleasedAt: null,
      date: { gte: new Date(Date.now() - FEE_CAPTURE_WINDOW_MS), lte: new Date() },
      OR: [{ feePendingConfirm: { not: null } }, { feePerPlayer: null }],
    },
    // Prefer a match already awaiting confirmation (feePendingConfirm set);
    // nulls last so an amount-pending match wins over a fee-less one.
    orderBy: [{ feePendingConfirm: { sort: "desc", nulls: "last" } }, { date: "desc" }],
    include: { activity: { select: { name: true } } },
  });
  return match;
}

export interface CollectorReplyResult {
  /** Text MatchTime should DM back to the collector. */
  reply: string;
  /** Number of pay links released (set when the fee was just confirmed). */
  released?: number;
}

/**
 * Handle a DM from a money collector that may be setting or confirming a
 * per-match fee. Returns null when the message isn't a fee
 * interaction (caller then falls through to survey / Q&A handling).
 */
export async function handleCollectorFeeReply(
  userId: string,
  text: string,
): Promise<CollectorReplyResult | null> {
  const match = await findCollectorPendingMatch(userId);
  if (!match) return null;

  // Players to charge = confirmed squad MINUS the collector themselves
  // (userId is the collector — findCollectorPendingMatch matched on
  // paymentHolderId === userId). They collect the pot, they don't pay it,
  // so they're excluded from both the "N to charge" count and any
  // "£X total to split" division. Matches releaseMatchPayments, which
  // skips the collector when sending links.
  const headcount = await db.attendance.count({
    where: { matchId: match.id, status: "CONFIRMED", userId: { not: userId } },
  });

  // ── Awaiting confirmation of a previously-proposed amount ──
  if (match.feePendingConfirm != null) {
    if (isAffirmative(text)) {
      const amount = match.feePendingConfirm;
      await db.match.update({
        where: { id: match.id },
        data: {
          feePerPlayer: amount,
          feePendingConfirm: null,
          feeSetByUserId: userId,
          feeSetAt: new Date(),
        },
      });
      const released = await releaseMatchPayments(match.id);
      return {
        released,
        reply:
          `✅ Done — sent ${released} pay link${released === 1 ? "" : "s"} at *${gbp(amount)}* each for *${match.activity.name}*. ` +
          `Players can pay by bank, card, Apple or Google Pay, or settle with you directly. I'll chase anyone who hasn't paid.`,
      };
    }
    if (isNegative(text)) {
      await db.match.update({
        where: { id: match.id },
        data: { feePendingConfirm: null },
      });
      return { reply: `No problem — cancelled. Just tell me the amount per player when you're ready.` };
    }
    // A fresh amount supersedes the pending one.
    if (looksLikeFeeAmount(text)) {
      const parsed = parseFeeReply(text, headcount);
      if (parsed) {
        await db.match.update({
          where: { id: match.id },
          data: { feePendingConfirm: parsed.perPlayer },
        });
        return { reply: confirmPrompt(parsed.perPlayer, headcount, match.activity.name, parsed.wasTotal) };
      }
    }
    return null; // unrelated chatter while awaiting confirm → let it fall through
  }

  // ── No fee set yet: capture an amount if the message looks like one ──
  if (!looksLikeFeeAmount(text)) return null;
  const parsed = parseFeeReply(text, headcount);
  if (!parsed) return null;
  await db.match.update({
    where: { id: match.id },
    data: { feePendingConfirm: parsed.perPlayer, feeSetByUserId: userId },
  });
  return { reply: confirmPrompt(parsed.perPlayer, headcount, match.activity.name, parsed.wasTotal) };
}

function confirmPrompt(perPlayer: number, headcount: number, matchName: string, wasTotal: boolean): string {
  const split = wasTotal ? ` (split across ${headcount} player${headcount === 1 ? "" : "s"})` : "";
  return (
    `Got it — *${gbp(perPlayer)}* per player${split} for *${matchName}*` +
    (headcount > 0 ? `, ${headcount} player${headcount === 1 ? "" : "s"} to charge` : "") +
    `.\n\nReply *✅* (or "yes") to send everyone their pay link, or send a different amount to change it.`
  );
}
