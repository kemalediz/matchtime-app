/**
 * TEAMS FOR ANY SIZE INSIDE THE GAME'S RANGE (2026-11-03). "@Match Time make
 * the teams" with 13 confirmed said there weren't enough players, because the
 * teams needed two full sides. With a minimum set they are made from it up
 * (13 is 7 against 6), and a match switched to 8-a-side makes 8 a side, not
 * the format's 7.
 *
 * db, the LLM adjuster and next/cache are mocked. No DB, no network, no model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let match: Record<string, unknown>;
let created: Array<{ userId: string; team: string }> = [];

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/rating-adjuster", () => ({
  adjustRatings: () => Promise.resolve(new Map()),
  runRatingAdjuster: () => Promise.resolve(new Map()),
}));
vi.mock("@/lib/db", () => ({
  db: {
    match: { findUnique: () => Promise.resolve(match), update: () => Promise.resolve({}) },
    teamAssignment: {
      deleteMany: () => Promise.resolve({ count: 0 }),
      createMany: (a: { data: Array<{ userId: string; team: string }> }) => {
        created = a.data;
        return Promise.resolve({ count: a.data.length });
      },
    },
    rating: { findMany: () => Promise.resolve([]), aggregate: () => Promise.resolve({ _avg: { score: null } }) },
    membership: { findMany: () => Promise.resolve([]), findUnique: () => Promise.resolve(null) },
    user: { findMany: () => Promise.resolve([]), findUnique: () => Promise.resolve(null) },
    userAlias: { findMany: () => Promise.resolve([]) },
    analyzedMessage: { findMany: () => Promise.resolve([]) },
    ratingAdjustment: { upsert: () => Promise.resolve({}) },
    botJob: { create: () => Promise.resolve({}) },
  },
}));

import { generateTeamsForMatch } from "@/lib/team-generation";

function buildMatch(p: { confirmed: number; maxPlayers: number; minPlayers: number | null; actMax?: number | null; lang?: string }) {
  return {
    id: "m1",
    activityId: "act-1",
    date: new Date("2026-11-09T20:30:00Z"),
    status: "UPCOMING",
    maxPlayers: p.maxPlayers,
    teamLabels: [],
    activity: {
      orgId: "org-vets",
      venue: "Sandbox Park",
      minPlayers: p.minPlayers,
      maxPlayers: p.actMax ?? null,
      org: { id: "org-vets", name: "Vets", teamLabels: [], language: p.lang ?? "en" },
      sport: { name: "Football 7-a-side", playersPerTeam: 7, balancingStrategy: "rating-only", positionComposition: null, teamLabels: [] },
    },
    attendances: Array.from({ length: p.confirmed }, (_, i) => ({
      userId: `u${i + 1}`,
      user: { name: `Player ${i + 1}`, image: null, activityPositions: [] },
    })),
  };
}

beforeEach(() => {
  created = [];
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => vi.restoreAllMocks());

describe("generateTeamsForMatch inside the game's range", () => {
  it("13 confirmed with a minimum of 12: 7 against 6, everyone placed", async () => {
    match = buildMatch({ confirmed: 13, maxPlayers: 14, minPlayers: 12, actMax: 16 });
    const r = await generateTeamsForMatch("m1");
    expect(r.ok).toBe(true);
    const red = created.filter((c) => c.team === "RED").length;
    const yellow = created.filter((c) => c.team === "YELLOW").length;
    expect([red, yellow].sort()).toEqual([6, 7]);
    expect(new Set(created.map((c) => c.userId)).size).toBe(13);
  });

  it("13 confirmed with no minimum: not enough, as before, naming 14", async () => {
    match = buildMatch({ confirmed: 13, maxPlayers: 14, minPlayers: null });
    const r = await generateTeamsForMatch("m1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/14/);
  });

  it("11 confirmed with a minimum of 12: not enough, naming 12", async () => {
    match = buildMatch({ confirmed: 11, maxPlayers: 14, minPlayers: 12 });
    const r = await generateTeamsForMatch("m1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/12/);
  });

  it("a match switched to 8-a-side with 16 in: 8 against 8", async () => {
    match = buildMatch({ confirmed: 16, maxPlayers: 16, minPlayers: 12, actMax: 16 });
    const r = await generateTeamsForMatch("m1");
    expect(r.ok).toBe(true);
    expect(created.filter((c) => c.team === "RED")).toHaveLength(8);
    expect(created.filter((c) => c.team === "YELLOW")).toHaveLength(8);
  });

  it("a match switched to 6-a-side with 13 in: the first 12 play, 6 a side", async () => {
    // The switch benches the 13th; this guards the balancer's own cap.
    match = buildMatch({ confirmed: 13, maxPlayers: 12, minPlayers: 12, actMax: 16 });
    const r = await generateTeamsForMatch("m1");
    expect(r.ok).toBe(true);
    expect(created).toHaveLength(12);
  });
});
