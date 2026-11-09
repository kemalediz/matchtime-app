/**
 * Finishing a club's setup can change its weekly game's day and time
 * (`applyEnrichment`, the schedule step). The games already made follow,
 * through the same one function as the edit form
 * (src/lib/activity-kickoff-move.ts), in the same transaction as the
 * activity write. Mocked database: no model, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  log: [] as string[],
  inTx: false,
  move: vi.fn(async () => ({ moved: [], stayed: [] })),
}));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "owner" } }) }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/actions/players", () => ({ updatePlayerPhone: vi.fn() }));
vi.mock("@/lib/venue-location", () => ({ dropOrphanPin: vi.fn() }));
vi.mock("@/lib/venue-location-schedule", () => ({ scheduleVenueResolve: vi.fn() }));
vi.mock("@/lib/activity-kickoff-move", () => ({
  moveGamesWithActivity: (...a: unknown[]) => {
    s.log.push(`move${s.inTx ? " (tx)" : ""}`);
    return (s.move as (...x: unknown[]) => unknown)(...a);
  },
}));
vi.mock("@/lib/db", () => {
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      s.inTx = true;
      try {
        return await fn(db);
      } finally {
        s.inTx = false;
      }
    },
    onboardingSession: {
      findUnique: async () => ({ id: "onb", orgId: "club", enrichmentStatus: "proposed" }),
      update: async () => ({}),
    },
    activity: {
      findFirst: async () => ({ id: "act", orgId: "club", dayOfWeek: 1, time: "20:30", venue: "Goals", venueId: null, sport: { positions: [] } }),
      update: async (args: { data: Row }) => {
        s.log.push(`activity${s.inTx ? " (tx)" : ""}`);
        return args.data;
      },
    },
    match: { findFirst: async () => null, update: async () => ({}) },
  };
  return { db };
});

import { applyEnrichment } from "../finish-setup";

const schedule = (over: Partial<{ dayOfWeek: number | null; time: string | null }>) => ({
  dayOfWeek: null,
  time: null,
  venue: null,
  playersPerSide: null,
  ...over,
});

beforeEach(() => {
  s.log = [];
  s.move.mockClear();
});

describe("applyEnrichment: a new day or time moves the games already made", () => {
  it("20:30 to 20:15: the same move as the edit form, inside the activity's transaction", async () => {
    await applyEnrichment({ sessionId: "onb", players: [], phones: [], schedule: schedule({ time: "20:15" }) });
    expect(s.log).toEqual(["activity (tx)", "move (tx)"]);
    expect(s.move).toHaveBeenCalledWith(expect.anything(), {
      activityId: "act",
      orgId: "club",
      before: { dayOfWeek: 1, time: "20:30" },
      after: { dayOfWeek: 1, time: "20:15" },
      now: expect.any(Date),
    });
  });

  it("no schedule in the setup: the activity is not written and nothing moves", async () => {
    await applyEnrichment({ sessionId: "onb", players: [], phones: [], schedule: schedule({}) });
    expect(s.log).toEqual([]);
  });
});
