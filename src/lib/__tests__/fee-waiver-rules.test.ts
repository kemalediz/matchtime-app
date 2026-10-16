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
    expect(owesMatchFee({ userId: "a", feeWaivedAt: null, paymentMethod: MONTHLY_PAYMENT_METHOD }, null)).toBe(false);
  });
});

describe("isFeeWaived / owesMatchFee", () => {
  it("a waived row owes nothing; a paid row owes nothing; a monthly regular owes nothing per match", () => {
    expect(isFeeWaived({ feeWaivedAt: at("2026-10-16T18:00:00Z") })).toBe(true);
    expect(isFeeWaived({ feeWaivedAt: null })).toBe(false);
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

describe("pickWaiverMatch: which game an organiser means", () => {
  // London is BST (UTC+1) in October. Kickoffs 20:00 London = 19:00Z.
  const tue = { id: "tue", date: at("2026-10-13T19:00:00Z"), status: "COMPLETED" };
  const fri = { id: "fri", date: at("2026-10-16T19:00:00Z"), status: "COMPLETED" };
  const tue2 = { id: "tue2", date: at("2026-10-20T19:00:00Z"), status: "UPCOMING" };
  const fri2 = { id: "fri2", date: at("2026-10-23T19:00:00Z"), status: "UPCOMING" };
  const all = [tue, fri, tue2, fri2];
  const sat = at("2026-10-17T09:00:00Z"); // Saturday 10:00 London
  const wed = at("2026-10-14T09:00:00Z"); // Wednesday, between Tuesday's and Friday's games

  it("no day named: a game today wins, kicked off or not", () => {
    expect(pickWaiverMatch(all, at("2026-10-16T21:00:00Z"), null)?.id).toBe("fri");
    expect(pickWaiverMatch(all, at("2026-10-16T08:00:00Z"), null)?.id).toBe("fri");
  });
  it("no day named, no game today: the club's registration match (the next one), as every HQ squad command uses", () => {
    // Two games a week: on Wednesday the next game is Friday, not Tuesday's.
    const wedAll = [tue, { ...fri, status: "UPCOMING" }, tue2, fri2];
    expect(pickWaiverMatch(wedAll, wed, null)?.id).toBe("fri");
    expect(pickWaiverMatch(all, sat, null)?.id).toBe("tue2");
  });
  it("tonight / today / bu akşam: today's game", () => {
    const friMorning = at("2026-10-16T08:00:00Z");
    for (const p of ["tonight", "today", "bu akşam", "bugün"]) expect(pickWaiverMatch(all, friMorning, p)?.id).toBe("fri");
  });
  it("last night / yesterday / dün: yesterday's game", () => {
    for (const p of ["last night", "yesterday", "dün", "dün akşam"]) expect(pickWaiverMatch(all, sat, p)?.id).toBe("fri");
  });
  it("tomorrow / yarın", () => {
    const mon = at("2026-10-19T09:00:00Z");
    for (const p of ["tomorrow", "yarın"]) expect(pickWaiverMatch(all, mon, p)?.id).toBe("tue2");
  });
  it("a weekday: the nearer game on that day, back or ahead", () => {
    expect(pickWaiverMatch(all, sat, "Friday")?.id).toBe("fri"); // yesterday is nearer than next week
    expect(pickWaiverMatch(all, sat, "on Tuesday")?.id).toBe("tue2"); // 3 days ahead beats 4 back
    expect(pickWaiverMatch(all, sat, "cuma")?.id).toBe("fri");
    expect(pickWaiverMatch(all, sat, "Cuma günü")?.id).toBe("fri");
  });
  it("next / last weekday: only that direction", () => {
    expect(pickWaiverMatch(all, sat, "next Friday")?.id).toBe("fri2");
    expect(pickWaiverMatch(all, sat, "last Tuesday")?.id).toBe("tue");
    expect(pickWaiverMatch(all, sat, "gelecek cuma")?.id).toBe("fri2");
    expect(pickWaiverMatch(all, sat, "geçen salı")?.id).toBe("tue");
  });
  it("next week: the first game from next Monday", () => {
    expect(pickWaiverMatch(all, wed, "next week")?.id).toBe("tue2");
    expect(pickWaiverMatch(all, wed, "haftaya")?.id).toBe("tue2");
  });
  it("a named day with no game on it: null (the reply says so), never another game", () => {
    expect(pickWaiverMatch(all, sat, "Sunday")).toBeNull();
    expect(pickWaiverMatch(all, sat, "tomorrow")).toBeNull();
  });
  it("words it does not know, or 'this week': the default, never a guess from the words", () => {
    expect(pickWaiverMatch(all, sat, "this week")?.id).toBe("tue2");
    expect(pickWaiverMatch(all, sat, "bu hafta")?.id).toBe("tue2");
    expect(pickWaiverMatch(all, sat, "the derby")?.id).toBe("tue2");
  });
  it("cancelled games are never picked", () => {
    expect(pickWaiverMatch([{ ...fri, status: "CANCELLED" }, fri2], sat, "last night")).toBeNull();
  });
  it("nothing ahead and nothing today: the latest game of the last 48 hours, else null", () => {
    expect(pickWaiverMatch([tue, fri], sat, null)?.id).toBe("fri");
    expect(pickWaiverMatch([tue], sat, null)).toBeNull();
    expect(pickWaiverMatch([], sat, null)).toBeNull();
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
