/**
 * `updateActivity`: who may edit a weekly game, and what reaches the
 * database (review fix 7 of PR #238, 2026-10-12). The REAL admin check
 * (`requireOrgAdmin`, src/lib/org.ts) runs against a mocked database, so
 * these are the rules a real request meets. No model, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  activity: null as Row | null,
  memberships: [] as Array<{ userId: string; orgId: string; role: string; leftAt: Date | null }>,
  superadmins: [] as string[],
  sports: [] as Array<{ id: string; orgId: string; preset: string | null; name: string; playersPerTeam: number }>,
  updates: [] as Array<{ where: Row; data: Row }>,
  /** Games of the activity still to be played, and what moved them. */
  games: [] as Array<{ id: string; date: Date; attendanceDeadline: Date }>,
  matchUpdates: [] as Array<{ where: Row; data: Row }>,
  /** Every write, in order, and whether it ran inside the transaction. */
  log: [] as string[],
  inTx: false,
}));
vi.mock("@/lib/db", () => {
  const db = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      state.inTx = true;
      try {
        return await fn(db);
      } finally {
        state.inTx = false;
      }
    }),
    match: {
      findMany: vi.fn(async () => state.games.map((g) => ({ ...g }))),
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        state.matchUpdates.push(args);
        state.log.push(`match${state.inTx ? " (tx)" : ""}`);
        return { count: 1 };
      }),
    },
    organisation: { findUnique: vi.fn(async () => ({ partnerAskCutoffHours: null })) },
    partnerAsk: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    tentativeAvailability: { updateMany: vi.fn(async () => ({ count: 0 })) },
    poolOffer: { updateMany: vi.fn(async () => ({ count: 0 })) },
    activity: {
      findUnique: vi.fn(async () => (state.activity ? { ...state.activity } : null)),
      update: vi.fn(async (args: { where: Row; data: Row }) => {
        state.updates.push(args);
        state.log.push(`activity${state.inTx ? " (tx)" : ""}`);
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
  };
  return { db };
});

import { updateActivity } from "../activities";
import { formatLondon, londonDateTimeToUtc, nextLondonKickoff } from "@/lib/london-time";

const EDIT = { name: "Tuesday 7s", dayOfWeek: 2, time: "21:30", venue: "Goals", feePerPlayer: "6.50" };

beforeEach(() => {
  vi.clearAllMocks();
  // `venue` is what the edits below send, so no venue lookup is scheduled here
  // (that path is src/lib/__tests__/activities-venue-actions.test.ts).
  // Day and time as EDIT sends them: the edits below change neither, so no game is read.
  state.activity = { id: "a1", orgId: "club-a", name: "Tuesday", venue: "Goals", feePerPlayer: null, feeSplitTotal: false, dayOfWeek: 2, time: "21:30" };
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
  state.games = [];
  state.matchUpdates = [];
  state.log = [];
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

describe("updateActivity: a new kickoff moves the games still to be played (Kemal, 2026-11-09)", () => {
  const H = 3600_000;
  /** The next two Tuesdays at 21:30 London, as the generator made them. */
  function twoTuesdays() {
    const first = nextLondonKickoff(new Date(), 2, "21:30");
    const second = nextLondonKickoff(new Date(first.getTime() + H), 2, "21:30");
    return [first, second].map((date, i) => ({ id: `g${i + 1}`, date, attendanceDeadline: new Date(date.getTime() - 5 * H) }));
  }
  const at2115 = (d: Date) => londonDateTimeToUtc(formatLondon(d, "yyyy-MM-dd"), "21:15");

  it("21:30 to 21:15: both games move to 21:15 on their own London date, in the same transaction as the activity", async () => {
    state.games = twoTuesdays();
    await updateActivity("a1", { ...EDIT, time: "21:15" });
    expect(state.matchUpdates.map((u) => [u.where.id, u.data.date])).toEqual(state.games.map((g) => [g.id, at2115(g.date)]));
    expect(state.log).toEqual(["activity (tx)", "match (tx)", "match (tx)"]);
  });

  it("the matches pages are refreshed, so they show the new time", async () => {
    state.games = twoTuesdays();
    await updateActivity("a1", { ...EDIT, time: "21:15" });
    const paths = revalidatePath.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(expect.arrayContaining(["/admin/activities", "/matches", "/"]));
  });

  it("a save that leaves the day and the time as they are moves no game", async () => {
    state.games = twoTuesdays();
    await updateActivity("a1", EDIT);
    await updateActivity("a1", { name: "Tuesday 7s" });
    expect(state.matchUpdates).toEqual([]);
  });

  it("a refused save moves no game either", async () => {
    state.games = twoTuesdays();
    await expect(updateActivity("a1", { time: "25:00" })).rejects.toThrow("Time must be HH:mm format");
    auth.mockResolvedValue({ user: { id: "u-player" } });
    await expect(updateActivity("a1", { time: "21:15" })).rejects.toThrow("Admin access required");
    expect(state.matchUpdates).toEqual([]);
  });
});
