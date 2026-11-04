/**
 * A player's OWN payments for the DM Q&A (Kemal, 2026-10-20): what the
 * CONTEXT says about the asker's money, and only the asker's.
 */
import { describe, it, expect } from "vitest";
import {
  decideMyPayments,
  formatMyPaymentsBlock,
  payableMatchIds,
  MY_PAYMENTS_MAX_MATCHES,
  type MyPaymentRow,
  type MyPaymentsInput,
  type MyPaymentsOrg,
} from "../my-payments-rules";
import { feeFact, type FeeFact, type FeeInputs } from "../fee-fact";

/** The game's usual £6 for a club that collects, before the collector confirms. */
const USUAL_6 = feeFact({ matchFee: null, gameFee: 6, splitTotal: false, paygPence: null, collection: true });

const ORG: MyPaymentsOrg = {
  paymentTrackingEnabled: false,
  paymentCollectionEnabled: true,
  paymentHolderId: "u-collector",
  paymentInstructions: "Bank: Monzo, sort code 04-00-04, account 12345678",
  squadMode: "weekly",
  payMethodPayByBank: true,
  payMethodCard: true,
  payMethodDirect: true,
  stripeConnectAccountId: "acct_collector",
  stripeChargesEnabled: true,
};

/** Fri 11 Sep 2026, 21:00 London. */
const FRI_11 = new Date("2026-09-11T20:00:00.000Z");
const FRI_4 = new Date("2026-09-04T20:00:00.000Z");

const row = (over: Partial<MyPaymentRow> = {}): MyPaymentRow => ({
  matchId: "m-11",
  activityName: "Cuma Maçı",
  date: FRI_11,
  fee: 6,
  paymentLinksReleasedAt: new Date("2026-09-11T22:00:00.000Z"),
  paidAt: null,
  feeWaivedAt: null,
  paymentMethod: null,
  directPendingAt: null,
  ...over,
});

const input = (over: Partial<MyPaymentsInput> = {}): MyPaymentsInput => ({
  userId: "u-me",
  org: ORG,
  collectorName: "Erdal Özkan",
  upcomingFee: USUAL_6,
  rows: [row()],
  ...over,
});

const only = (p: ReturnType<typeof decideMyPayments>) => {
  if (p.kind !== "tracked") throw new Error(`expected tracked, got ${p.kind}`);
  return p;
};

describe("decideMyPayments", () => {
  it("a club with neither payment path is not tracked", () => {
    const p = decideMyPayments(input({ org: { ...ORG, paymentCollectionEnabled: false, paymentTrackingEnabled: false } }));
    expect(p).toEqual({ kind: "not_tracked" });
  });

  it("the collector never owes his own club", () => {
    expect(decideMyPayments(input({ userId: "u-collector" }))).toEqual({ kind: "collector" });
  });

  it("an unpaid row with the links out is owed, with its amount", () => {
    const p = only(decideMyPayments(input()));
    expect(p.lines).toEqual([{ matchId: "m-11", activityName: "Cuma Maçı", date: FRI_11, state: "owed", fee: 6 }]);
    expect(payableMatchIds(p)).toEqual(["m-11"]);
  });

  it("paid, free, monthly, pending, no fee yet: each its own state, none payable", () => {
    const states = (r: Partial<MyPaymentRow>) => only(decideMyPayments(input({ rows: [row(r)] }))).lines[0].state;
    expect(states({ paidAt: new Date() })).toBe("paid");
    expect(states({ feeWaivedAt: new Date() })).toBe("free");
    expect(states({ paymentMethod: "monthly" })).toBe("monthly");
    expect(states({ directPendingAt: new Date() })).toBe("pending_collector");
    expect(states({ fee: null, paymentLinksReleasedAt: null })).toBe("no_fee_yet");
    // Paid wins over free (fee-waiver-rules.ts): money moved.
    expect(states({ paidAt: new Date(), feeWaivedAt: new Date() })).toBe("paid");
  });

  it("a collecting club that also runs the poll says no fee yet before the links go out, never 'not marked as paid'", () => {
    const p = only(
      decideMyPayments(input({ org: { ...ORG, paymentTrackingEnabled: true }, rows: [row({ fee: null, paymentLinksReleasedAt: null })] })),
    );
    expect(p.lines[0].state).toBe("no_fee_yet");
  });

  it("a poll-tracked club with no amount says not marked as paid, never owed", () => {
    const p = only(
      decideMyPayments(
        input({ org: { ...ORG, paymentCollectionEnabled: false, paymentTrackingEnabled: true }, rows: [row({ fee: null, paymentLinksReleasedAt: null })] }),
      ),
    );
    expect(p.lines[0].state).toBe("not_marked_paid");
    // No collection: no ways to pay, no instructions, no usual fee.
    expect(p.methods).toEqual([]);
    expect(p.instructions).toBeNull();
    expect(p.upcomingFee).toBeNull();
  });

  it("lists the newest matches first, at most MY_PAYMENTS_MAX_MATCHES", () => {
    const rows = [0, 1, 2, 3, 4].map((i) => row({ matchId: `m${i}`, date: new Date(FRI_4.getTime() + i * 86_400_000) }));
    const p = only(decideMyPayments(input({ rows })));
    expect(p.lines.map((l) => l.matchId)).toEqual(["m4", "m3", "m2"].slice(0, MY_PAYMENTS_MAX_MATCHES));
  });

  it("names only the ways the club takes payment (availablePayMethods)", () => {
    const p = only(decideMyPayments(input({ org: { ...ORG, stripeChargesEnabled: false } })));
    expect(p.methods).toEqual(["direct"]);
  });
});

describe("formatMyPaymentsBlock", () => {
  it("English: collector, ways to pay, instructions, fee and the owed line with its link", () => {
    const p = decideMyPayments(input({ rows: [row(), row({ matchId: "m-4", date: FRI_4, paidAt: new Date() })] }));
    expect(formatMyPaymentsBlock(p, "en", { "m-11": "https://mt.example/s/pay" })).toBe(
      [
        "YOUR PAYMENTS (this player's own; you know nothing about anyone else's payments):",
        "- Money collector: Erdal Özkan",
        "- Ways to pay: pay by bank, card, pay Erdal Özkan directly",
        "- The club's payment instructions (quote them exactly): Bank: Monzo, sort code 04-00-04, account 12345678",
        "- Upcoming match's fee: not confirmed yet. The usual fee is £6 per player; the money collector confirms it after the game.",
        "- Cuma Maçı, Fri 11 Sep at 21:00: owes £6, not paid yet. Pay link: https://mt.example/s/pay",
        "- Cuma Maçı, Fri 4 Sep at 21:00: paid: payment received and recorded. Nothing to pay.",
      ].join("\n"),
    );
  });

  it("Turkish: the match dates are written in Turkish, with their weekday", () => {
    const block = formatMyPaymentsBlock(decideMyPayments(input()), "tr");
    expect(block).toContain("- Cuma Maçı, 11 Eylül Cuma 21:00: owes £6, not paid yet.");
  });

  it("a pending direct payment says the collector has not confirmed it yet", () => {
    const block = formatMyPaymentsBlock(decideMyPayments(input({ rows: [row({ directPendingAt: new Date() })] })), "en");
    expect(block).toContain("£6, settling with Erdal Özkan directly. Not recorded as paid until Erdal Özkan confirms receiving it.");
    expect(block).not.toContain("Pay link");
  });

  it("not tracked and collector are one line each", () => {
    expect(formatMyPaymentsBlock({ kind: "not_tracked" }, "en")).toContain("does not run payments through MatchTime");
    expect(formatMyPaymentsBlock({ kind: "collector" }, "en")).toContain("You collect this club's match fees");
  });

  // Decision K3 (club summary B5): the upcoming match's ONE fee fact. Before
  // B5 the line said "Usual match fee" whatever it was: the match's own
  // confirmed fee or the game's default, and a split game's total.
  describe("the upcoming match's fee (K3)", () => {
    const fee = (over: Partial<FeeInputs>) => feeFact({ matchFee: null, gameFee: null, splitTotal: false, paygPence: null, collection: true, ...over });
    const line = (upcomingFee: FeeFact | null) =>
      formatMyPaymentsBlock(decideMyPayments(input({ upcomingFee })), "en")
        .split("\n")
        .filter((l) => l.startsWith("- Upcoming match's fee"));

    it("confirmed by the collector: the amount, said as confirmed", () => {
      expect(line(fee({ matchFee: 7, gameFee: 6 }))).toEqual(["- Upcoming match's fee: £7 per player, confirmed by the money collector."]);
    });

    it("not confirmed yet: the usual fee, marked as not confirmed yet", () => {
      expect(line(fee({ gameFee: 6 }))).toEqual([
        "- Upcoming match's fee: not confirmed yet. The usual fee is £6 per player; the money collector confirms it after the game.",
      ]);
    });

    it("a week of a running month: the pay as you go price, not confirmed yet", () => {
      expect(line(fee({ gameFee: 6, paygPence: 800 }))).toEqual([
        "- Upcoming match's fee: not confirmed yet. The usual fee is £8 per player, the pay as you go price (regulars pay for the month instead); the money collector confirms it after the game.",
      ]);
    });

    it("a split game: no per-player amount until the collector enters the total", () => {
      expect(line(fee({ gameFee: 80, splitTotal: true }))).toEqual([
        "- Upcoming match's fee: the pitch cost split between who played; the money collector sets it after the game.",
      ]);
    });

    it("no fee, or no upcoming match: no line", () => {
      expect(line(fee({}))).toEqual([]);
      expect(line(null)).toEqual([]);
    });

    it("a club that does not collect gets no fee line (unchanged)", () => {
      const p = decideMyPayments(input({ org: { ...ORG, paymentCollectionEnabled: false, paymentTrackingEnabled: true }, upcomingFee: fee({ gameFee: 6, collection: false }) }));
      expect(formatMyPaymentsBlock(p, "en")).not.toContain("fee:");
    });
  });

  it("no collector on record reads 'the organiser'", () => {
    const block = formatMyPaymentsBlock(decideMyPayments(input({ collectorName: null })), "en");
    expect(block).toContain("- Money collector: the organiser");
    expect(block).toContain("pay the organiser directly");
  });
});
