/* eslint-disable @typescript-eslint/no-explicit-any -- an in-memory Prisma fake, as month-restore-paid.test.ts */
/**
 * THE CLOSE PATH'S CANCELLED-WEEK CREDITS FOR A WHOLE-MONTH LATE JOINER
 * (review of #611, round 2, item 6: bypassing `creditsCountFrom` in
 * month-close.ts passed every unit test; only a Playwright spec caught it).
 *
 * The reviewers' fixture: £7.50, five Mondays (2, 9, 16, 23, 30), now 14
 * Nov, the 23rd called off on 12 Nov. Two regulars joined on 13 Nov, after
 * it was called off: one covers the whole month (he paid it, as the seeded
 * regulars did), one only his games left. `reconcileCancelledWeeks` runs
 * for real against an in-memory Prisma.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    if ("gte" in cond || "lt" in cond || "lte" in cond) return (!cond.gte || v >= cond.gte) && (!cond.lt || v < cond.lt) && (!cond.lte || v <= cond.lte);
    return true; // relation filters: ignore
  }
  return v === cond;
};
const where = (r: Row, w: any = {}): boolean =>
  Object.entries(w).every(([k, c]) => {
    if (k === "monthId_userId") return r.monthId === (c as any).monthId && r.userId === (c as any).userId;
    if (k === "user" || k === "activity" || k === "attendances" || k === "OR" || k === "AND") return true;
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

const MONDAYS = [2, 9, 16, 23, 30].map((d) => new Date(Date.UTC(2026, 10, d, 20, 30)));
const NOW = new Date("2026-11-14T12:00:00Z");
const CALLED_OFF = new Date("2026-11-12T09:00:00Z");
const JOINED = new Date("2026-11-13T10:00:00Z");

function seed() {
  for (const k of Object.keys(store)) delete store[k];
  store.match = MONDAYS.map((date, i) => ({ id: `w${i + 1}`, date, status: i === 3 ? "CANCELLED" : "SCHEDULED", updatedAt: i === 3 ? CALLED_OFF : date }));
  store.squadMonth = [
    {
      id: "m",
      orgId: "o",
      status: "running",
      gamesScheduled: 5,
      sharePerGamePence: 750,
      concessionPerGamePence: null,
      startedMidMonthAt: new Date("2026-11-01T09:00:00Z"),
      listOpenedAt: null,
      createdAt: new Date("2026-11-01T09:00:00Z"),
    },
  ];
  const row = (id: string, userId: string, gamesCovered: number) => ({
    id,
    monthId: "m",
    userId,
    kind: "regular",
    tier: "standard",
    leftAt: null,
    joinedAt: JOINED,
    source: "admin",
    paidAt: null,
    paidClaimedAt: JOINED,
    paidAmountPence: null,
    paidClaimedAmountPence: null,
    gamesCovered,
    gamesCommitted: null,
    creditsApplied: 0,
    amountDuePence: 750 * gamesCovered,
  });
  store.squadMonthMember = [row("r-whole", "u-whole", 5), row("r-left", "u-left", 2)];
  store.squadCredit = [];
  store.sentNotification = [];
  return {
    id: "m", orgId: "o", activityId: "a", monthStart: "2026-11-01", status: "running", startsAt: new Date("2026-11-01T09:00:00Z"),
    gamesPlayedBeforeStart: 0, sharePerGamePence: 750, concessionPerGamePence: null, pricedAt: new Date("2026-11-01T09:00:00Z"),
    closedAt: null, language: null, fixture: { orgId: "o", venue: "V", dayOfWeek: 1 }, matches: store.match.map((m) => ({ ...m })), games: [], lastKickoff: MONDAYS[4], members: [],
  } as never;
}

const creditsOf = (userId: string) => store.squadCredit.filter((c) => c.userId === userId && c.reason === "cancelled-week" && c.voidedAt === null);

describe("the close path: cancelled-week credits by creditsCountFrom", () => {
  beforeEach(() => undefined);

  it("a late joiner on the whole month is credited for the week called off before he joined, as a seeded regular is", async () => {
    await reconcileCancelledWeeks("o", NOW, [seed()]);
    expect(creditsOf("u-whole")).toEqual([expect.objectContaining({ earnedMatchId: "w4", earnedMonthId: "m" })]);
  });

  it("a late joiner for the games left is not: the week was not one he was charged for", async () => {
    await reconcileCancelledWeeks("o", NOW, [seed()]);
    expect(creditsOf("u-left")).toEqual([]);
  });

  it("he says he paid: the credit is kept for a later month, his amount unchanged", async () => {
    await reconcileCancelledWeeks("o", NOW, [seed()]);
    expect(creditsOf("u-whole")[0].appliedMonthId ?? null).toBeNull();
    expect(store.squadMonthMember.find((r) => r.userId === "u-whole")).toMatchObject({ creditsApplied: 0, amountDuePence: 3750 });
  });
});
