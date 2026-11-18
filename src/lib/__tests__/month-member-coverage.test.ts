/**
 * THE COVERAGE EDITOR'S WRITE (2026-11-16, and the review of PR #611): an
 * organiser sets how many of the month's games a regular covers. Coverage
 * only changes the future: never fewer than what he played since he
 * joined plus the games left. What they owe follows with the existing
 * pricing (`settleMemberAmount` when unpaid, `amountDuePence` when they
 * paid or say so); a payment is never recorded. Database mocked; real
 * dates: November 2026, five Mondays, a regular who joined on the 6th,
 * edited on the 24th (three games played since he joined, one left).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  monthFind: vi.fn(),
  rowFind: vi.fn(),
  rowUpdate: vi.fn(async () => ({})),
  loadSignupMonth: vi.fn(),
  lockMonth: vi.fn(async () => undefined),
  settleMemberAmount: vi.fn(async () => undefined),
  afterMemberGamesChanged: vi.fn(async () => undefined),
  creditFind: vi.fn(async (): Promise<Array<{ userId: string }>> => []),
  creditCount: vi.fn(async () => 0),
}));

vi.mock("@/lib/db", () => {
  const client = {
    squadMonth: { findUnique: (...a: unknown[]) => m.monthFind(...a) },
    squadMonthMember: { findUnique: (...a: unknown[]) => m.rowFind(...a), update: (...a: unknown[]) => m.rowUpdate(...(a as [])) },
    squadCredit: { findMany: (...a: unknown[]) => m.creditFind(...(a as [])), count: (...a: unknown[]) => m.creditCount(...(a as [])) },
  };
  return { db: { ...client, $transaction: (fn: (tx: unknown) => unknown) => fn(client) } };
});
vi.mock("@/lib/month-signup", () => ({ loadSignupMonth: m.loadSignupMonth, lockMonth: m.lockMonth, hasStarted: () => true }));
vi.mock("@/lib/month-payment", () => ({ settleMemberAmount: m.settleMemberAmount }));
vi.mock("@/lib/month-member-games", () => ({ afterMemberGamesChanged: m.afterMemberGamesChanged }));

import { checkMonthMemberCoverage, loadCoverageView, setMonthMemberCoverage } from "@/lib/month-member-coverage";

const NOW = new Date("2026-11-24T12:00:00Z");
const KICKOFFS = [2, 9, 16, 23, 30].map((d) => new Date(Date.UTC(2026, 10, d, 20, 30)));
const JOINED = new Date("2026-11-06T18:00:00Z");
const MONTH = { id: "mo1", orgId: "org1", status: "running", firstKickoff: KICKOFFS[0], startedMidMonth: false, kickoffs: KICKOFFS };
// Joined on the 6th for the 4 games left then, priced at £7.50.
const ROW = {
  id: "row1",
  kind: "regular",
  tier: "standard",
  leftAt: null,
  joinedAt: JOINED,
  source: "admin",
  gamesCovered: 4,
  gamesCommitted: null,
  creditsApplied: 0,
  amountDuePence: 3000,
  paidAt: null,
  paidAmountPence: null,
  paidClaimedAt: null,
  paidClaimedAmountPence: null,
};
const money = (over: Record<string, unknown> = {}) => ({
  orgId: "org1",
  status: "running",
  gamesScheduled: 5,
  monthStart: new Date("2026-11-01T00:00:00Z"),
  sharePerGamePence: 750,
  concessionPerGamePence: 500,
  activity: { dayOfWeek: 1, time: "20:30" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.loadSignupMonth.mockResolvedValue(MONTH);
  m.monthFind.mockResolvedValue(money());
  m.rowFind.mockResolvedValue(ROW);
  m.creditFind.mockResolvedValue([]);
  m.creditCount.mockResolvedValue(0);
});

const update = () => (m.rowUpdate.mock.calls[0] as unknown as [{ where: unknown; data: Record<string, unknown> }])[0];
const set = (coverage: "whole" | "left" | number) => setMonthMemberCoverage({ squadMonthId: "mo1", userId: "u1", coverage, now: NOW });

describe("the bounds (review item 1: coverage only changes the future)", () => {
  it("THE BUG: on the 24th he cannot be cut to 1 game, nor below the 4 he joined for", async () => {
    expect(await set(1)).toEqual({ ok: false, error: "below-games-left", bounds: { min: 4, max: 5 } });
    expect(await set(3)).toMatchObject({ ok: false, error: "below-games-left" });
    expect(m.rowUpdate).not.toHaveBeenCalled();
    expect(m.settleMemberAmount).not.toHaveBeenCalled();
  });

  it("'the games left' for him is what he joined for: nothing changes", async () => {
    expect(await set("left")).toMatchObject({ ok: true, changed: false, gamesCovered: 4 });
    expect(m.rowUpdate).not.toHaveBeenCalled();
  });

  it("the page's editor offers the same bounds, per member", async () => {
    m.monthFind.mockResolvedValue({ ...money(), members: [{ userId: "u1", joinedAt: JOINED, source: "admin", gamesCovered: 4 }, { userId: "u2", joinedAt: JOINED, source: "seed-list", gamesCovered: 5 }] });
    const v = await loadCoverageView("mo1", NOW);
    expect(v?.month).toEqual({ gamesLeft: 1, whole: 5, playable: 5 });
    expect(v?.members.get("u1")).toEqual({ min: 4, max: 5, gamesCovered: 4, creditedCancelled: 0 });
    expect(v?.members.get("u2")).toEqual({ min: 5, max: 5, gamesCovered: 5, creditedCancelled: 0 });
  });

  it("a cancelled week: playable games are the whole month less it", async () => {
    m.loadSignupMonth.mockResolvedValue({ ...MONTH, kickoffs: KICKOFFS.filter((_, i) => i !== 1) });
    m.monthFind.mockResolvedValue({ ...money(), members: [] });
    expect((await loadCoverageView("mo1", NOW))?.month).toEqual({ gamesLeft: 1, whole: 5, playable: 4 });
  });
});

describe("the money", () => {
  it("raises an unpaid late joiner to the whole month; what he owes is priced again by settleMemberAmount", async () => {
    expect(await set("whole")).toMatchObject({ ok: true, changed: true, gamesCovered: 5, bounds: { min: 4, max: 5 } });
    expect(m.lockMonth).toHaveBeenCalled();
    expect(update().data).toEqual({ gamesCovered: 5, gamesCommitted: null });
    expect(m.settleMemberAmount).toHaveBeenCalledWith("mo1", "u1", NOW);
    expect(m.afterMemberGamesChanged).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org1", monthId: "mo1", userId: "u1" }));
  });

  it("ROUND 4, item 1: one who says paid with no amount: what he said he paid is kept (the old amount), the amount due follows the new games", async () => {
    m.rowFind.mockResolvedValue({ ...ROW, paidClaimedAt: NOW });
    await set("whole");
    // He said he paid the £30 he was asked; now asked £37.50: owes £7.50 more.
    expect(update().data).toEqual({ paidClaimedAmountPence: 3000, gamesCovered: 5, gamesCommitted: null, amountDuePence: 5 * 750 });
    expect(update().data).not.toHaveProperty("paidAt");
    expect(update().data).not.toHaveProperty("paidAmountPence");
    expect(m.settleMemberAmount).not.toHaveBeenCalled();
  });

  it("ROUND 4, item 1: an amount already kept is never overwritten", async () => {
    m.rowFind.mockResolvedValue({ ...ROW, paidClaimedAt: NOW, paidClaimedAmountPence: 1500 });
    await set("whole");
    expect(update().data).toEqual({ gamesCovered: 5, gamesCommitted: null, amountDuePence: 5 * 750 });
  });

  it("ROUND 4, item 2: the organiser's words say his claim is for THIS coverage: no old amount is kept", async () => {
    m.rowFind.mockResolvedValue({ ...ROW, paidClaimedAt: NOW });
    await setMonthMemberCoverage({ squadMonthId: "mo1", userId: "u1", coverage: "whole", claimCovers: true, now: NOW });
    expect(update().data).toEqual({ gamesCovered: 5, gamesCommitted: null, amountDuePence: 5 * 750 });
  });

  it("ROUND 4, item 2: claimCovers never touches a confirmed payment: its amount is kept", async () => {
    m.rowFind.mockResolvedValue({ ...ROW, paidAt: NOW });
    await setMonthMemberCoverage({ squadMonthId: "mo1", userId: "u1", coverage: "whole", claimCovers: true, now: NOW });
    expect(update().data).toEqual({ paidAmountPence: 3000, gamesCovered: 5, gamesCommitted: null, amountDuePence: 5 * 750 });
  });

  it("a confirmed payment keeps what was paid; only the amount due moves (the page shows the difference)", async () => {
    m.rowFind.mockResolvedValue({ ...ROW, gamesCovered: 5, amountDuePence: 3750, paidAt: NOW, creditsApplied: 1 });
    await set("left");
    // Confirmed before an amount was written: the £37.50 asked is what he paid.
    expect(update().data).toEqual({ paidAmountPence: 3750, gamesCovered: 4, gamesCommitted: null, amountDuePence: (4 - 1) * 750 });
  });

  it("a concession pays the concession share", async () => {
    m.rowFind.mockResolvedValue({ ...ROW, tier: "concession", paidClaimedAt: NOW });
    await set(5);
    expect(update().data).toMatchObject({ gamesCovered: 5, amountDuePence: 5 * 500 });
  });

  it("a month with no price yet: the games change, no amount is written", async () => {
    m.monthFind.mockResolvedValue(money({ sharePerGamePence: null }));
    m.rowFind.mockResolvedValue({ ...ROW, amountDuePence: null });
    await set("whole");
    expect(update().data).toEqual({ gamesCovered: 5, gamesCommitted: null });
    expect(m.settleMemberAmount).not.toHaveBeenCalled();
  });

  it("THE ROUND TRIP (review item 6): a '4 only' of 5 lowered to 4 is still '4 only'", async () => {
    m.rowFind.mockResolvedValue({ ...ROW, gamesCovered: 5, gamesCommitted: 4, paidClaimedAt: NOW, amountDuePence: 3000 });
    await set(4);
    expect(update().data).toEqual({ paidClaimedAmountPence: 3000, gamesCovered: 4, gamesCommitted: 4, amountDuePence: 4 * 750 });
  });

});

/**
 * Review round 2, item 1: the reviewers' fixture. £7.50, five Mondays (2, 9,
 * 16, 23, 30), two played (now 14 Nov), the 23rd called off on 12 Nov:
 * the month's games leave it out. Lowering must never remove a week the
 * member holds a cancellation credit for. Nothing here creates or takes
 * back a credit: the mock ledger only counts.
 */
describe("round 2: never below a credited called-off week", () => {
  const NOW14 = new Date("2026-11-14T12:00:00Z");
  const GAMES = KICKOFFS.filter((_, i) => i !== 3);
  const rowOf = (over: Record<string, unknown>) => ({ ...ROW, ...over });
  const setAt = (coverage: number | "left") => setMonthMemberCoverage({ squadMonthId: "mo1", userId: "u1", coverage, now: NOW14 });
  beforeEach(() => {
    m.loadSignupMonth.mockResolvedValue({ ...MONTH, kickoffs: GAMES });
    m.creditCount.mockResolvedValue(1);
  });

  const rows: Array<[string, Record<string, unknown>, number]> = [
    ["pre-start unpaid (carried over, priced, the credit taken off at once)", { source: "carry-over", joinedAt: new Date("2026-10-25T10:00:00Z"), gamesCovered: 5, creditsApplied: 1, amountDuePence: 3000 }, 5],
    ["joined 10 Nov for 16, 23, 30", { joinedAt: new Date("2026-11-10T10:00:00Z"), gamesCovered: 3, amountDuePence: 1500, creditsApplied: 1 }, 3],
    ["joined 13 Nov, raised to the whole month", { joinedAt: new Date("2026-11-13T10:00:00Z"), gamesCovered: 5, amountDuePence: 3750 }, 3],
    ["says paid, joined 10 Nov", { joinedAt: new Date("2026-11-10T10:00:00Z"), gamesCovered: 3, paidClaimedAt: NOW14 }, 3],
    ["confirmed paid, joined 10 Nov", { joinedAt: new Date("2026-11-10T10:00:00Z"), gamesCovered: 3, paidAt: NOW14 }, 3],
    ["'4 only', carried over", { source: "carry-over", joinedAt: new Date("2026-10-25T10:00:00Z"), gamesCovered: 5, gamesCommitted: 4 }, 5],
  ];

  for (const [label, over, floor] of rows) {
    it(`${label}: never below ${floor}`, async () => {
      m.rowFind.mockResolvedValue(rowOf(over));
      expect(await setAt(floor - 1)).toMatchObject({ ok: false, error: "below-games-left", bounds: { min: floor, max: 5 } });
      // "The games left" is the floor, never fewer.
      const left = await setAt("left");
      expect(left).toMatchObject({ ok: true, gamesCovered: floor });
      if (floor === (over.gamesCovered as number)) expect(m.rowUpdate).not.toHaveBeenCalled();
      expect(m.creditCount).toHaveBeenCalledWith({ where: { orgId: "org1", userId: "u1", earnedMonthId: "mo1", reason: "cancelled-week", voidedAt: null } });
    });
  }

  it("not credited (joined 13 Nov, never raised): his own 2 games are the floor", async () => {
    m.creditCount.mockResolvedValue(0);
    m.rowFind.mockResolvedValue(rowOf({ joinedAt: new Date("2026-11-13T10:00:00Z"), gamesCovered: 2 }));
    expect(await setAt(1)).toMatchObject({ ok: false, error: "below-games-left", bounds: { min: 2, max: 5 } });
  });

  it("the page's editor offers the same floor", async () => {
    m.monthFind.mockResolvedValue({ ...money(), members: [{ userId: "u1", joinedAt: new Date("2026-11-13T10:00:00Z"), source: "admin", gamesCovered: 5 }] });
    m.creditFind.mockResolvedValue([{ userId: "u1" }]);
    const v = await loadCoverageView("mo1", NOW14);
    expect(v?.month).toEqual({ gamesLeft: 2, whole: 5, playable: 4 });
    expect(v?.members.get("u1")).toEqual({ min: 3, max: 5, gamesCovered: 5, creditedCancelled: 1 });
    expect(m.creditFind).toHaveBeenCalledWith({ where: { earnedMonthId: "mo1", reason: "cancelled-week", voidedAt: null }, select: { userId: true } });
  });
});

describe("the rest of the money", () => {

  it("refuses more than the month, writing nothing", async () => {
    expect(await set(6)).toMatchObject({ ok: false, error: "more-than-the-month" });
    expect(m.rowUpdate).not.toHaveBeenCalled();
  });

  it("a closed month, or no such month, is refused", async () => {
    m.loadSignupMonth.mockResolvedValue({ ...MONTH, status: "closed" });
    expect(await set("whole")).toEqual({ ok: false, error: "closed" });
    m.loadSignupMonth.mockResolvedValue(null);
    expect(await set("whole")).toEqual({ ok: false, error: "not-found" });
    expect(m.rowUpdate).not.toHaveBeenCalled();
  });
});

/** Round 3, item 4: the check the web add runs FIRST. Writes nothing. */
describe("checkMonthMemberCoverage", () => {
  const NOW14 = new Date("2026-11-14T12:00:00Z");
  const check = (coverage: "whole" | "left") => checkMonthMemberCoverage({ squadMonthId: "mo1", userId: "u1", coverage, now: NOW14 });

  it("a returning row whose credits are more than the games he would cover: refused, nothing written", async () => {
    m.rowFind.mockResolvedValue({ ...ROW, joinedAt: new Date("2026-11-13T10:00:00Z"), gamesCovered: 5, creditsApplied: 4 });
    expect(await check("left")).toEqual({ ok: false, error: "below-credits" });
    expect(m.rowUpdate).not.toHaveBeenCalled();
  });

  it("the same row and the whole month: allowed", async () => {
    m.rowFind.mockResolvedValue({ ...ROW, joinedAt: new Date("2026-11-13T10:00:00Z"), gamesCovered: 5, creditsApplied: 4 });
    expect(await check("whole")).toEqual({ ok: true });
  });

  it("nobody on the month yet: checked as a regular joining now", async () => {
    m.rowFind.mockResolvedValue(null);
    expect(await check("whole")).toEqual({ ok: true });
    expect(await check("left")).toEqual({ ok: true });
  });

  it("a closed month: refused", async () => {
    m.loadSignupMonth.mockResolvedValue({ ...MONTH, status: "closed" });
    expect(await check("whole")).toEqual({ ok: false, error: "closed" });
  });
});
