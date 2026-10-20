/**
 * A PLAYER DMs MatchTime "PAID" (2026-09-23).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE GAP
 * ═══════════════════════════════════════════════════════════════════════
 *
 * After each match every player gets a pay link naming the ways the
 * club takes payment (`availablePayMethods`). The pay page's "Pay the
 * collector directly" button does the right thing. But the less
 * technical half of a club skips the link and just DMs the bot "Paid",
 * and nothing read that. Abid Kazmi's "Paid" at 18:09 on 2026-09-23 was
 * lost.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT HAPPENS NOW (the design Kemal approved on 2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * A claim does EXACTLY what the button does: it calls
 * `markDirectPaymentPending` (lib/direct-payment.ts), the one shared
 * implementation. Same pending state, same DM to the collector with a
 * link to confirm, same "don't tell the collector twice". Then the player
 * is thanked, in the org's language, with the collector's real name.
 *
 * IT NEVER MARKS ANYBODY PAID. MatchTime cannot see money arrive. Only
 * the collector's confirmation sets `paidAt`
 * (`__tests__/paid-claim-never-sets-paid-at.test.ts`).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE SPLIT IS `dm-intent.ts`'s: THE MODEL READS, THE CODE DECIDES
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   1. DOES THIS PLAYER OWE ANYTHING? One indexed query, BEFORE the model.
 *      A match with a fee, pay links released, the player CONFIRMED on
 *      it and unpaid, in an org that collects payments and allows direct
 *      payment, and the sender not that org's collector. No → the model
 *      is never asked and the DM falls through untouched.
 *   2. IS THIS A CLAIM? One model call on a closed enum, failing closed to
 *      `other`, with a confidence floor. Players write "Paid", "sent it",
 *      "done 👍", "ödedim", "gönderdim abi": no keyword list covers that
 *      without also matching "I'll pay later" or "haven't paid yet".
 *   3. THE WRITE, THE REPLY. Code, from what actually happened.
 *
 * WHY THE FLOOR CAN SIT WHERE IT DOES. A wrong "paid" costs a PENDING
 * state the collector still has to confirm (and it pauses that player's
 * daily pay chase in favour of the collector's daily "tick off the
 * direct payers" nudge); nothing is marked paid and no money moves. A
 * wrong "other" costs one lost message, which is what happens today. So
 * the floor is the same 0.8 the other DM classifiers use, and the prompt
 * tells the model "when in doubt, other".
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DECISIONS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WHICH MATCH. The most recent match still owed, pending or not. The
 * pay link and the daily chase a player is replying to are about the
 * latest match, and old unpaid rows accumulate (the chase stops after six
 * days; some players settled in cash and were never ticked off), so the
 * OLDEST unpaid row is the likeliest to be stale. Asking "which match?"
 * would add a conversation state for a case the reply already covers:
 * it names the match and the amount, and the collector's notice names
 * them too, so a wrong guess is visible to both before anyone confirms.
 * Pending rows are included so a second "paid" lands on the same match
 * (and is suppressed) instead of hopping to an older one.
 *
 * NOT A CLAIM ("I'll pay later", "haven't paid yet", "how much do I
 * owe?", "did you get my payment?", "paid last week"): `other`, nothing
 * written, and the DM falls through to the handlers below, so a question
 * still reaches DM Q&A.
 *
 * NOTHING OWED (already paid, no fee set yet, not in the squad, the
 * sender is the collector, the org does not collect or has direct payment
 * switched off): step 1 finds nothing, the model is never asked and the
 * DM falls through as before. No reply from this handler: a "you don't
 * owe anything" to someone who paid by card an hour ago says nothing
 * useful, and to someone whose fee is not set yet it would be wrong.
 *
 * ALREADY PENDING: `markDirectPaymentPending` refreshes the state and does
 * not re-DM the collector (the button's repeat suppression); the player
 * gets a short "already done" reply. A REPLAY of the very same WhatsApp
 * message (the bot's recovery walk re-forwards recent DMs) is silent:
 * `SentNotification` key `paid-claim:<waMessageId>`.
 *
 * THE ✅ (2026-10-16). Every RECORDED claim, the "already done" repeat
 * included, also queues a ✅ reaction on the player's DM through the
 * existing retro-reaction queue (`paid-claim-reaction.ts`). A replay, a
 * blocked claim and "paid for my mate" get none. A failure to queue it is
 * logged and nothing is said.
 *
 * "I'LL PAY RAIHAN DIRECTLY" (Kemal, 2026-10-18): its own intent,
 * `will_pay_direct`, and EXACTLY the pay page's "Pay the collector
 * directly" button: `markDirectPaymentPending` with `via: "dm-will-pay"`,
 * so the same pending state (the daily pay chase skips it), the
 * collector's notice in its "says they'll pay you directly" form, and a
 * "you'll pay them" ack. A plan that does not choose the collector ("I'll
 * pay later") stays `other`: the pay link is still the way.
 *
 * THE MODEL IS TOLD WHO THE COLLECTOR IS (Feroz, FNF 2026-10-18), and
 * every verdict is logged, `other` included: "I bank transferred Raihan"
 * was read as paying some other person and left no trace.
 *
 * PAYING FOR SOMEONE ELSE ("paid for me and my mate"): its own intent,
 * `paid_for_others`. Nothing is written, because MatchTime does not
 * guess how many people a payment covered. The player is sent their pay
 * link and told to set the guest count and choose "Pay the collector
 * directly", which is the button path with the right quantity.
 */
import { db } from "./db";
import { REPLY_PRIORITY } from "./dm-reply-priority";
import { normaliseLang, type Lang } from "./i18n/lang";
import { buildPaidClaimAck, buildPaidForOthersReply } from "./dm-copy";
import { markDirectPaymentPending, type DirectPaymentVia, type DirectPendingOutcome } from "./direct-payment";
import { gbp } from "./payments";
import { withOrgAiBudget } from "./ai-budget";
import {
  classifyPaymentClaimDetailed,
  type PaymentClaimClassification,
  type PaymentClaimContext,
  type PaymentClaimIntent,
} from "./payment-claim-classifier";
import { queuePaidClaimReaction } from "./paid-claim-reaction";
import { loadDmReplyContext, type QuotedBotMessage, type ReplyContext } from "./reply-context";

export {
  PAYMENT_CLAIM_MIN_CONFIDENCE,
  PAYMENT_CLAIM_STUB_FILE_ENV,
  buildPaymentClaimSystemPrompt,
  buildPaymentClaimUserTurn,
  classifyPaymentClaim,
  classifyPaymentClaimDetailed,
  parsePaymentClaim,
  paymentClaimBodyOf,
  type PaymentClaimCall,
  type PaymentClaimClassification,
  type PaymentClaimContext,
  type PaymentClaimIntent,
} from "./payment-claim-classifier";

// ── WHICH MATCH ──────────────────────────────────────────────────────

/** One match this player is CONFIRMED on and has not paid for, already
 *  filtered by the query to a released fee in an org that collects and
 *  allows direct payment. */
export interface OwedMatchRow {
  matchId: string;
  date: Date;
  fee: number;
  activityName: string;
  orgId: string;
  lang: Lang;
  collectorId: string | null;
  collectorName: string | null;
}

export interface OwedMatch {
  matchId: string;
  orgId: string;
  activityName: string;
  fee: number;
  lang: Lang;
  collectorName: string | null;
}

/** The most recent match still owed; the collector never owes their own
 *  org. See "WHICH MATCH" at the top of this file. */
export function pickClaimMatch(rows: OwedMatchRow[], userId: string): OwedMatch | null {
  const owed = rows
    .filter((r) => r.collectorId !== userId)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  const r = owed[0];
  if (!r) return null;
  return {
    matchId: r.matchId,
    orgId: r.orgId,
    activityName: r.activityName,
    fee: r.fee,
    lang: r.lang,
    collectorName: r.collectorName,
  };
}

// ── THE ORCHESTRATION, WITH EVERY PIECE OF I/O INJECTED ─────────────

// ── WHAT THE MODEL IS TOLD ───────────────────────────────────────────

/** The classifier's context for an owed match. The collector's name is
 *  load-bearing: without it "I bank transferred Raihan" reads as paying
 *  some other person (Feroz, FNF 2026-10-18). */
export function paymentClaimContext(
  owed: OwedMatch,
  playerName: string | null,
  replyContext: ReplyContext,
): PaymentClaimContext {
  return {
    playerName,
    owes: `${gbp(owed.fee)} for ${owed.activityName}`,
    collectorName: owed.collectorName,
    replyContext,
  };
}

export interface PaymentClaimDeps {
  /** The sender, for the verdict log. */
  userId: string;
  /** The sender's name, for the reply's greeting. */
  playerName: string | null;
  /** The match this player owes for, or null. Checked BEFORE the model. */
  owedMatch: () => Promise<OwedMatch | null>;
  /** The model's read, with its confidence and reasoning (logged). A throw
   *  is `other`. */
  classify: (owed: OwedMatch) => Promise<PaymentClaimClassification>;
  /** Records this WhatsApp message as handled. False when it already was
   *  (a replay of the same message), in which case nothing else runs. */
  firstSighting: (matchId: string) => Promise<boolean>;
  /** THE WRITE: `markDirectPaymentPending`, the settle-directly button's
   *  own implementation. Never sets paidAt. `via` picks the collector's
   *  wording: "dm-claim" ("says they've paid you") or "dm-will-pay"
   *  ("says they'll pay you", the button's own). */
  markPending: (matchId: string, via: DirectPaymentVia) => Promise<DirectPendingOutcome>;
  /** The player's pay link for this match. Sends nothing. */
  payLink: (matchId: string) => Promise<string>;
  /** The ONE private reply, to the player. */
  reply: (args: { orgId: string; text: string }) => Promise<void>;
  /** Queue a ✅ on the player's own DM (`paid-claim-reaction.ts`). Runs
   *  only for a RECORDED claim, the "already done" repeat included. True
   *  when a reaction is (or already was) queued. A throw is logged and
   *  changes nothing else: the claim and the reply already happened. */
  react: (orgId: string) => Promise<boolean>;
}

export type PaymentClaimResult =
  | {
      /** "will-pay-direct": the player said they WILL pay the collector
       *  directly, the button said in words (Kemal, 2026-10-18). */
      handled: "paid-claim" | "will-pay-direct";
      matchId: string;
      alreadyPending: boolean;
      collectorNotified: boolean;
      reactionQueued: boolean;
    }
  | { handled: "paid-claim-for-others"; matchId: string }
  | { handled: "paid-claim-replay" }
  | { handled: "paid-claim-blocked"; reason: string }
  | { handled: null };

const NOT_HANDLED: PaymentClaimResult = { handled: null };

/**
 * The player-claim path, as a pure function of its callbacks. A
 * `handled: null` means "not a claim" and the route falls through to the
 * handlers below it, exactly as before this existed.
 */
export async function runPaymentClaim(deps: PaymentClaimDeps): Promise<PaymentClaimResult> {
  const owed = await deps.owedMatch();
  if (!owed) return NOT_HANDLED;

  let verdict: PaymentClaimClassification;
  try {
    verdict = await deps.classify(owed);
  } catch (err) {
    console.error("[payment-claim] classification threw; treating the DM as `other`:", err);
    return NOT_HANDLED;
  }
  // EVERY verdict, `other` included: Feroz's "I bank transferred Raihan"
  // was read as `other` and left no trace at all (FNF 2026-10-18).
  console.info(
    `[payment-claim] verdict user=${deps.userId} match=${owed.matchId} intent=${verdict.intent} ` +
      `confidence=${verdict.confidence.toFixed(2)} reasoning=${JSON.stringify(verdict.reasoning.slice(0, 120))}`,
  );
  const intent: PaymentClaimIntent = verdict.intent;
  if (intent === "other") return NOT_HANDLED;

  if (!(await deps.firstSighting(owed.matchId))) return { handled: "paid-claim-replay" };

  if (intent === "paid_for_others") {
    // Nothing is written: MatchTime does not guess a guest count.
    const url = await deps.payLink(owed.matchId);
    await deps.reply({
      orgId: owed.orgId,
      text: buildPaidForOthersReply({
        playerName: deps.playerName,
        collectorName: owed.collectorName,
        url,
        lang: owed.lang,
      }),
    });
    return { handled: "paid-claim-for-others", matchId: owed.matchId };
  }

  const willPay = intent === "will_pay_direct";
  const marked = await deps.markPending(owed.matchId, willPay ? "dm-will-pay" : "dm-claim");
  if (!marked.ok) {
    // Paid or blocked between the gate and the write. Silent, and handled:
    // falling through would hand "Paid" to a tentative follow-up or a
    // roster survey that would answer it with a clarification.
    console.warn(`[payment-claim] claim not recorded for match ${owed.matchId}: ${marked.reason}`);
    return { handled: "paid-claim-blocked", reason: marked.reason };
  }
  await deps.reply({
    orgId: owed.orgId,
    text: buildPaidClaimAck({
      playerName: deps.playerName,
      collectorName: owed.collectorName,
      amount: marked.amount,
      activityName: owed.activityName,
      alreadyPending: marked.alreadyPending,
      willPay,
      lang: owed.lang,
    }),
  });
  let reactionQueued = false;
  try {
    reactionQueued = await deps.react(owed.orgId);
  } catch (err) {
    // Silent to the player, by rule: a missing ✅ is logged, never said.
    console.error(`[payment-claim] could not queue the ✅ for match ${owed.matchId}:`, err);
  }
  return {
    handled: willPay ? "will-pay-direct" : "paid-claim",
    matchId: owed.matchId,
    alreadyPending: marked.alreadyPending,
    collectorNotified: marked.collectorNotified,
    reactionQueued,
  };
}

// ── THE DATABASE WIRING ──────────────────────────────────────────────

/**
 * `runPaymentClaim` against the real database, for the dm-reply route.
 * `replyPhone` is where the player's reply goes (digits, no "+"); null
 * means we cannot reply, and then nothing is recorded either, because a
 * claim nobody is told about is worse than one that is not picked up.
 */
export async function handlePaymentClaimDm(input: {
  userId: string;
  userName: string | null;
  text: string;
  waMessageId: string;
  replyPhone: string | null;
  /** The MatchTime message this DM swipe-replies to, as the route resolved
   *  it once (`resolveQuotedBotMessage`), or null. */
  quoted?: QuotedBotMessage | null;
}): Promise<PaymentClaimResult> {
  const { userId, text, waMessageId, replyPhone } = input;
  if (!replyPhone) return NOT_HANDLED;

  return runPaymentClaim({
    userId,
    playerName: input.userName,
    owedMatch: async () => {
      const rows = await db.attendance.findMany({
        where: {
          userId,
          paidAt: null,
          // A free place owes nothing (fee-waiver.ts): a "Paid" DM is about
          // a match he DOES owe, never the free one (review of #301).
          feeWaivedAt: null,
          // Pay links go to the CONFIRMED squad only (releaseMatchPayments).
          status: "CONFIRMED",
          // Monthly squad (slice 5): a regular's row is paid for by the
          // month and owes nothing per match. No weekly club has one.
          OR: [{ paymentMethod: null }, { paymentMethod: { not: "monthly" } }],
          match: {
            isHistorical: false,
            status: { not: "CANCELLED" },
            feePerPlayer: { not: null },
            paymentLinksReleasedAt: { not: null },
            activity: { org: { paymentCollectionEnabled: true, payMethodDirect: true } },
          },
        },
        select: {
          directPendingAt: true,
          match: {
            select: {
              id: true,
              date: true,
              feePerPlayer: true,
              activity: {
                select: { name: true, org: { select: { id: true, language: true, paymentHolderId: true } } },
              },
            },
          },
        },
        orderBy: { match: { date: "desc" } },
        take: 5,
      });
      if (!rows || rows.length === 0) return null;
      const picked = pickClaimMatch(
        rows.map((r) => ({
          matchId: r.match.id,
          date: r.match.date,
          fee: r.match.feePerPlayer ?? 0,
          activityName: r.match.activity.name,
          orgId: r.match.activity.org.id,
          lang: normaliseLang(r.match.activity.org.language),
          collectorId: r.match.activity.org.paymentHolderId,
          collectorName: null,
        })),
        userId,
      );
      if (!picked) return null;
      const collectorId = rows.find((r) => r.match.id === picked.matchId)?.match.activity.org.paymentHolderId;
      if (collectorId) {
        const c = await db.user.findUnique({ where: { id: collectorId }, select: { name: true } });
        picked.collectorName = c?.name ?? null;
      }
      return picked;
    },
    classify: async (owed) => {
      const replyContext = await loadDmReplyContext(db, { userId, phone: replyPhone, quoted: input.quoted ?? null });
      // Spent from the club the player owes (the daily AI cap).
      return withOrgAiBudget(owed.orgId, () =>
        classifyPaymentClaimDetailed(text, paymentClaimContext(owed, input.userName, replyContext)),
      );
    },
    firstSighting: async (matchId) => {
      try {
        await db.sentNotification.create({
          data: { key: `paid-claim:${waMessageId}`, kind: "paid-claim", matchId, targetUser: userId },
        });
        return true;
      } catch (err) {
        // The unique key already exists: this exact message was handled.
        if ((err as { code?: string }).code === "P2002") return false;
        throw err;
      }
    },
    markPending: (matchId, via) => markDirectPaymentPending({ userId, matchId, via }),
    payLink: async (matchId) => {
      const { signMagicLinkToken, MAGIC_LINK_TTL } = await import("./magic-link");
      const { buildShortMagicLinkUrl } = await import("./short-link");
      return buildShortMagicLinkUrl(
        signMagicLinkToken({ userId, purpose: "sign-in", nextPath: `/pay/${matchId}`, ttlSeconds: MAGIC_LINK_TTL.bookmark }),
      );
    },
    reply: async ({ orgId, text: replyText }) => {
      await db.botJob.create({ data: { orgId, kind: "dm", phone: replyPhone, text: replyText, ...REPLY_PRIORITY } });
    },
    react: async (orgId) => {
      const outcome = await queuePaidClaimReaction(db, { orgId, waMessageId, reason: "paid claim" });
      if (outcome === "no-real-id") {
        console.warn(`[payment-claim] no ✅: ${waMessageId} is not a real WhatsApp id`);
      }
      return outcome !== "no-real-id";
    },
  });
}
