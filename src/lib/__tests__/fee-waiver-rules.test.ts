/**
 * Free places (2026-10-16), the pure rules: who may be made free, which
 * match an organiser's "he's free this week" means, how a row reads on
 * the payments page, and the headcount the collector is asked about.
 */
import { describe, it, expect } from "vitest";
import {
  collectRowState,
  decideWaive,
  feeHeadcount,
  isFeeWaived,
  owesMatchFee,
  pickWaiverMatch,
  FEE_WAIVER_RECENT_MS,
} from "../fee-waiver-rules";

const at = (iso: string) => new Date(iso);
const row = (o: Partial<{ status: string; paidAt: Date | null; feeWaivedAt: Date | null; paymentMethod: string | null }> = {}) => ({
  status: "CONFIRMED",
  paidAt: null,
  feeWaivedAt: null,
  paymentMethod: null,
  ...o,
});

describe("the monthly mark", () => {
  it("is the same string monthly-week.ts writes", async () => {
    const { MONTHLY_PAYMENT_METHOD } = await import("../monthly-week");
    expect(MONTHLY_PAYMENT_METHOD).toBe("monthly");
    expect(owesMatchFee({ userId: "a", paymentMethod: MONTHLY_PAYMENT_METHOD }, null)).toBe(false);
  });
});

describe("isFeeWaived / owesMatchFee", () => {
  it("a waived row owes nothing; a paid row owes nothing; a monthly regular owes nothing per match", () => {
    expect(isFeeWaived({ feeWaivedAt: at("2026-10-16T18:00:00Z") })).toBe(true);
    expect(isFeeWaived({ feeWaivedAt: null })).toBe(false);
    expect(isFeeWaived({})).toBe(false);
    expect(owesMatchFee({ userId: "a", ...row() }, "col")).toBe(true);
    expect(owesMatchFee({ userId: "a", ...row({ feeWaivedAt: new Date() }) }, "col")).toBe(false);
    expect(owesMatchFee({ userId: "a", ...row({ paidAt: new Date() }) }, "col")).toBe(false);
    expect(owesMatchFee({ userId: "a", ...row({ paymentMethod: "monthly" }) }, "col")).toBe(false);
    expect(owesMatchFee({ userId: "col", ...row() }, "col")).toBe(false);
  });
});

describe("decideWaive", () => {
  it("an unpaid squad place is waived, CONFIRMED or on the bench", () => {
    expect(decideWaive(row())).toBe("waive");
    expect(decideWaive(row({ status: "BENCH" }))).toBe("waive");
  });
  it("is idempotent: a free place stays free, and says so", () => {
    expect(decideWaive(row({ feeWaivedAt: new Date() }))).toBe("already-free");
  });
  it("never relabels a payment: a paid player stays paid", () => {
    expect(decideWaive(row({ paidAt: new Date() }))).toBe("already-paid");
    // Paid AND waived (a bank payment that settled after the waive): paid wins.
    expect(decideWaive(row({ paidAt: new Date(), feeWaivedAt: new Date() }))).toBe("already-paid");
  });
  it("a monthly regular's place is paid for by the month", () => {
    expect(decideWaive(row({ paymentMethod: "monthly" }))).toBe("monthly");
  });
  it("no row, or dropped: not in the squad", () => {
    expect(decideWaive(null)).toBe("not-in-squad");
    expect(decideWaive(row({ status: "DROPPED" }))).toBe("not-in-squad");
  });
});

describe("pickWaiverMatch: which match 'this week' means", () => {
  const now = at("2026-10-17T10:00:00Z"); // Saturday morning
  const played = { id: "fri", date: at("2026-10-16T20:00:00Z") };
  const next = { id: "nextfri", date: at("2026-10-23T20:00:00Z") };
  const later = { id: "later", date: at("2026-10-30T20:00:00Z") };

  it("the game just played (kicked off within the last 48 hours) wins: its fee is being collected", () => {
    expect(pickWaiverMatch([next, played, later], now)?.id).toBe("fri");
  });
  it("otherwise the next game not yet kicked off", () => {
    const wed = at("2026-10-21T10:00:00Z");
    expect(pickWaiverMatch([later, played, next], wed)?.id).toBe("nextfri");
  });
  it("the boundary: 48 hours after kickoff it is the next game", () => {
    const edge = new Date(played.date.getTime() + FEE_WAIVER_RECENT_MS + 1);
    expect(pickWaiverMatch([played, next], edge)?.id).toBe("nextfri");
  });
  it("two games in the last 48 hours: the latest", () => {
    const thu = { id: "thu", date: at("2026-10-15T20:00:00Z") };
    expect(pickWaiverMatch([thu, played], at("2026-10-16T22:00:00Z"))?.id).toBe("fri");
  });
  it("nothing recent and nothing ahead: null", () => {
    expect(pickWaiverMatch([], now)).toBeNull();
    expect(pickWaiverMatch([{ id: "old", date: at("2026-10-01T20:00:00Z") }], now)).toBeNull();
  });
});

describe("collectRowState: how a row reads on /collect", () => {
  it("paid wins over free (money moved); free over direct-pending and unpaid", () => {
    expect(collectRowState(row({ paidAt: new Date(), feeWaivedAt: new Date() }), false)).toBe("paid");
    expect(collectRowState(row({ feeWaivedAt: new Date() }), true)).toBe("free");
    expect(collectRowState(row(), true)).toBe("direct");
    expect(collectRowState(row(), false)).toBe("unpaid");
  });
});

describe("feeHeadcount: who the collector's fee question counts", () => {
  it("leaves out the collector, monthly regulars and free places; counts paid players (they paid this fee)", () => {
    const rows = [
      { userId: "col", ...row() },
      { userId: "a", ...row() },
      { userId: "b", ...row({ feeWaivedAt: new Date() }) },
      { userId: "c", ...row({ paymentMethod: "monthly" }) },
      { userId: "d", ...row({ paidAt: new Date() }) },
      { userId: "e", ...row({ status: "BENCH" }) },
    ];
    expect(feeHeadcount(rows, "col")).toEqual({ headcount: 2, freeCount: 1 });
    expect(feeHeadcount(rows, null)).toEqual({ headcount: 3, freeCount: 1 });
  });
});
