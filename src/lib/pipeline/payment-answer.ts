/**
 * WHO HAS NOT PAID — the decision, as a pure function.
 *
 * "@Match Time who hasn't paid" was one of the ten tagged questions
 * MatchTime could not answer. Every other one on that list was a read of
 * something `SquadState` already held; this one is not. It is also the
 * only one where being WRONG costs a person something: telling a group
 * that somebody has not paid when they have is socially expensive and
 * cannot be taken back with a correction ten minutes later.
 *
 * So the truth is defined in ONE place — `buildUnpaidTail`
 * (`bot-scheduler.ts:242-300`), which has been posting this number to
 * the live Sutton FC group since April — and this module is that
 * definition, moved to where a question can reach it and made pure so it
 * can be tested without a database, a match or a model.
 *
 * ── NO PRISMA HERE, AND THAT IS STRUCTURAL ───────────────────────────
 * `compose.ts`'s header records why this directory keeps its I/O in one
 * file: the Playwright worker never loads Prisma, and a static import of
 * `../db` kills the whole corpus spec at load. `load-state.ts` does the
 * one query and hands the rows in. Nothing below reads the world.
 *
 * ── WHICH ORG FLAG GATES IT — AND WHY IT IS NOT THE OBVIOUS ONE ──────
 * Sutton FC, read live on 2026-09-09:
 *
 *   paymentTrackingEnabled   FALSE
 *   paymentCollectionEnabled TRUE
 *   stripeChargesEnabled     TRUE
 *
 * The flag with "tracking" in its name is off, and MatchTime still knows
 * exactly who has paid: 4 of 10 on 2026-09-08, 7 of 10 on 07-14, 12 of
 * 14 on 07-07, 13 of 14 on 06-30. The three flags do NOT mean what their
 * names suggest, so each is written out here:
 *
 *   • `paymentTrackingEnabled` gates the POLL path and the group chase:
 *     ticking your team in the WhatsApp payment poll writes `paidAt`
 *     (`poll-vote/route.ts:118`), an admin's "Amir paid for 4" becomes a
 *     `PaymentCredit`, and the 17:00 update carries the "N payments
 *     still pending" tail. Sutton turned it OFF on 2026-04-29 because
 *     Elvin, who takes the money, found the chase overhead unnecessary
 *     (the schema comment says so).
 *   • `paymentCollectionEnabled` gates STRIPE per-match fee collection.
 *     When it is on and the fee is set, pay links go out and `paidAt` is
 *     written by the Stripe webhook (`payment-flow.ts:157`) and by the
 *     collector confirming a direct payment
 *     (`actions/payments.ts:327`). This is where Sutton's `paidAt` rows
 *     come from.
 *   • `stripeChargesEnabled` is a fact about the connected ACCOUNT — can
 *     it accept charges and receive payouts. It gates the two Stripe
 *     rails; "pay the collector directly" runs without it. It says
 *     nothing about whether MatchTime knows who paid, so it is not a
 *     gate here at all.
 *
 * The question is therefore not "which flag is on" but "does MatchTime
 * have a source of truth for `paidAt` on THIS match": the poll path
 * (tracking) or released pay links (collection). If neither, the honest
 * answer is that MatchTime does not know — never an empty list, which
 * would read as "everyone has paid".
 *
 * ── AND THE ANSWER NAMES NOBODY ──────────────────────────────────────
 * This module returns COUNTS. It has no field for a name, so no caller
 * can print one, which is the point rather than an omission.
 *
 * The precedent is `buildUnpaidTail` and it is explicit: *"Poll-only
 * format per Sait's suggestion (2026-04-25). No naming, no shaming."*
 * That is the customer's own decision about their own group, and this
 * answer goes to the same place the chase does — `AnswerMessageOutcome`
 * carries a `reply` and a `react`, both of which `route.ts` sends to the
 * GROUP. There is no DM on this path, so "tell the admin instead" is not
 * an option that exists here; the only choice is between a count to the
 * group and nothing.
 *
 * Which is also why there is no ADMIN GATE. The 17:00 scheduler already
 * posts this exact number to the whole group, unprompted, on every org
 * that tracks. Answering a tagged question with the number the group is
 * shown anyway is strictly less than what already happens; refusing to
 * answer an ordinary member would be a silence bought with nothing.
 * Naming names — which nothing here can do — would be the part that
 * needed an admin, and a DM to send it in.
 */

/** The org and match facts this decision needs, and nothing else. */
export interface PaymentTruthInput {
  /** `Organisation.paymentTrackingEnabled` — the POLL path. */
  paymentTracking: boolean;
  /** `Organisation.paymentCollectionEnabled` — the STRIPE path. */
  paymentCollection: boolean;
  /** `Organisation.paymentHolderId`. The collector is owed, not owing,
   *  and `buildUnpaidTail` excludes them because "including them in the
   *  unpaid chase would be embarrassing". Null = the org set none, and
   *  then nobody is excluded — the same fallback. */
  paymentHolderId: string | null;
  /** The last match that ENDED, or null. Narrowed below. */
  match: {
    kickoffLabel: string;
    status: "TEAMS_GENERATED" | "TEAMS_PUBLISHED" | "COMPLETED";
    isHistorical: boolean;
    /** `Match.paymentLinksReleasedAt`. Non-null means the fee is set and
     *  the pay links went out, so the Stripe path is writing `paidAt`
     *  for this match. */
    paymentLinksReleasedAt: Date | null;
    /** CONFIRMED rows only, with `paidAt != null` flattened to a bool. */
    confirmed: Array<{ userId: string; paid: boolean }>;
    /** Sum of `PaymentCredit.count` on this match. */
    creditCount: number;
  } | null;
}

/**
 * What MatchTime is willing to say about payments.
 *
 * Four shapes, and three of them are refusals with a reason. That ratio
 * is deliberate: the wrong answer here costs a person something.
 */
export type PaymentSnapshot =
  /** The org does neither poll tracking nor Stripe collection. */
  | { kind: "not_tracked" }
  /** Nothing settled to report on — no ended match, or the last one is
   *  not COMPLETED, or it is a seeded backfill. */
  | { kind: "no_settled_match" }
  /** A settled match, and no evidence either way: nobody stamped, no
   *  credits, or the pay links never went out. */
  | { kind: "no_signal"; kickoffLabel: string }
  | {
      kind: "counted";
      /** How many people could owe — CONFIRMED minus the collector. */
      chargeable: number;
      /** How many of them have not settled, after credits. */
      unpaid: number;
      kickoffLabel: string;
    };

/**
 * Does MatchTime have a source of truth for `paidAt` on this match? The
 * poll path (tracking) writes it for any match; Stripe collection only
 * once the fee is set and the pay links are out. Shared with the DM
 * Q&A's "did you get my payment?" (`my-payments-rules.ts`), so a player
 * and the group are told the same thing about the same match.
 */
export function matchHasPaymentSource(input: {
  paymentTracking: boolean;
  paymentCollection: boolean;
  paymentLinksReleasedAt: Date | null;
}): boolean {
  return input.paymentTracking || (input.paymentCollection && input.paymentLinksReleasedAt !== null);
}

export function decidePaymentSnapshot(input: PaymentTruthInput): PaymentSnapshot {
  // (1) ORG LEVEL. Neither path exists, so there is no `paidAt` to read
  // and an empty unpaid list would be a claim rather than an absence.
  if (!input.paymentTracking && !input.paymentCollection) return { kind: "not_tracked" };

  // (2) THE MATCH. `COMPLETED && !isHistorical` is exactly the selector
  // `buildUnpaidTail` uses for the chase and `admin-ops-engine-batch.ts`
  // uses to accept a payment credit; being the third consumer of a money
  // fact is not the place to invent a fourth rule.
  //
  // NOTE WHAT IT DOES NOT DO: it does not walk BACK to an older
  // COMPLETED match when the most recent ended one is TEAMS_PUBLISHED.
  // The caller passes the last match that ended, and if that one is not
  // settled the answer is "nothing settled", not a number about a
  // different night. Same argument `SquadState.completedMatch`'s own
  // comment makes about a score landing two weeks late.
  const m = input.match;
  if (!m) return { kind: "no_settled_match" };
  if (m.status !== "COMPLETED" || m.isHistorical) return { kind: "no_settled_match" };

  // (3) A SOURCE OF TRUTH FOR THIS MATCH. Tracking writes `paidAt` from
  // the poll for any match; collection writes it only once the fee is
  // set and the links are out. Sutton's 2026-09-01 match is COMPLETED
  // with no fee, no links and nothing paid — there is nothing to read.
  const hasSource = matchHasPaymentSource({
    paymentTracking: input.paymentTracking,
    paymentCollection: input.paymentCollection,
    paymentLinksReleasedAt: m.paymentLinksReleasedAt,
  });

  const chargeableRows = input.paymentHolderId
    ? m.confirmed.filter((c) => c.userId !== input.paymentHolderId)
    : m.confirmed;
  const paid = chargeableRows.filter((c) => c.paid).length;

  // (4) NO EVIDENCE EITHER WAY. `buildUnpaidTail` refuses the same case
  // in the same words: nobody stamped and no credits "could mean nobody
  // paid, but more likely means the poll fired before our paid-tracking
  // was live, or the votes failed to ACK back to the server. In that
  // case 'N unpaid' is false precision." Folded together with the
  // missing-source case above because they say the same thing to the
  // person asking: MatchTime cannot tell.
  if (!hasSource || (paid === 0 && m.creditCount === 0)) {
    return { kind: "no_signal", kickoffLabel: m.kickoffLabel };
  }

  // (5) THE ARITHMETIC, `buildUnpaidTail`'s exactly. Bulk credits cover
  // people whose own row was never stamped: the named-player path writes
  // `paidAt` and creates NO credit row, the count-only path creates a
  // credit and stamps nobody, so subtracting is not double-counting.
  const unpaid = Math.max(0, chargeableRows.length - paid - m.creditCount);
  return {
    kind: "counted",
    chargeable: chargeableRows.length,
    unpaid,
    kickoffLabel: m.kickoffLabel,
  };
}
