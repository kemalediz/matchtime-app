/**
 * PR #464 review, round 2: a called-off game back on, for somebody who
 * said "paid" with no amount. What they paid is written down before their
 * amount goes up, so the difference shows as owed, in this month and in
 * the month a credit had come off. No database: an in-memory Prisma.
 */
import { describe, expect, it, vi } from "vitest";


// ── a tiny in-memory Prisma ────────────────────────────────────────────
type Row = Record<string, any>;
const store: Record<string, Row[]> = {};
const matchVal = (v: any, cond: any): boolean => {
  if (cond === undefined) return true;
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond === "object") {
    if ("in" in cond) return cond.in.includes(v);
    if ("not" in cond) return !matchVal(v, cond.not);
    if ("startsWith" in cond) return typeof v === "string" && v.startsWith(cond.startsWith);
    if ("gte" in cond || "lt" in cond) return (!cond.gte || v >= cond.gte) && (!cond.lt || v < cond.lt);
    return true; // relation filters: ignore
  }
  return v === cond;
};
const where = (r: Row, w: any = {}): boolean =>
  Object.entries(w).every(([k, c]) => {
    if (k === "monthId_userId") return r.monthId === (c as any).monthId && r.userId === (c as any).userId;
    if (k === "user" || k === "activity" || k === "attendances") return true;
    return matchVal(r[k], c);
  });
const model = (name: string) => ({
  findMany: async (a: any = {}) => (store[name] ?? []).filter((r) => where(r, a.where)).map((r) => ({ ...r })),
  findFirst: async (a: any = {}) => (store[name] ?? []).find((r) => where(r, a.where)) ?? null,
  findUnique: async (a: any = {}) => (store[name] ?? []).find((r) => where(r, a.where)) ?? null,
  create: async (a: any) => {
    const r = { id: `${name}-${(store[name] ??= []).length + 1}`, createdAt: new Date(), voidedAt: null, voidedById: null, appliedMonthId: null, createdById: null, ...a.data };
    store[name].push(r);
    return r;
  },
  update: async (a: any) => {
    const r = (store[name] ?? []).find((x) => where(x, a.where))!;
    Object.assign(r, a.data);
    return r;
  },
  updateMany: async (a: any) => {
    const rs = (store[name] ?? []).filter((x) => where(x, a.where));
    rs.forEach((r) => Object.assign(r, a.data));
    return { count: rs.length };
  },
  deleteMany: async (a: any) => {
    const before = (store[name] ?? []).length;
    store[name] = (store[name] ?? []).filter((x) => !where(x, a.where));
    return { count: before - store[name].length };
  },
});
const fake: any = {
  $executeRaw: async () => 0,
  $transaction: async (fn: any) => fn(fake),
  squadCredit: model("squadCredit"),
  sentNotification: model("sentNotification"),
  match: model("match"),
  squadMonth: model("squadMonth"),
  squadMonthMember: model("squadMonthMember"),
  membership: { findMany: async (a: any) => a.where.userId.in.map((userId: string) => ({ userId })) },
};
vi.mock("../db", () => ({ db: fake }));
vi.mock("@/lib/db", () => ({ db: fake }));

const { reconcileCancelledWeeks } = await import("../month-close");
const { paidBalancePence } = await import("../month-close-rules");

const nov = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"].map((d) => new Date(`${d}T20:00:00Z`));
const fixture = { orgId: "o", venue: "V", dayOfWeek: 1 };

function seed(opts: { appliedMonthId: string }) {
  for (const k of Object.keys(store)) delete store[k];
  store.match = nov.map((date, i) => ({ id: `w${i + 1}`, date, status: "SCHEDULED", updatedAt: date }));
  store.squadMonth = [
    { id: "m", orgId: "o", status: "open", sharePerGamePence: 500, concessionPerGamePence: null },
    { id: "m-dec", orgId: "o", status: "open", sharePerGamePence: 500, concessionPerGamePence: null },
  ];
  // Four games at £5. Week 2 was called off: £5 came off (or off December),
  // then he said "paid" on WhatsApp with no amount, i.e. he paid £15 (or Dec's £15).
  store.squadMonthMember = [
    { id: "r1", monthId: opts.appliedMonthId, userId: "u1", kind: "regular", tier: "standard", leftAt: null, joinedAt: new Date("2026-10-20T00:00:00Z"), source: "seed-list", paidAt: null, paidClaimedAt: new Date("2026-11-05T10:00:00Z"), paidAmountPence: null, paidClaimedAmountPence: null, gamesCovered: 4, gamesCommitted: null, creditsApplied: 1, amountDuePence: 1500 },
  ];
  if (opts.appliedMonthId !== "m") store.squadMonthMember.unshift({ id: "r0", monthId: "m", userId: "u1", kind: "regular", tier: "standard", leftAt: null, joinedAt: new Date("2026-10-20T00:00:00Z"), source: "seed-list", paidAt: new Date("2026-11-01T00:00:00Z"), paidClaimedAt: null, paidAmountPence: 2000, paidClaimedAmountPence: null, gamesCovered: 4, gamesCommitted: null, creditsApplied: 0, amountDuePence: 2000 });
  store.squadCredit = [
    { id: "c1", orgId: "o", userId: "u1", reason: "cancelled-week", earnedMonthId: "m", earnedMatchId: "w2", voidedAt: null, voidedById: null, appliedMonthId: opts.appliedMonthId, createdById: null },
  ];
  // "called off at" record exists; week 2 is now on again.
  store.sentNotification = [];
  return {
    id: "m", orgId: "o", activityId: "a", monthStart: "2026-11-01", status: "open", startsAt: new Date("2026-11-01T00:00:00Z"),
    gamesPlayedBeforeStart: 0, sharePerGamePence: 500, concessionPerGamePence: null, pricedAt: new Date("2026-10-28T00:00:00Z"),
    closedAt: null, language: null, fixture, matches: store.match.map((m) => ({ ...m })), games: [], lastKickoff: nov[3], members: [],
  } as never;
}

const balanceOf = (r: Row) =>
  paidBalancePence({ paid: r.paidAt ? "confirmed" : r.paidClaimedAt ? "claimed" : "none", amountDuePence: r.amountDuePence, paidPence: r.paidAt ? r.paidAmountPence : r.paidClaimedAmountPence, refundedPence: 0 });

describe("restore path: a called-off game back on, for somebody who said 'paid' with no amount", () => {
  it("same month: he paid £15, is now asked £20, and must show as owing £5", async () => {
    const month = seed({ appliedMonthId: "m" });
    await reconcileCancelledWeeks("o", new Date("2026-11-06T10:00:00Z"), [month]);
    const r = store.squadMonthMember[0];
    expect(store.squadCredit[0].voidedAt).not.toBeNull();
    expect(r.amountDuePence).toBe(2000);
    expect(balanceOf(r)).toBe(500);
  });

  it("credit spent on another month (releaseSpentCredit): same loss there", async () => {
    const month = seed({ appliedMonthId: "m-dec" });
    // u1 is a member of m-dec in this setup; November has no row for him (fine: plan only needs the credit).
    await reconcileCancelledWeeks("o", new Date("2026-11-06T10:00:00Z"), [month]);
    const r = store.squadMonthMember.find((x) => x.monthId === "m-dec")!;
    expect(store.squadCredit[0].voidedAt).not.toBeNull();
    expect(r.amountDuePence).toBe(2000);
    expect(balanceOf(r)).toBe(500);
  });

  it("idempotent: a second sweep does not void twice or decrement twice", async () => {
    const month = seed({ appliedMonthId: "m" });
    await reconcileCancelledWeeks("o", new Date("2026-11-06T10:00:00Z"), [month]);
    await reconcileCancelledWeeks("o", new Date("2026-11-06T11:00:00Z"), [month]);
    expect(store.squadMonthMember[0].creditsApplied).toBe(0);
    expect(store.squadMonthMember[0].amountDuePence).toBe(2000);
  });
});
