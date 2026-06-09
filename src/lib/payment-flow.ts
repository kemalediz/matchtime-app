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
import { signMagicLinkToken, MAGIC_LINK_TTL } from "./magic-link";
import { buildShortMagicLinkUrl } from "./short-link";
import { gbp, parseFeeReply } from "./payments";
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
          `Tap to pay (card / Apple Pay, or pay the organiser directly):\n${await buildShortMagicLinkUrl(token)}\n\n` +
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

  const headcount = await db.attendance.count({
    where: { matchId: match.id, status: "CONFIRMED" },
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
          `Players can pay by card / Apple Pay, or settle with you directly. I'll chase anyone who hasn't paid.`,
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
