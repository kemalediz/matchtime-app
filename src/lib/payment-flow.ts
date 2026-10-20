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
import { buildPayLinkUrl } from "./pay-link";
import { PAY_METHOD_SELECT, availablePayMethods, directPayInstructions, gbp, parseFeeReply, type PayMethod } from "./payments";
import { payCollectorName } from "./direct-payment";
import { sendAdminNotice } from "./admin-channel";
import { t } from "./i18n/t";
import { dayLabel } from "./i18n/dates";
import {
  buildFeeCancelledAck,
  buildFeeConfirmPrompt,
  buildFeeReleasedAck,
  buildPayLinkDm,
} from "./dm-copy";
import { decideCheckoutEvent } from "./payment-outcome";
import { anchoredFeeReply, classifyFeeReply, type FeeReply } from "./fee-confirm";
import { contextMatchLabel, loadDmReplyContext, quoteForMatch, type QuotedBotMessage } from "./reply-context";
import { normaliseLang, type Lang } from "./i18n/lang";
import { withOrgAiBudget } from "./ai-budget";
import { MONTHLY_PAYMENT_METHOD, isMonthlyRow, recordPaygFeeDeclined, stagePaygFeeForReply } from "./monthly-week";
import { isFeeWaived } from "./fee-waiver-rules";
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
        select: {
          name: true,
          orgId: true,
          // `language`: the pay links are written in the match's org language.
          // The pay-method switches and the Stripe account: the link names
          // only the ways `availablePayMethods` allows (FNF, 2026-10-16).
          // `paymentInstructions`: the club's own words on paying the
          // collector directly, one line when direct is offered (2026-10-16);
          // `squadMode`: a monthly club's PAYG link stays as it was.
          org: {
            select: { paymentHolderId: true, language: true, paymentInstructions: true, squadMode: true, ...PAY_METHOD_SELECT },
          },
        },
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
  const methods = availablePayMethods(match.activity.org);
  const instructions = directPayInstructions(match.activity.org);
  // The collector's name, from the squad when they played, else looked
  // up. A failed lookup only costs the name ("the organiser"), never the
  // pay links.
  const collectorName =
    match.attendances.find((a) => a.user.id === collectorId)?.user.name?.trim() ||
    (await payCollectorName(collectorId).catch(() => null));
  let queued = 0;
  for (const a of match.attendances) {
    if (a.user.id === collectorId) continue; // collector collects, doesn't pay
    // Monthly squad (slice 5, plan 5.6): a regular's place is paid for by
    // the month, so they never get a per-match pay link. No club on
    // "weekly" has such a row.
    if (isMonthlyRow(a)) continue;
    // Already settled before the links went out: an organiser or the
    // collector marked them paid on /collect/<match> ("Mark received",
    // the FNF stopgap of #299). No pay link; the chase skips paidAt too.
    if (a.paidAt) continue;
    // A free place (fee-waiver.ts): they owe nothing, whenever the fee is
    // set. The chase and the fee headcount skip it on the same column.
    if (isFeeWaived(a)) continue;
    if (!a.user.phoneNumber) continue;
    await db.botJob.create({
      data: {
        orgId,
        kind: "dm",
        phone: a.user.phoneNumber.replace(/^\+/, ""),
        text: buildPayLinkDm({
          playerName: a.user.name,
          activityName: match.activity.name,
          fee: match.feePerPlayer,
          url: await buildPayLinkUrl(a.user.id, matchId),
          methods,
          collectorName,
          instructions,
          lang: match.activity.org.language,
        }),
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
    await noticePaidWhileFree(matchId, userId, amount).catch((err) =>
      console.error(`[payments] paid-while-free notice failed: ${who}`, err instanceof Error ? err.message : "failed"),
    );
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

/**
 * Money arrived for a player on a free place (review of #301, item 6): a
 * checkout started before the free place was given settled after it. The
 * row is paid (money moved, paid wins); the organisers are told once, in
 * their admin channel, so the collector can refund it if they want.
 * MatchTime never refunds by itself. Only called on the write that marked
 * the row paid, so a repeat delivery says nothing again.
 */
async function noticePaidWhileFree(matchId: string, userId: string, amount: number | null): Promise<void> {
  const row = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { feeWaivedAt: true },
  });
  if (!row || !isFeeWaived(row)) return;
  const [match, user] = await Promise.all([
    db.match.findUnique({
      where: { id: matchId },
      select: { date: true, activity: { select: { orgId: true, org: { select: { language: true } } } } },
    }),
    db.user.findUnique({ where: { id: userId }, select: { name: true } }),
  ]);
  if (!match) return;
  const lang = match.activity.org.language;
  console.warn(`[payments] money arrived for a free place: match ${matchId} user ${userId}`);
  await sendAdminNotice({
    orgId: match.activity.orgId,
    text: t(lang).admin_fee_paid_while_free({
      name: user?.name ?? "A player",
      amount: amount != null ? gbp(amount) : "",
      day: dayLabel(lang, match.date),
    }),
  });
}

// ─── Collector chat fee-capture (2026-06-04) ──────────────────────────
//   The money collector (Organisation.paymentHolderId) DMs MatchTime the
//   per-player fee for a just-played match. We echo a confirm step, and
//   on ✅ release the per-player pay links. All gated on
//   paymentCollectionEnabled so non-paying orgs are untouched.

/** Window after a match within which the collector's "how much?" reply is
 *  attributed to it. Long enough to cover "I'll sort it tonight". */
const FEE_CAPTURE_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

/** Turkish fee units: "kişi başı" (per head), "toplam" (total),
 *  "bölüş..." (split), "sterlin" / "pound" (the currency). */
const TR_FEE_UNIT =
  /(?<!\p{L})(?:ki[şs]i\s+ba[şs][ıi](?:na)?|adam\s+ba[şs][ıi]|toplam|b[öo]l[üu][şs]\p{L}*|sterlin|pound|paund)(?!\p{L})/u;

/** Does this message look like a fee amount (vs. arbitrary chat that
 *  merely contains a number, e.g. "we had 10 players")? Used to gate the
 *  UNPROMPTED capture so a stray number doesn't become a fee. */
function looksLikeFeeAmount(text: string, lang: Lang = "en"): boolean {
  const t = text.trim();
  if (/£/.test(t)) return true;
  // Turkish (Phase 3): a number with a Turkish fee unit, "8 kişi başı",
  // "kişi başı 8", "toplam 80", "80 sterlin". Only for a Turkish org, so
  // the English test below is untouched. `\p{L}` boundaries, because `\b`
  // does not know that ş and ı are letters.
  if (lang === "tr" && /\d/.test(t) && TR_FEE_UNIT.test(t.toLocaleLowerCase("tr"))) return true;
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
async function findCollectorPendingMatch(
  userId: string,
  quoted?: QuotedBotMessage | null,
) {
  const orgs = await db.organisation.findMany({
    where: { paymentHolderId: userId, paymentCollectionEnabled: true },
    select: { id: true },
  });
  if (orgs.length === 0) return null;
  const orgIds = orgs.map((o) => o.id);

  const where = {
    activity: { orgId: { in: orgIds } },
    isHistorical: false,
    status: { not: "CANCELLED" as const },
    paymentLinksReleasedAt: null,
    date: { gte: new Date(Date.now() - FEE_CAPTURE_WINDOW_MS), lte: new Date() },
    OR: [{ feePendingConfirm: { not: null } }, { feePerPlayer: null }],
  };
  const include = {
    activity: { select: { name: true, orgId: true, org: { select: { language: true, ...PAY_METHOD_SELECT } } } },
  };
  // A swipe-reply to a message about one match acts on THAT match, when it
  // is still one this collector may set or confirm a fee for (quoted-reply
  // context S3; the rule payment-claim and the tentative follow-up follow,
  // review of #336).
  if (quoted?.matchId) {
    const quotedMatch = await db.match.findFirst({ where: { ...where, id: quoted.matchId }, include });
    if (quotedMatch) return quotedMatch;
    // A message we KNOW (one of our sends to him) about a match with
    // nothing to set or release: the reply answers that, so it is never
    // read as a yes to ANOTHER match's fee (review of #339, H1). Only a
    // quote known from the Pi's word alone (no key) falls back.
    if (quoted.key) return null;
  }
  // The NEWEST match awaiting his yes (review of #339, H3: this used to
  // order by the amount, so an older £10 beat a newer £8); else the newest
  // with no fee yet.
  return (
    (await db.match.findFirst({ where: { ...where, feePendingConfirm: { not: null } }, orderBy: { date: "desc" }, include })) ??
    (await db.match.findFirst({ where: { ...where, feePerPlayer: null }, orderBy: { date: "desc" }, include }))
  );
}

export interface CollectorReplyResult {
  /** Text MatchTime should DM back to the collector. */
  reply: string;
  /** Number of pay links released (set when the fee was just confirmed). */
  released?: number;
  /** The match the reply was about, and its club: the ack is queued under
   *  that club (review of #339), and a staged question is tagged with the
   *  match so a swipe-reply to it resolves to it. */
  matchId?: string;
  orgId?: string;
  /** The reply is the confirm question (an amount was staged). */
  asked?: boolean;
}

/** The one match this collector might be setting or confirming a fee
 *  for, reduced to the three fields the decision actually uses. */
export interface CollectorPendingMatch {
  id: string;
  name: string;
  /** An amount awaiting a yes/no. NULL means nothing has been proposed,
   *  and a "yes" is therefore meaningless. */
  feePendingConfirm: number | null;
  /** The match's org language (`Organisation.language`): the replies are
   *  written in it, the allowlist accepts its words and the model is told
   *  which question was asked. English when absent. */
  lang?: Lang;
  /** The match's club and kickoff: the ack's club and its date. Absent in
   *  a test double. */
  orgId?: string;
  date?: Date;
  /** `availablePayMethods(org)`: the "links sent" ack names only these.
   *  The database wiring always sets it; absent (a test double) reads as
   *  all three, the ack as it was before 2026-10-16. */
  payMethods?: PayMethod[];
}

/**
 * Every piece of I/O the collector fee flow performs, injected — the
 * shape `dm-intent.ts` uses, and for the same reason: a write path that
 * can only be exercised against a live database is a write path nobody
 * tests, and this one charges a real club.
 */
export interface CollectorFeeDeps {
  /** A recently-played, unreleased match in an org this sender collects
   *  for. Null means "not ours" and nothing below runs. */
  pendingMatch: () => Promise<CollectorPendingMatch | null>;
  /** Confirmed squad MINUS the collector — they collect the pot, they
   *  do not pay into it. */
  headcount: (matchId: string) => Promise<number>;
  /** Players on a free place (fee-waiver.ts), already left out of
   *  `headcount`; the confirm says how many. Absent means none. */
  freeCount?: (matchId: string) => Promise<number>;
  /** The model's read of the reply. Consulted ONLY when the anchored
   *  allowlist abstains AND the message is not an amount, which on the
   *  measured history is approximately never. */
  judge: (text: string, amount: number, matchName: string, lang: Lang) => Promise<FeeReply>;
  /** ⚠️ THE MONEY. Sets the fee and DMs a pay link to the whole
   *  confirmed squad. Returns how many went out, or null when another reply
   *  already released this match (a second "yes", a Pi redelivery): then
   *  nothing is sent and nothing is acked. */
  release: (matchId: string, amount: number) => Promise<number | null>;
  /** Whether the ✅/"yes" allowlist may decide. False when the reply is a
   *  swipe-reply to a message that is NOT the fee question (a rating DM, a
   *  pay chase, an invite): a ✅ there answers that message, so the model
   *  reads it with the quote (review of #339, H2). Absent: true. */
  allowlist?: boolean;
  /** Clears the pending amount. Sends nothing to anybody. */
  cancel: (matchId: string) => Promise<void>;
  /** Stages an amount for confirmation. Sends nothing to anybody. */
  stage: (matchId: string, perPlayer: number) => Promise<void>;
}

/**
 * The collector fee flow, as a pure function of six callbacks.
 *
 * ORDER IS THE CONTRACT, and it is cheapest-and-most-certain first:
 *
 *   1. IS THERE A MATCH AT ALL? One query. No → return, and the model
 *      is never asked.
 *   2. IS THIS THE MENU ANSWER? `anchoredFeeReply` — whole-body, free,
 *      offline. This is what the prompt told them to type, so it is
 *      what almost every real reply is, and it must keep working with
 *      Anthropic unreachable.
 *   3. IS THIS A NEW AMOUNT? Deterministic, and BEFORE the model, so
 *      "✅ actually make it £12" re-stages instead of releasing at the
 *      superseded price (it did, until 2026-09-11).
 *   4. ONLY THEN, WHAT IS IT? One model call, failing closed to
 *      `neither`.
 *
 * A null return means "not a fee interaction"; the caller falls through
 * to the handlers below it, exactly as it always has.
 */
export async function runCollectorFeeReply(
  text: string,
  deps: CollectorFeeDeps,
): Promise<CollectorReplyResult | null> {
  const match = await deps.pendingMatch();
  if (!match) return null;

  const headcount = await deps.headcount(match.id);
  const freeCount = deps.freeCount ? await deps.freeCount(match.id) : 0;
  const lang: Lang = match.lang ?? "en";

  const about = { matchId: match.id, ...(match.orgId ? { orgId: match.orgId } : {}) };
  const releaseNow = async (amount: number): Promise<CollectorReplyResult | null> => {
    const released = await deps.release(match.id, amount);
    // Another reply got there first: say nothing, send nothing more.
    if (released === null) return null;
    const methods = match.payMethods ?? ["pay_by_bank", "card", "direct"];
    const matchWhen = match.date ? dayLabel(lang, match.date) : null;
    return { ...about, released, reply: buildFeeReleasedAck({ released, fee: amount, matchName: match.name, matchWhen, methods, lang }) };
  };
  const cancelNow = async (): Promise<CollectorReplyResult> => {
    await deps.cancel(match.id);
    return { ...about, reply: buildFeeCancelledAck(lang) };
  };
  const stageNow = async (): Promise<CollectorReplyResult | null> => {
    const parsed = parseFeeReply(text, headcount, lang);
    if (!parsed) return null;
    await deps.stage(match.id, parsed.perPlayer);
    return {
      ...about,
      asked: true,
      reply: buildFeeConfirmPrompt({
        perPlayer: parsed.perPlayer,
        headcount,
        matchName: match.name,
        wasTotal: parsed.wasTotal,
        freeCount,
        lang,
      }),
    };
  };

  // ── Awaiting confirmation of a previously-proposed amount ──
  const pending = match.feePendingConfirm;
  if (pending != null) {
    const anchored = deps.allowlist === false ? null : anchoredFeeReply(text, lang);
    if (anchored === "yes") return releaseNow(pending);
    if (anchored === "no") return cancelNow();

    // A fresh amount supersedes the pending one — decided by code, and
    // decided before the model gets a look.
    if (looksLikeFeeAmount(text, lang)) {
      const staged = await stageNow();
      if (staged) return staged;
    }

    // Neither the menu answer nor a number. Ask once; every failure of
    // that call is `neither`, which does nothing.
    let judged: FeeReply;
    try {
      judged = await deps.judge(text, pending, match.name, lang);
    } catch (err) {
      // FAIL CLOSED, in the second place it can matter. `classifyFeeReply`
      // already swallows its own failures; this covers a caller that
      // wires in something else. No links go out on a classifier that
      // threw.
      console.error("[fee-confirm] judge threw; treating the reply as `neither`:", err);
      return null;
    }
    if (judged === "yes") return releaseNow(pending);
    if (judged === "no") return cancelNow();
    return null; // unrelated chatter while awaiting confirm → fall through
  }

  // ── No fee set yet: capture an amount if the message looks like one ──
  //   NOTE the asymmetry, and it is deliberate: with nothing proposed
  //   there is nothing for a "yes" to mean, so the model is never asked
  //   here and no reply can release anything.
  if (!looksLikeFeeAmount(text, lang)) return null;
  return stageNow();
}

/**
 * Handle a DM from a money collector that may be setting or confirming a
 * per-match fee. Returns null when the message isn't a fee
 * interaction (caller then falls through to survey / Q&A handling).
 *
 * This is the DATABASE WIRING for `runCollectorFeeReply` and nothing
 * else — the decision lives there so it can be tested without one.
 */
export async function handleCollectorFeeReply(
  userId: string,
  text: string,
  opts: {
    /** The MatchTime message this DM swipe-replies to, resolved once by
     *  the route (`resolveQuotedBotMessage`), or null. */
    quoted?: QuotedBotMessage | null;
    /** Where DMs to the collector are queued (digits, no "+"): the chat
     *  context's recent messages are read by it. */
    phone?: string | null;
  } = {},
): Promise<CollectorReplyResult | null> {
  // The club the fee is for pays for reading the reply (the daily AI cap,
  // lib/ai-budget.ts). Known once the pending match is found, which
  // `runCollectorFeeReply` does before it ever asks the model.
  let feeOrgId: string | null = null;
  // The match the reply is about, for the model's chat context.
  let feeMatch: { id: string; date: Date } | null = null;
  // The ✅/"yes" allowlist decides only when the reply is not a swipe-reply,
  // or swipe-replies to the fee question itself (review of #339, H2). Any
  // other quote, known or not, goes to the model with the quote in view.
  const allowlist = !opts.quoted || opts.quoted.topic === "feeQuestion";
  return runCollectorFeeReply(text, {
    allowlist,
    pendingMatch: async () => {
      const m = await findCollectorPendingMatch(userId, opts.quoted);
      feeOrgId = m?.activity.orgId ?? null;
      feeMatch = m ? { id: m.id, date: m.date } : null;
      // Monthly squad (slice 5): the collector was asked "£8 each, yes?"
      // but the amount was never staged (the Pi's ack was lost, or carried
      // no message id). Their reply is to that question, so the PAYG price
      // is staged now and a yes confirms it, instead of being dropped.
      // Null for every weekly club and every match with no such question.
      // ONLY for the explicit yes of the question's own menu, right after
      // the question, with no other DM from MatchTime in between, never
      // after a "no" and never for a question known not to have sent
      // (`mayStagePaygFeeOnReply`). Anything else stages nothing: an "ok"
      // meant for another message must never release pay links.
      let pending = m?.feePendingConfirm ?? null;
      if (m && pending == null && m.feePerPlayer == null) {
        pending = await stagePaygFeeForReply({
          matchId: m.id,
          collectorUserId: userId,
          reply: allowlist ? anchoredFeeReply(text, normaliseLang(m.activity.org.language)) : null,
        }).catch(() => null);
      }
      return m
        ? {
            id: m.id,
            name: m.activity.name,
            feePendingConfirm: pending,
            orgId: m.activity.orgId,
            date: m.date,
            lang: normaliseLang(m.activity.org.language),
            payMethods: availablePayMethods(m.activity.org),
          }
        : null;
    },
    // Monthly squad (slice 5): a regular's row is paid for by the month
    // and is not part of the per-match headcount. No club on "weekly" has
    // such a row, so its count is what it always was. A free place
    // (2026-10-16) is not either: neither counted nor part of a total's
    // split, and the confirm says how many were left out. A free place
    // that was paid anyway (money moved) still counts.
    headcount: (matchId) =>
      db.attendance.count({
        where: {
          matchId,
          status: "CONFIRMED",
          userId: { not: userId },
          AND: [
            { OR: [{ paymentMethod: null }, { paymentMethod: { not: MONTHLY_PAYMENT_METHOD } }] },
            { OR: [{ feeWaivedAt: null }, { paidAt: { not: null } }] },
          ],
        },
      }),
    freeCount: (matchId) =>
      db.attendance.count({
        where: {
          matchId,
          status: "CONFIRMED",
          userId: { not: userId },
          feeWaivedAt: { not: null },
          paidAt: null,
          OR: [{ paymentMethod: null }, { paymentMethod: { not: MONTHLY_PAYMENT_METHOD } }],
        },
      }),
    judge: async (reply, amount, matchName, lang) => {
      // What MatchTime said to them: the quote, read only when it is about
      // this match (`quoteForMatch`), or else the recent messages, among
      // which the fee question itself normally is the newest.
      const fm = feeMatch as { id: string; date: Date } | null;
      const replyContext = fm
        ? await loadDmReplyContext(db, { userId, phone: opts.phone ?? null, quoted: quoteForMatch(opts.quoted, fm.id) })
        : null;
      const ctx = { amount, matchName: fm ? contextMatchLabel(matchName, fm.date) : matchName, lang, replyContext };
      return feeOrgId ? withOrgAiBudget(feeOrgId, () => classifyFeeReply(reply, ctx)) : classifyFeeReply(reply, ctx);
    },
    release: async (matchId, amount) => {
      // COMPARE-AND-SET (review of #339): the fee and the release stamp are
      // written together, and only while the links have not gone out. Two
      // quick "yes"es, or a Pi redelivery of one, both pass the pending
      // check; only the first claims the match and DMs the squad.
      const claimed = await db.match.updateMany({
        where: { id: matchId, paymentLinksReleasedAt: null },
        data: {
          feePerPlayer: amount,
          feePendingConfirm: null,
          feeSetByUserId: userId,
          feeSetAt: new Date(),
          paymentLinksReleasedAt: new Date(),
        },
      });
      if (claimed.count === 0) return null;
      return releaseMatchPayments(matchId);
    },
    cancel: async (matchId) => {
      await db.match.update({ where: { id: matchId }, data: { feePendingConfirm: null } });
      // Monthly squad: the "no" is remembered, so the PAYG price is never
      // staged again for this match. Nothing for a weekly club.
      await recordPaygFeeDeclined(matchId).catch((err) => console.error("[fee-confirm] recording the decline failed:", err));
    },
    stage: async (matchId, perPlayer) => {
      await db.match.update({
        where: { id: matchId },
        data: { feePendingConfirm: perPlayer, feeSetByUserId: userId },
      });
    },
  });
}
