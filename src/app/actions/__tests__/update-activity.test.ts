/**
 * `updateActivity`: who may edit a weekly game, and what reaches the
 * database (review fix 7 of PR #238, 2026-10-12). The REAL admin check
 * (`requireOrgAdmin`, src/lib/org.ts) runs against a mocked database, so
 * these are the rules a real request meets. No model, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  activity: null as Row | null,
  memberships: [] as Array<{ userId: string; orgId: string; role: string; leftAt: Date | null }>,
  superadmins: [] as string[],
  sports: [] as Array<{ id: string; orgId: string; preset: string | null; name: string; playersPerTeam: number }>,
  updates: [] as Array<{ where: Row; data: Row }>,
}));
vi.mock("@/lib/db", () => ({
  db: {
    activity: {
      findUnique: vi.fn(async () => (state.activity ? { ...state.activity } : null)),
      update: vi.fn(async (args: { where: Row; data: Row }) => {
        state.updates.push(args);
        return { ...state.activity, ...args.data };
      }),
    },
    membership: {
      findUnique: vi.fn(async ({ where }: { where: { userId_orgId: { userId: string; orgId: string } } }) =>
        state.memberships.find((m) => m.userId === where.userId_orgId.userId && m.orgId === where.userId_orgId.orgId) ?? null,
      ),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        isSuperadmin: state.superadmins.includes(where.id),
        email: `${where.id}@e2e-test.invalid`,
      })),
    },
    sport: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; orgId: string } }) =>
        state.sports.find((s) => s.id === where.id && s.orgId === where.orgId) ?? null,
      ),
    },
  },
}));

import { updateActivity } from "../activities";

const EDIT = { name: "Tuesday 7s", dayOfWeek: 2, time: "21:30", venue: "Goals", feePerPlayer: "6.50" };

beforeEach(() => {
  vi.clearAllMocks();
  // `venue` is what the edits below send, so no venue lookup is scheduled here
  // (that path is src/lib/__tests__/activities-venue-actions.test.ts).
  state.activity = { id: "a1", orgId: "club-a", name: "Tuesday", venue: "Goals", feePerPlayer: null, feeSplitTotal: false };
  state.memberships = [
    { userId: "u-owner", orgId: "club-a", role: "OWNER", leftAt: null },
    { userId: "u-admin", orgId: "club-a", role: "ADMIN", leftAt: null },
    { userId: "u-player", orgId: "club-a", role: "PLAYER", leftAt: null },
    { userId: "u-left", orgId: "club-a", role: "ADMIN", leftAt: new Date("2026-09-01") },
    { userId: "u-other-admin", orgId: "club-b", role: "OWNER", leftAt: null },
  ];
  state.superadmins = [];
  const seven = { preset: "football-7aside", name: "Football 7-a-side", playersPerTeam: 7 };
  state.sports = [{ id: "s-a", orgId: "club-a", ...seven }, { id: "s-b", orgId: "club-b", ...seven }];
  state.updates = [];
  auth.mockResolvedValue({ user: { id: "u-owner" } });
});

describe("updateActivity: who may", () => {
  it("signed out: refused before anything is read", async () => {
    auth.mockResolvedValue(null);
    await expect(updateActivity("a1", EDIT)).rejects.toThrow("Not authenticated");
    expect(state.updates).toEqual([]);
  });
  it("the owner or an admin of the activity's club: saved", async () => {
    for (const id of ["u-owner", "u-admin"]) {
      state.updates = [];
      auth.mockResolvedValue({ user: { id } });
      await updateActivity("a1", EDIT);
      expect(state.updates, id).toEqual([{ where: { id: "a1" }, data: { name: "Tuesday 7s", dayOfWeek: 2, time: "21:30", venue: "Goals", feePerPlayer: 6.5 } }]);
    }
  });
  it("an admin of ANOTHER club: refused, nothing written", async () => {
    auth.mockResolvedValue({ user: { id: "u-other-admin" } });
    await expect(updateActivity("a1", EDIT)).rejects.toThrow("Admin access required");
    expect(state.updates).toEqual([]);
  });
  it("a plain member of the club: refused, the fee included", async () => {
    auth.mockResolvedValue({ user: { id: "u-player" } });
    await expect(updateActivity("a1", { feePerPlayer: "1" })).rejects.toThrow("Admin access required");
    expect(state.updates).toEqual([]);
  });
  it("an admin who has left the club, and somebody who was never in it: refused", async () => {
    for (const id of ["u-left", "u-stranger"]) {
      auth.mockResolvedValue({ user: { id } });
      await expect(updateActivity("a1", EDIT), id).rejects.toThrow("Admin access required");
    }
    expect(state.updates).toEqual([]);
  });
  it("an activity that does not exist: refused", async () => {
    state.activity = null;
    await expect(updateActivity("nope", EDIT)).rejects.toThrow("Activity not found");
  });
});

describe("updateActivity: what is written", () => {
  it("only named fields: a club, an id or a fee split smuggled in the argument never reaches the database", async () => {
    const sneaky = { ...EDIT, orgId: "club-b", id: "a2", feeSplitTotal: true } as unknown as Parameters<typeof updateActivity>[1];
    await updateActivity("a1", sneaky);
    expect(state.updates[0].data).toEqual({ name: "Tuesday 7s", dayOfWeek: 2, time: "21:30", venue: "Goals", feePerPlayer: 6.5 });
  });
  it("the fee left out, or present but undefined: the stored fee is not touched", async () => {
    state.activity!.feePerPlayer = 6.505;
    await updateActivity("a1", { name: "Tuesday 7s" });
    await updateActivity("a1", { name: "Tuesday 7s", feePerPlayer: undefined });
    await updateActivity("a1", { isActive: false });
    expect(state.updates.map((u) => u.data)).toEqual([{ name: "Tuesday 7s" }, { name: "Tuesday 7s" }, { isActive: false }]);
  });
  it("a bad fee, or a fee on a game that splits the pitch: refused, nothing written", async () => {
    await expect(updateActivity("a1", { name: "Tuesday 7s", feePerPlayer: "lots" })).rejects.toThrow("Enter a fee like 6 or 6.50, at most £100.");
    state.activity!.feeSplitTotal = true;
    await expect(updateActivity("a1", { feePerPlayer: "6" })).rejects.toThrow("splits the pitch cost");
    expect(state.updates).toEqual([]);
  });
  it("a sport of another club is still refused", async () => {
    await expect(updateActivity("a1", { sportId: "s-b" })).rejects.toThrow("Sport not found in this organisation");
    await updateActivity("a1", { sportId: "s-a" });
    expect(state.updates.map((u) => u.data)).toEqual([{ sportId: "s-a" }]);
  });
});
