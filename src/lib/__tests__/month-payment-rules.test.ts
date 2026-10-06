/**
 * Monthly squad, slice 4: the price, the payments and the reminders
 * (MDs/monthly-squad-plan-2026-10-05.md, sections 4.2 and 4.3). The pure
 * rules: the suggestion, the pay-by default, each regular's amount with
 * credits, the price lock, the words of a "paid" message and of the
 * collector's reply, and when each reminder is due. No database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  claimsDigestDue,
  decideCollectorReply,
  defaultPayBy,
  duePaymentReminder,
  groupReminderDue,
  monthFeeShare,
  planPricing,
  priceLocked,
  readCollectorReply,
  readPaidMessage,
  suggestSharePence,
  validatePricing,
  type PricingMember,
} from "@/lib/month-payment-rules";

const regular = (o: Partial<PricingMember> & { userId: string }): PricingMember => ({
  kind: "regular",
  tier: "standard",
  waiting: false,
  out: false,
  gamesCovered: 5,
  creditsApplied: 0,
  paid: "none",
  ...o,
});

describe("the suggestion", () => {
  it("venue cost per game over the regulars, rounded UP to the next 50p", () => {
    expect(suggestSharePence(9000, 12)).toBe(750);
    expect(suggestSharePence(9000, 13)).toBe(700); // 692.3
    expect(suggestSharePence(9000, 14)).toBe(650); // 642.9
    expect(suggestSharePence(7000, 14)).toBe(500);
  });
  it("nothing to suggest without a cost or without regulars", () => {
    expect(suggestSharePence(null, 12)).toBeNull();
    expect(suggestSharePence(9000, 0)).toBeNull();
  });
});

describe("the pay-by default", () => {
  it("three days before the first game, at 21:00 London: 'by Friday' for a Monday game", () => {
    expect(defaultPayBy(new Date("2026-11-02T20:00:00.000Z"), new Date("2026-10-27T10:00:00.000Z")).toISOString()).toBe("2026-10-30T21:00:00.000Z");
  });
  it("for a month already under way: three days from now, at 21:00", () => {
    expect(defaultPayBy(new Date("2026-10-05T19:00:00.000Z"), new Date("2026-10-06T09:00:00.000Z")).toISOString()).toBe("2026-10-09T20:00:00.000Z");
  });
});

describe("the club fee, in month terms", () => {
  it("the fee over every regular's games, rounded up to 5p a game", () => {
    // £9.99 over 12 regulars x 5 games = 16.65p: 20p a game, £1.00 for the month.
    expect(monthFeeShare({ pricePence: 999, regulars: 12, games: 5 })).toEqual({ perGamePence: 20, perMonthPence: 100 });
    expect(monthFeeShare({ pricePence: 999, regulars: 14, games: 4 })).toEqual({ perGamePence: 20, perMonthPence: 80 });
  });
  it("nothing without a fee, regulars or games", () => {
    expect(monthFeeShare({ pricePence: null, regulars: 12, games: 5 })).toBeNull();
    expect(monthFeeShare({ pricePence: 999, regulars: 0, games: 5 })).toBeNull();
  });
});

describe("validating a price", () => {
  const now = new Date("2026-10-27T10:00:00.000Z");
  const ok = { sharePence: 750, concessionPence: null, venueCostPence: null, payByAt: new Date("2026-10-30T21:00:00.000Z") };
  it("accepts a share and a pay-by date ahead", () => {
    expect(validatePricing(ok, now)).toEqual({ ok: true });
  });
  it("refuses a share that is not a price, a concession above the share, and a pay-by date that has passed", () => {
    expect(validatePricing({ ...ok, sharePence: 0 }, now)).toEqual({ ok: false, error: "bad-share" });
    expect(validatePricing({ ...ok, sharePence: 10_001 }, now)).toEqual({ ok: false, error: "bad-share" });
    expect(validatePricing({ ...ok, sharePence: 7.5 }, now)).toEqual({ ok: false, error: "bad-share" });
    expect(validatePricing({ ...ok, concessionPence: 800 }, now)).toEqual({ ok: false, error: "bad-concession" });
    expect(validatePricing({ ...ok, venueCostPence: -1 }, now)).toEqual({ ok: false, error: "bad-venue" });
    expect(validatePricing({ ...ok, payByAt: new Date("2026-10-27T09:00:00.000Z") }, now)).toEqual({ ok: false, error: "bad-pay-by" });
    expect(validatePricing({ ...ok, payByAt: new Date("nope") }, now)).toEqual({ ok: false, error: "bad-pay-by" });
  });
});

describe("each regular's amount (the table in plan 4.2)", () => {
  const credit = (id: string, userId: string, day: number) => ({ id, userId, createdAt: new Date(`2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`) });
  const members = [
    regular({ userId: "alex" }),
    regular({ userId: "bilal" }),
    regular({ userId: "away" }),
    regular({ userId: "carl", tier: "concession" }),
    regular({ userId: "dev", gamesCovered: 3 }),
    regular({ userId: "omar", kind: "payg", gamesCovered: 0 }),
    regular({ userId: "eve", kind: "payg", waiting: true, gamesCovered: 0 }),
    regular({ userId: "gone", out: true }),
  ];
  const credits = [credit("c1", "bilal", 13), credit("c2", "away", 20), credit("c3", "away", 13), credit("c4", "omar", 13), credit("c5", "gone", 13)];
  const plan = planPricing({ members, credits, sharePence: 750, concessionPence: 500 });
  const of = (userId: string) => plan.find((r) => r.userId === userId);

  it("standard, no credit: 5 x £7.50 = £37.50", () => {
    expect(of("alex")).toEqual({ userId: "alex", creditIds: [], creditsApplied: 0, amountDuePence: 3750 });
  });
  it("one game of credit: £30.00", () => {
    expect(of("bilal")).toEqual({ userId: "bilal", creditIds: ["c1"], creditsApplied: 1, amountDuePence: 3000 });
  });
  it("away two weeks last month: £22.50, the oldest credit first", () => {
    expect(of("away")).toEqual({ userId: "away", creditIds: ["c3", "c2"], creditsApplied: 2, amountDuePence: 2250 });
  });
  it("concession at £5.00: £25.00", () => {
    expect(of("carl")?.amountDuePence).toBe(2500);
  });
  it("joined from the third game: 3 x £7.50 = £22.50", () => {
    expect(of("dev")?.amountDuePence).toBe(2250);
  });
  it("PAYG players, people waiting and people off the month owe nothing for it, and their credits are left alone", () => {
    expect(of("omar")).toBeUndefined();
    expect(of("eve")).toBeUndefined();
    expect(of("gone")).toBeUndefined();
    expect(plan.flatMap((r) => r.creditIds)).not.toContain("c4");
    expect(plan.flatMap((r) => r.creditIds)).not.toContain("c5");
  });

  it("credits never take an amount below zero: the surplus stays in the ledger", () => {
    const rows = planPricing({
      members: [regular({ userId: "sam", gamesCovered: 2 })],
      credits: [credit("a", "sam", 1), credit("b", "sam", 2), credit("c", "sam", 3)],
      sharePence: 750,
      concessionPence: null,
    });
    expect(rows).toEqual([{ userId: "sam", creditIds: ["a", "b"], creditsApplied: 2, amountDuePence: 0 }]);
  });

  it("credits already used against this month stay counted, and pricing again takes no credit twice", () => {
    const rows = planPricing({
      members: [regular({ userId: "sam", creditsApplied: 1 })],
      credits: [credit("new", "sam", 20)],
      sharePence: 750,
      concessionPence: null,
    });
    expect(rows).toEqual([{ userId: "sam", creditIds: ["new"], creditsApplied: 2, amountDuePence: 2250 }]);
  });

  it("a concession with no concession price pays the standard share", () => {
    expect(planPricing({ members: [regular({ userId: "carl", tier: "concession" })], credits: [], sharePence: 750, concessionPence: null })[0].amountDuePence).toBe(3750);
  });

  it("a regular who has already paid is not re-priced, and takes no more credits", () => {
    const rows = planPricing({
      members: [regular({ userId: "paid", paid: "confirmed" }), regular({ userId: "says", paid: "claimed" })],
      credits: [credit("x", "paid", 1), credit("y", "says", 1)],
      sharePence: 800,
      concessionPence: null,
    });
    expect(rows).toEqual([]);
  });
});

describe("the price lock", () => {
  it("locked once anybody has paid or says so", () => {
    expect(priceLocked([regular({ userId: "a" }), regular({ userId: "b" })])).toBe(false);
    expect(priceLocked([regular({ userId: "a" }), regular({ userId: "b", paid: "claimed" })])).toBe(true);
    expect(priceLocked([regular({ userId: "a", paid: "confirmed" })])).toBe(true);
  });
  it("somebody taken off the month does not lock it", () => {
    expect(priceLocked([regular({ userId: "a", paid: "confirmed", out: true })])).toBe(false);
  });
});

describe("a player's 'paid' message", () => {
  it("English and Turkish, with or without an amount", () => {
    for (const t of ["paid", "Paid 👍", "I've paid", "ive paid", "I have paid", "all paid", "paid now", "payment sent", "sent", "transferred", "ödedim", "Ödeme yaptım", "gönderdim", "havale yaptım"]) {
      expect(readPaidMessage(t), t).toEqual({ amountPence: null });
    }
    expect(readPaidMessage("paid £37.50")).toEqual({ amountPence: 3750 });
    expect(readPaidMessage("Paid 30")).toEqual({ amountPence: 3000 });
    expect(readPaidMessage("ödedim 37.50")).toEqual({ amountPence: 3750 });
  });
  it("anything else is not a claim", () => {
    for (const t of ["ok", "not paid yet", "have I paid?", "paid for Tom too", "I'll pay tomorrow", "paid?", "who has paid", "unpaid", "", "ödemedim", "yes"]) {
      expect(readPaidMessage(t), t).toBeNull();
    }
  });
});

describe("the collector's reply to the claims digest", () => {
  it("PAID ALL, PAID NONE, PAID and the list numbers", () => {
    expect(readCollectorReply("PAID ALL")).toEqual({ kind: "all" });
    expect(readCollectorReply("paid all 👍")).toEqual({ kind: "all" });
    expect(readCollectorReply("Paid none")).toEqual({ kind: "none" });
    expect(readCollectorReply("PAID 1 3")).toEqual({ kind: "numbers", numbers: [1, 3] });
    expect(readCollectorReply("paid 1, 3 and 7")).toEqual({ kind: "numbers", numbers: [1, 3, 7] });
    expect(readCollectorReply("ÖDENDİ HEPSİ")).toEqual({ kind: "all" });
    expect(readCollectorReply("ödendi hiçbiri")).toEqual({ kind: "none" });
    expect(readCollectorReply("Ödendi 2 ve 5")).toEqual({ kind: "numbers", numbers: [2, 5] });
  });
  it("NEVER a stray word: ok, yes, all, a bare number, a thumbs up", () => {
    for (const t of ["ok", "OK thanks", "yes", "all", "ALL", "1 3", "2", "👍", "paid", "all paid", "paid?", "none", "paid all of them I think", "paid 0", "paid 1 and maybe 3", ""]) {
      expect(readCollectorReply(t), t).toBeNull();
    }
  });

  const digestAt = new Date("2026-10-28T10:00:00.000Z");
  const claims = [
    { userId: "alex", slot: 1, claimedAt: new Date("2026-10-27T18:00:00.000Z") },
    { userId: "bilal", slot: 2, claimedAt: new Date("2026-10-28T09:00:00.000Z") },
    { userId: "late", slot: 7, claimedAt: new Date("2026-10-28T11:00:00.000Z") },
  ];
  const base = { claims, digestAt, now: new Date("2026-10-28T12:00:00.000Z") };

  it("ALL confirms what the digest showed, never a claim made after it", () => {
    expect(decideCollectorReply({ ...base, reply: { kind: "all" } })).toEqual({ kind: "confirm", userIds: ["alex", "bilal"] });
  });
  it("numbers confirm exactly those, by list number", () => {
    expect(decideCollectorReply({ ...base, reply: { kind: "numbers", numbers: [2] } })).toEqual({ kind: "confirm", userIds: ["bilal"] });
  });
  it("a number that is not a claim the digest showed confirms NOTHING", () => {
    expect(decideCollectorReply({ ...base, reply: { kind: "numbers", numbers: [1, 9] } })).toEqual({ kind: "unknown-numbers", numbers: [9] });
    expect(decideCollectorReply({ ...base, reply: { kind: "numbers", numbers: [7] } })).toEqual({ kind: "unknown-numbers", numbers: [7] });
  });
  it("NONE is recorded against what the digest showed", () => {
    expect(decideCollectorReply({ ...base, reply: { kind: "none" } })).toEqual({ kind: "decline", userIds: ["alex", "bilal"] });
  });
  it("with no digest sent, or one older than two days, nothing is done", () => {
    expect(decideCollectorReply({ ...base, digestAt: null, reply: { kind: "all" } })).toEqual({ kind: "no-digest" });
    expect(decideCollectorReply({ ...base, now: new Date("2026-10-30T10:00:01.000Z"), reply: { kind: "all" } })).toEqual({ kind: "no-digest" });
  });
  it("nothing waiting: nothing is done", () => {
    expect(decideCollectorReply({ ...base, claims: [], reply: { kind: "all" } })).toEqual({ kind: "nothing-waiting" });
  });
});

describe("when each reminder is due", () => {
  /** Fri 30 Oct 2026, 21:00 London (GMT). */
  const payByAt = new Date("2026-10-30T21:00:00.000Z");
  const at = (iso: string) => new Date(iso);
  const none = { r1At: null, r2At: null, lateDays: [] as string[] };

  it("nothing before the last 24 hours", () => {
    expect(duePaymentReminder({ now: at("2026-10-29T20:59:00.000Z"), payByAt, sent: none })).toBeNull();
  });
  it("the first DM from 24 hours before, in waking hours", () => {
    expect(duePaymentReminder({ now: at("2026-10-29T21:00:00.000Z"), payByAt, sent: none })).toBe("r1");
    // 22:30 London: held until the morning.
    expect(duePaymentReminder({ now: at("2026-10-29T22:30:00.000Z"), payByAt, sent: none })).toBeNull();
    expect(duePaymentReminder({ now: at("2026-10-30T08:00:00.000Z"), payByAt, sent: none })).toBe("r1");
  });
  it("the second on the deadline morning, never within six hours of the first", () => {
    const sent = { ...none, r1At: at("2026-10-29T21:01:00.000Z") };
    expect(duePaymentReminder({ now: at("2026-10-29T21:30:00.000Z"), payByAt, sent })).toBeNull();
    expect(duePaymentReminder({ now: at("2026-10-30T08:00:00.000Z"), payByAt, sent })).toBe("r2");
    // The first only went out this morning: no second one on its heels.
    expect(duePaymentReminder({ now: at("2026-10-30T09:00:00.000Z"), payByAt, sent: { ...none, r1At: at("2026-10-30T08:00:00.000Z") } })).toBeNull();
    expect(duePaymentReminder({ now: at("2026-10-30T14:00:00.000Z"), payByAt, sent: { ...none, r1At: at("2026-10-30T08:00:00.000Z") } })).toBe("r2");
  });
  it("nothing more before the deadline once both have gone", () => {
    const sent = { ...none, r1At: at("2026-10-29T21:01:00.000Z"), r2At: at("2026-10-30T08:00:00.000Z") };
    expect(duePaymentReminder({ now: at("2026-10-30T18:00:00.000Z"), payByAt, sent })).toBeNull();
  });
  it("after the deadline: once a day for three days, then silence", () => {
    const sent = { ...none, r1At: at("2026-10-29T21:01:00.000Z"), r2At: at("2026-10-30T08:00:00.000Z") };
    // The deadline evening itself: nothing more today.
    expect(duePaymentReminder({ now: at("2026-10-30T21:30:00.000Z"), payByAt, sent })).toBeNull();
    expect(duePaymentReminder({ now: at("2026-10-31T10:00:00.000Z"), payByAt, sent })).toBe("late");
    expect(duePaymentReminder({ now: at("2026-10-31T15:00:00.000Z"), payByAt, sent: { ...sent, lateDays: ["2026-10-31"] } })).toBeNull();
    expect(duePaymentReminder({ now: at("2026-11-01T10:00:00.000Z"), payByAt, sent: { ...sent, lateDays: ["2026-10-31"] } })).toBe("late");
    expect(duePaymentReminder({ now: at("2026-11-02T10:00:00.000Z"), payByAt, sent: { ...sent, lateDays: ["2026-10-31", "2026-11-01"] } })).toBe("late");
    expect(duePaymentReminder({ now: at("2026-11-03T10:00:00.000Z"), payByAt, sent: { ...sent, lateDays: ["2026-10-31", "2026-11-01", "2026-11-02"] } })).toBeNull();
    // Day four, even if a day was missed: silent.
    expect(duePaymentReminder({ now: at("2026-11-03T10:00:00.000Z"), payByAt, sent: { ...sent, lateDays: [] } })).toBeNull();
  });

  it("the group's count: once, in the last 24 hours, in waking hours, with somebody still to pay", () => {
    const g = (iso: string, o: Partial<{ sent: boolean; unpaid: number }> = {}) =>
      groupReminderDue({ now: at(iso), payByAt, sent: o.sent ?? false, unpaid: o.unpaid ?? 4 });
    expect(g("2026-10-29T20:00:00.000Z")).toBe(false);
    expect(g("2026-10-29T21:00:00.000Z")).toBe(true);
    expect(g("2026-10-29T23:00:00.000Z")).toBe(false);
    expect(g("2026-10-30T09:00:00.000Z")).toBe(true);
    expect(g("2026-10-30T09:00:00.000Z", { sent: true })).toBe(false);
    expect(g("2026-10-30T09:00:00.000Z", { unpaid: 0 })).toBe(false);
    expect(g("2026-10-30T21:00:00.000Z")).toBe(false);
  });

  it("the claims digest: once a London day, from 10:00, while a claim is waiting", () => {
    const d = (iso: string, o: Partial<{ sentToday: boolean; waiting: number }> = {}) =>
      claimsDigestDue({ now: at(iso), sentToday: o.sentToday ?? false, waiting: o.waiting ?? 2 });
    expect(d("2026-10-28T09:59:00.000Z")).toBe(false);
    expect(d("2026-10-28T10:00:00.000Z")).toBe(true);
    expect(d("2026-10-28T10:00:00.000Z", { sentToday: true })).toBe(false);
    expect(d("2026-10-28T10:00:00.000Z", { waiting: 0 })).toBe(false);
    expect(d("2026-10-28T22:10:00.000Z")).toBe(false);
  });
});
