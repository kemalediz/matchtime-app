/**
 * Monthly squad, slice 2 (MDs/monthly-squad-plan-2026-10-05.md): the two
 * server actions. `setMonthlySquad` saves the "Monthly squad" settings on
 * /admin/settings; `startCurrentMonth` opens the current month part-way
 * through from the organiser's own list (plan 4.5).
 *
 * OWNER and ADMIN only. Nothing here posts to WhatsApp or calls a model,
 * and a club left on "weekly" (every club today) can open no month.
 *
 * auth / db / org / next-cache are mocked: no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const requireOrgAdmin = vi.fn();
const orgUpdate = vi.fn();
const orgFindUnique = vi.fn();
const activityFindFirst = vi.fn();
const monthFindUnique = vi.fn();
const membershipFindMany = vi.fn();
const aliasFindMany = vi.fn();
const transaction = vi.fn();
const monthCreate = vi.fn();
const memberCreateMany = vi.fn();
const creditCreateMany = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/db", () => ({
  db: {
    organisation: {
      update: (...a: unknown[]) => orgUpdate(...a),
      findUnique: (...a: unknown[]) => orgFindUnique(...a),
    },
    activity: { findFirst: (...a: unknown[]) => activityFindFirst(...a) },
    squadMonth: { findUnique: (...a: unknown[]) => monthFindUnique(...a) },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    userAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));

const { setMonthlySquad, startCurrentMonth, readMonthList } = await import("../squad-month");

const SAVED_ROW = {
  squadMode: "weekly",
  rollingSquadEnabled: true,
  paygPricePence: null,
  monthListOpensDaysBefore: 7,
  monthCreditRule: "any-miss",
  paymentInstructions: null,
};

const tx = {
  squadMonth: { create: (...a: unknown[]) => monthCreate(...a) },
  squadMonthMember: { createMany: (...a: unknown[]) => memberCreateMany(...a) },
  squadCredit: { createMany: (...a: unknown[]) => creditCreateMany(...a) },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Tuesday 6 October 2026, 10:00 London: the Monday 5th has been played.
  vi.setSystemTime(new Date("2026-10-06T09:00:00Z"));
  authMock.mockResolvedValue({ user: { id: "u-sam" } });
  requireOrgAdmin.mockResolvedValue(undefined);
  orgUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const { settingsSetByOrganiser: _pushed, ...cols } = data;
    void _pushed;
    return { ...SAVED_ROW, ...cols };
  });
  orgFindUnique.mockResolvedValue({ squadMode: "monthly" });
  activityFindFirst.mockResolvedValue({ id: "act-mnf" });
  monthFindUnique.mockResolvedValue(null);
  membershipFindMany.mockResolvedValue([
    { userId: "u-alex", user: { id: "u-alex", name: "Alex Carter" } },
    { userId: "u-bilal", user: { id: "u-bilal", name: "Bilal Khan" } },
    { userId: "u-omar", user: { id: "u-omar", name: "Omar One" } },
    { userId: "u-sam", user: { id: "u-sam", name: "Sam Hill" } },
  ]);
  aliasFindMany.mockResolvedValue([{ userId: "u-sam", alias: "sammy" }]);
  transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  monthCreate.mockResolvedValue({ id: "month-oct" });
  memberCreateMany.mockResolvedValue({ count: 0 });
  creditCreateMany.mockResolvedValue({ count: 0 });
});

describe("setMonthlySquad", () => {
  it("switches the club to monthly, and the rolling squad off with it", async () => {
    const res = await setMonthlySquad("org-vets", { squadMode: "monthly" });
    expect(requireOrgAdmin).toHaveBeenCalledWith("u-sam", "org-vets");
    expect(orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "org-vets" },
        data: { squadMode: "monthly", rollingSquadEnabled: false, settingsSetByOrganiser: { push: ["squadMode"] } },
      }),
    );
    expect(res).toEqual({
      ok: true,
      squadMode: "monthly",
      rollingSquad: false,
      paygPricePence: null,
      monthListOpensDaysBefore: 7,
      monthCreditRule: "any-miss",
      paymentInstructions: null,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/settings");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/months");
  });

  it("switching back to weekly does not touch the rolling squad", async () => {
    await setMonthlySquad("org-vets", { squadMode: "weekly" });
    expect(orgUpdate.mock.calls[0][0].data).toEqual({ squadMode: "weekly", settingsSetByOrganiser: { push: ["squadMode"] } });
  });

  it("saves the price, the days, the credit rule and the instructions", async () => {
    const res = await setMonthlySquad("org-vets", {
      paygPricePence: 800,
      monthListOpensDaysBefore: 5,
      monthCreditRule: "none",
      paymentInstructions: "Bank details are in the group description.",
    });
    expect(orgUpdate.mock.calls[0][0].data).toEqual({
      paygPricePence: 800,
      monthListOpensDaysBefore: 5,
      monthCreditRule: "none",
      paymentInstructions: "Bank details are in the group description.",
      settingsSetByOrganiser: { push: ["paygPricePence", "monthListOpensDaysBefore", "monthCreditRule", "paymentInstructions"] },
    });
    expect(res).toMatchObject({ ok: true, paygPricePence: 800, monthCreditRule: "none" });
  });

  it("a bad value comes back as a reason, and nothing is written", async () => {
    expect(await setMonthlySquad("org-vets", { paygPricePence: -1 })).toEqual({ ok: false, error: "bad-price" });
    expect(await setMonthlySquad("org-vets", {})).toEqual({ ok: false, error: "empty" });
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("refuses a player: only an owner or admin can change it", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(setMonthlySquad("org-vets", { squadMode: "monthly" })).rejects.toThrow("Admin access required");
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    authMock.mockResolvedValue(null);
    await expect(setMonthlySquad("org-vets", { squadMode: "monthly" })).rejects.toThrow("Not authenticated");
    expect(requireOrgAdmin).not.toHaveBeenCalled();
  });
});

const SEED = {
  activityId: "act-mnf",
  gamesScheduled: 4,
  gamesPlayed: 1,
  sharePerGamePence: 750,
  source: "seed-tick" as const,
  rows: [
    { userId: "u-alex", kind: "regular" as const, paid: "confirmed" as const, paidAmountPence: 3000 },
    { userId: "u-bilal", kind: "regular" as const, paid: "claimed" as const, paidAmountPence: 2250, creditsCarriedIn: 1 },
    { userId: "u-omar", kind: "payg" as const },
  ],
};

describe("startCurrentMonth: a month already under way", () => {
  it("opens October as running, with the played game counted", async () => {
    const res = await startCurrentMonth("org-vets", SEED);
    expect(res).toEqual({ ok: true, monthId: "month-oct" });
    expect(requireOrgAdmin).toHaveBeenCalledWith("u-sam", "org-vets");
    expect(activityFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "act-mnf", orgId: "org-vets", isActive: true } }),
    );
    expect(monthCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          orgId: "org-vets",
          activityId: "act-mnf",
          monthStart: new Date("2026-10-01T00:00:00.000Z"),
          status: "running",
          gamesScheduled: 4,
          gamesPlayedBeforeStart: 1,
          sharePerGamePence: 750,
          concessionPerGamePence: null,
          startedMidMonthAt: new Date("2026-10-06T09:00:00Z"),
          startedByUserId: "u-sam",
        },
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/admin/months");
  });

  it("writes the members: confirmed, says paid, and a PAYG player who owes nothing", async () => {
    await startCurrentMonth("org-vets", SEED);
    const rows = memberCreateMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.monthId)).toEqual(["month-oct", "month-oct", "month-oct"]);
    expect(rows[0]).toMatchObject({
      userId: "u-alex",
      kind: "regular",
      slot: 1,
      gamesCovered: 4,
      amountDuePence: 3000,
      paidAt: new Date("2026-10-06T09:00:00Z"),
      paidAmountPence: 3000,
      paidConfirmedByUserId: "u-sam",
      paidClaimedAt: null,
      source: "seed-tick",
    });
    expect(rows[1]).toMatchObject({
      userId: "u-bilal",
      creditsApplied: 1,
      amountDuePence: 2250,
      paidAt: null,
      paidClaimedAt: new Date("2026-10-06T09:00:00Z"),
      paidClaimedAmountPence: 2250,
      paidClaimSource: "organiser",
    });
    expect(rows[2]).toMatchObject({ userId: "u-omar", kind: "payg", slot: 3, gamesCovered: 0, amountDuePence: null, paidAt: null });
  });

  it("writes a carried-in credit to the ledger, already used against this month", async () => {
    await startCurrentMonth("org-vets", SEED);
    expect(creditCreateMany).toHaveBeenCalledWith({
      data: [
        {
          orgId: "org-vets",
          userId: "u-bilal",
          games: 1,
          reason: "carried-in",
          appliedMonthId: "month-oct",
          appliedAt: new Date("2026-10-06T09:00:00Z"),
          createdById: "u-sam",
        },
      ],
    });
  });

  it("with no credits carried in, the ledger is not touched", async () => {
    await startCurrentMonth("org-vets", { ...SEED, rows: [{ userId: "u-alex", kind: "regular" }] });
    expect(creditCreateMany).not.toHaveBeenCalled();
  });

  it("only current members of THIS club can be seeded", async () => {
    await startCurrentMonth("org-vets", SEED);
    expect(membershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org-vets", leftAt: null, user: { isActive: true } } }),
    );
    const res = await startCurrentMonth("org-vets", { ...SEED, rows: [{ userId: "u-other-club", kind: "regular" }] });
    expect(res).toEqual({ ok: false, error: "not-a-member" });
  });

  it("a weekly club can open no month", async () => {
    orgFindUnique.mockResolvedValue({ squadMode: "weekly" });
    expect(await startCurrentMonth("org-sutton", SEED)).toEqual({ ok: false, error: "not-monthly" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a fixture that is not this club's", async () => {
    activityFindFirst.mockResolvedValue(null);
    expect(await startCurrentMonth("org-vets", SEED)).toEqual({ ok: false, error: "bad-fixture" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("a month already started is never started twice", async () => {
    monthFindUnique.mockResolvedValue({ id: "month-oct" });
    expect(await startCurrentMonth("org-vets", SEED)).toEqual({ ok: false, error: "already-started" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("two organisers pressing at once: the second is told it is already started", async () => {
    transaction.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    expect(await startCurrentMonth("org-vets", SEED)).toEqual({ ok: false, error: "already-started" });
  });

  it("any other database failure is not swallowed", async () => {
    transaction.mockRejectedValue(new Error("connection reset"));
    await expect(startCurrentMonth("org-vets", SEED)).rejects.toThrow("connection reset");
  });

  it("a bad seed comes back as a reason, and nothing is written", async () => {
    expect(await startCurrentMonth("org-vets", { ...SEED, rows: [] })).toEqual({ ok: false, error: "no-players" });
    expect(await startCurrentMonth("org-vets", { ...SEED, gamesPlayed: 9 })).toEqual({ ok: false, error: "bad-games" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a player, and a signed-out caller", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(startCurrentMonth("org-vets", SEED)).rejects.toThrow("Admin access required");
    authMock.mockResolvedValue(null);
    await expect(startCurrentMonth("org-vets", SEED)).rejects.toThrow("Not authenticated");
    expect(transaction).not.toHaveBeenCalled();
  });
});

const LIST = `List for October:

1. Alex (Paid £30)
2. Bilal paid
3. Omar (PAYG)
4.
5. Zed

Paid but can't play
1. Sammy`;

describe("readMonthList: a pasted list becomes a draft, and writes nothing", () => {
  it("reads the list with the slice 1 reader and matches names to this club's players", async () => {
    const res = await readMonthList("org-vets", LIST);
    expect(requireOrgAdmin).toHaveBeenCalledWith("u-sam", "org-vets");
    if (!res.ok) throw new Error(res.error);
    expect(res.monthMismatch).toBe(false);
    expect(res.rows).toEqual([
      { userId: "u-alex", name: "Alex Carter", kind: "regular", tier: "standard", slot: 1, paid: "claimed", paidAmountPence: 3000 },
      { userId: "u-bilal", name: "Bilal Khan", kind: "regular", tier: "standard", slot: 2, paid: "claimed", paidAmountPence: null },
      { userId: "u-omar", name: "Omar One", kind: "payg", tier: "standard", slot: 3, paid: "none", paidAmountPence: null },
      { userId: "u-sam", name: "Sam Hill", kind: "regular", tier: "standard", slot: null, paid: "claimed", paidAmountPence: null },
    ]);
    expect(res.unmatched).toEqual([{ slot: 5, name: "Zed", kind: "regular", reason: "unknown", candidates: [] }]);
    expect(aliasFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: "org-vets" } }));
  });

  it("writes nothing and marks nobody paid", async () => {
    const res = await readMonthList("org-vets", LIST);
    if (!res.ok) throw new Error(res.error);
    expect(res.rows.some((r) => r.paid === "confirmed")).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(orgUpdate).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says when the list is headed with another month", async () => {
    const res = await readMonthList("org-vets", LIST.replace("October", "November"));
    expect(res).toMatchObject({ ok: true, monthMismatch: true });
  });

  it("refuses text that is not a list, and a paste far too long to be one", async () => {
    expect(await readMonthList("org-vets", "£22.50 for 4 games next month, pay by Friday")).toEqual({ ok: false, error: "not-a-list" });
    expect(await readMonthList("org-vets", "")).toEqual({ ok: false, error: "not-a-list" });
    expect(await readMonthList("org-vets", `List for October\n${"1. Alex\n".repeat(3000)}`)).toEqual({ ok: false, error: "not-a-list" });
    expect(await readMonthList("org-vets", 42 as unknown as string)).toEqual({ ok: false, error: "not-a-list" });
  });

  it("a weekly club's paste is not read at all", async () => {
    orgFindUnique.mockResolvedValue({ squadMode: "weekly" });
    expect(await readMonthList("org-sutton", LIST)).toEqual({ ok: false, error: "not-monthly" });
    expect(membershipFindMany).not.toHaveBeenCalled();
  });

  it("refuses a player, and a signed-out caller", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(readMonthList("org-vets", LIST)).rejects.toThrow("Admin access required");
    authMock.mockResolvedValue(null);
    await expect(readMonthList("org-vets", LIST)).rejects.toThrow("Not authenticated");
  });
});
