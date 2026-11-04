/**
 * A PLAYER'S OWN PAYMENTS, FOR THE DM Q&A (Kemal, 2026-10-20). Pure: no
 * database, no clock.
 *
 * Kemal ruled that a private question about money is answered, like the
 * group's `answer_payments`, with one difference that is the whole point:
 * the group answer is a COUNT for everyone, and a DM answer is about THE
 * ASKER ONLY. What they owe and for which match, how to pay, and whether
 * their payment is recorded. Never anyone else's.
 *
 * THE PRIVACY IS STRUCTURAL, as it is for phone numbers in `dm-qa.ts`:
 * the loader reads only the asker's own Attendance rows, and nothing in
 * `MyPaymentsInput` can hold another player's payment. "Has Ali paid?"
 * cannot be answered because the answer is not in the CONTEXT; the
 * prompt's decline is the second layer.
 *
 * Every rule here is an existing one, reused rather than restated:
 *   - who owes a match fee: `owesMatchFee` (fee-waiver-rules.ts), the
 *     collector, a monthly regular, paid and a free place excluded;
 *   - whether MatchTime knows who paid a match: `matchHasPaymentSource`
 *     (pipeline/payment-answer.ts), the group answer's own rule;
 *   - the ways to pay and the club's instructions: `availablePayMethods`
 *     and `directPayInstructions` (payments.ts), what the pay page, the
 *     pay link and the daily chase name;
 *   - the amount: `gbp` (payments.ts), the pay copy's format.
 */
import { owesMatchFee, isFeeWaived } from "./fee-waiver-rules";
import { availablePayMethods, directPayInstructions, gbp, type PayMethod, type PayMethodSwitches } from "./payments";
import { matchHasPaymentSource } from "./pipeline/payment-answer";
import { paymentMessagesOn } from "./payment-messages";
import { dayTimeLabel } from "./i18n/dates";
import type { Lang } from "./i18n/lang";
import type { FeeFact } from "./fee-fact";

/** How many of the asker's matches the CONTEXT lists, newest first. */
export const MY_PAYMENTS_MAX_MATCHES = 3;

/** The club's payment settings, as `Organisation` holds them. */
export interface MyPaymentsOrg extends PayMethodSwitches {
  paymentTrackingEnabled: boolean;
  paymentCollectionEnabled: boolean;
  paymentHolderId: string | null;
  paymentInstructions: string | null;
  squadMode: string | null;
}

/** One of the asker's OWN attendance rows on a match that has been
 *  played, with the match's money fields. */
export interface MyPaymentRow {
  matchId: string;
  activityName: string;
  date: Date;
  /** `Match.feePerPlayer`: null until the collector sets it. */
  fee: number | null;
  paymentLinksReleasedAt: Date | null;
  paidAt: Date | null;
  feeWaivedAt: Date | null;
  paymentMethod: string | null;
  /** He chose (or said) he would pay the collector directly, and the
   *  collector has not confirmed it yet. */
  directPendingAt: Date | null;
}

export type MyPaymentState =
  /** Recorded as paid (card, bank, or the collector confirmed it). */
  | "paid"
  /** A free place: nothing to pay. */
  | "free"
  /** A monthly regular's place: the month paid for it. */
  | "monthly"
  /** He is settling with the collector directly; the collector has not
   *  confirmed receipt yet. Not paid, and not to be chased. */
  | "pending_collector"
  /** The fee is set, the pay links went out, and it is not paid. */
  | "owed"
  /** MatchTime tracks payments for this match (the poll) but holds no
   *  amount, and he is not marked paid. */
  | "not_marked_paid"
  /** No fee for this match in MatchTime yet. */
  | "no_fee_yet";

export interface MyPaymentLine {
  matchId: string;
  activityName: string;
  date: Date;
  state: MyPaymentState;
  /** The amount for "owed" and "pending_collector"; null otherwise. */
  fee: number | null;
}

export type MyPayments =
  /** The club runs no payments through MatchTime. */
  | { kind: "not_tracked" }
  /** The asker is the club's money collector: he collects, never owes. */
  | { kind: "collector" }
  | {
      kind: "tracked";
      collectorName: string | null;
      methods: PayMethod[];
      instructions: string | null;
      /** The upcoming match's one fee fact (fee-fact.ts, slice B5, K3), or
       *  null without a match or when the club does not collect. */
      upcomingFee: FeeFact | null;
      lines: MyPaymentLine[];
    };

/** What `decideMyPayments` needs. `rows` are the asker's own, any order. */
export interface MyPaymentsInput {
  userId: string;
  org: MyPaymentsOrg;
  collectorName: string | null;
  /** The upcoming match's fee fact (`feeFact`), or null without a match. */
  upcomingFee: FeeFact | null;
  rows: MyPaymentRow[];
}

export function decideMyPayments(input: MyPaymentsInput): MyPayments {
  const { org } = input;
  if (!paymentMessagesOn(org)) return { kind: "not_tracked" };
  if (org.paymentHolderId && org.paymentHolderId === input.userId) return { kind: "collector" };

  const lines = [...input.rows]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, MY_PAYMENTS_MAX_MATCHES)
    .map((r): MyPaymentLine => ({ matchId: r.matchId, activityName: r.activityName, date: r.date, ...stateOf(r, input) }));

  return {
    kind: "tracked",
    collectorName: input.collectorName,
    methods: org.paymentCollectionEnabled ? availablePayMethods(org) : [],
    instructions: org.paymentCollectionEnabled ? directPayInstructions(org) : null,
    upcomingFee: org.paymentCollectionEnabled ? input.upcomingFee : null,
    lines,
  };
}

function stateOf(r: MyPaymentRow, input: MyPaymentsInput): { state: MyPaymentState; fee: number | null } {
  if (r.paidAt) return { state: "paid", fee: null };
  if (isFeeWaived(r)) return { state: "free", fee: null };
  if (!owesMatchFee({ ...r, userId: input.userId }, input.org.paymentHolderId)) return { state: "monthly", fee: null };
  const linksOut = input.org.paymentCollectionEnabled && r.fee !== null && r.paymentLinksReleasedAt !== null;
  if (linksOut) return r.directPendingAt ? { state: "pending_collector", fee: r.fee } : { state: "owed", fee: r.fee };
  // A club that collects through MatchTime and has not sent this match's
  // pay links has set no fee yet, whatever the poll says (the live e2e run
  // of 2026-10-20: "not marked as paid" on a no-fee match read as a debt).
  if (input.org.paymentCollectionEnabled) return { state: "no_fee_yet", fee: null };
  const tracked = matchHasPaymentSource({
    paymentTracking: input.org.paymentTrackingEnabled,
    paymentCollection: input.org.paymentCollectionEnabled,
    paymentLinksReleasedAt: r.paymentLinksReleasedAt,
  });
  return { state: tracked ? "not_marked_paid" : "no_fee_yet", fee: null };
}

/** The matches a pay link is wanted for: the ones he can still pay. */
export function payableMatchIds(p: MyPayments): string[] {
  return p.kind === "tracked" ? p.lines.filter((l) => l.state === "owed").map((l) => l.matchId) : [];
}

/** Has he a fee of his own still open: owed, or settling with the
 *  collector and not yet confirmed (2026-11-04). "How do I pay?" from him
 *  is about that fee, so the DM help gives way to the DM Q&A, which has his
 *  pay link (`helpGivesWayToOwnFee`, dm-help.ts). */
export function hasFeeToSettle(p: MyPayments): boolean {
  return p.kind === "tracked" && p.lines.some((l) => l.state === "owed" || l.state === "pending_collector");
}

const METHOD_WORDS: Record<PayMethod, (collector: string) => string> = {
  pay_by_bank: () => "pay by bank",
  card: () => "card",
  direct: (collector) => `pay ${collector} directly`,
};

/**
 * The CONTEXT block, in English labels (the language line tells a
 * Turkish answer how to say them). Match dates are written in the club's
 * language, like every other date in the CONTEXT, so nothing is
 * translated or worked out.
 */
export function formatMyPaymentsBlock(p: MyPayments, lang: Lang, payLinks: Record<string, string> = {}): string {
  const head = "YOUR PAYMENTS (this player's own; you know nothing about anyone else's payments):";
  if (p.kind === "not_tracked") {
    return `${head}\n- This club does not run payments through MatchTime. For money questions, ask the organiser.`;
  }
  if (p.kind === "collector") {
    return `${head}\n- You collect this club's match fees, so you have nothing to pay.`;
  }
  const collector = p.collectorName?.trim() || "the organiser";
  const lines = [head, `- Money collector: ${collector}`];
  if (p.methods.length > 0) {
    lines.push(`- Ways to pay: ${p.methods.map((m) => METHOD_WORDS[m](collector)).join(", ")}`);
  }
  if (p.instructions) lines.push(`- The club's payment instructions (quote them exactly): ${p.instructions}`);
  const fee = upcomingFeeLine(p.upcomingFee);
  if (fee) lines.push(fee);
  if (p.lines.length === 0) {
    lines.push("- No played matches of yours to pay for.");
  }
  for (const l of p.lines) {
    const match = `${l.activityName}, ${dayTimeLabel(lang, l.date)}`;
    lines.push(`- ${match}: ${stateWords(l, collector, payLinks[l.matchId])}`);
  }
  return lines.join("\n");
}

/**
 * The upcoming match's fee, one line, from its one fee fact (slice B5,
 * decision K3). The model is told whether the collector has confirmed it,
 * so a "how much is it?" before the game is answered with the usual fee
 * AND that it is not confirmed yet; nothing else in the block changes.
 * A club that collects is the only one with this line (`decideMyPayments`).
 */
function upcomingFeeLine(f: FeeFact | null): string | null {
  if (!f) return null;
  const head = "- Upcoming match's fee:";
  if (f.amount === null) {
    return f.splitTotal ? `${head} the pitch cost split between who played; the money collector sets it after the game.` : null;
  }
  if (f.confirmed) return `${head} ${gbp(f.amount)} per player, confirmed by the money collector.`;
  const price = f.source === "payg" ? `${gbp(f.amount)} per player, the pay as you go price (regulars pay for the month instead)` : `${gbp(f.amount)} per player`;
  return `${head} not confirmed yet. The usual fee is ${price}; the money collector confirms it after the game.`;
}

function stateWords(l: MyPaymentLine, collector: string, link: string | undefined): string {
  switch (l.state) {
    case "paid":
      return "paid: payment received and recorded. Nothing to pay.";
    case "free":
      return "a free place. Nothing to pay.";
    case "monthly":
      return "paid for by the month. Nothing to pay here.";
    case "pending_collector":
      return `${gbp(l.fee ?? 0)}, settling with ${collector} directly. Not recorded as paid until ${collector} confirms receiving it.`;
    case "owed":
      return `owes ${gbp(l.fee ?? 0)}, not paid yet.${link ? ` Pay link: ${link}` : ""}`;
    case "not_marked_paid":
      return "not marked as paid in MatchTime. No amount on record.";
    case "no_fee_yet":
      return "no fee set yet. Nothing to pay for now.";
  }
}
