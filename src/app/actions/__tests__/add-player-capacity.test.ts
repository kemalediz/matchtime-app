/**
 * THE MATCH PAGE NEVER OVERFILLS A SQUAD (review of #622, 2026-11-17).
 *
 * "Remove" then "Add" on the match page: the removal leaves the place for
 * the organiser's add (the bench fill waits two minutes, `bench-fill.ts`
 * `SWEEP_GRACE_MS`), and the add respects capacity, so whatever the
 * timing the squad is never 15 of 14. "Add to bench instead" records the
 * choice (`benchByChoice`), so the safety net never moves him up.
 *
 * auth / db / next are mocked. No live DB, no model.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  confirmed: 14,
  upserts: [] as Array<{ status: string; benchByChoice?: boolean }>,
  locked: 0,
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "admin" } }) }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/player-account-guard", async () => {
  const { t } = await import("@/lib/i18n/t");
  return { playerEditContext: async () => ({ s: t("en"), refusal: null }), isClubOwnedUser: vi.fn(), loadOwnershipFacts: vi.fn(), clubOwnsUser: vi.fn() };
});
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

vi.mock("@/lib/db", () => {
  const db = {
    user: { findUnique: async () => ({ id: "p1", name: "Pete", phoneNumber: null }) },
    $executeRaw: async () => {
      h.locked++;
      return 0;
    },
    match: {
      findUnique: async () => ({
        id: "m1",
        maxPlayers: 14,
        date: new Date(Date.now() + 6 * 3_600_000),
        status: "UPCOMING",
        activity: { name: "Tuesday 7-a-side", orgId: "o1", matchDurationMins: 60, sport: { mvpLabel: "MoM" } },
      }),
    },
    membership: { findUnique: async () => ({ id: "mem1", guestFromOrgId: null, leftAt: null }), create: vi.fn(), update: vi.fn() },
    attendance: {
      findFirst: async () => null,
      findUnique: async () => null,
      count: async () => h.confirmed,
      upsert: async (args: { create: { status: string; benchByChoice?: boolean } }) => {
        h.upserts.push({ status: args.create.status, benchByChoice: args.create.benchByChoice });
        return { status: args.create.status, position: 1 };
      },
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db };
});

import { addPlayerToMatch } from "../players";

beforeEach(() => {
  h.confirmed = 14;
  h.upserts = [];
  h.locked = 0;
});

describe("addPlayerToMatch on an upcoming match", () => {
  it("a full squad: he goes on the bench as an ordinary reserve, and the page is told", async () => {
    const res = await addPlayerToMatch("m1", { userId: "p1" });
    expect(res).toMatchObject({ ok: true, benchedFull: true });
    expect(h.upserts).toEqual([{ status: "BENCH", benchByChoice: false }]);
    expect(h.locked).toBeGreaterThan(0);
  });

  it("a place free: he is in", async () => {
    h.confirmed = 13;
    const res = await addPlayerToMatch("m1", { userId: "p1" });
    expect(res).toMatchObject({ ok: true });
    expect(res.ok && res.benchedFull).toBeFalsy();
    expect(h.upserts).toEqual([{ status: "CONFIRMED", benchByChoice: false }]);
  });

  it("'Add to bench instead': on the bench by choice, so the bench fill never moves him up", async () => {
    h.confirmed = 10;
    await addPlayerToMatch("m1", { userId: "p1" }, "BENCH");
    expect(h.upserts).toEqual([{ status: "BENCH", benchByChoice: true }]);
  });
});
