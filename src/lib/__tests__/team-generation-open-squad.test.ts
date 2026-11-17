/**
 * TEAMS FOR AN OPEN SQUAD (2026-11-17, the Vets: no format, "just a simple
 * main squad list"). Whoever is in is split into two even sides, the odd
 * one on the first (15 is 8 v 7, 19 is 10 v 9), from the game's minimum
 * up; nobody is left out whatever the match's places say.
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

function buildMatch(p: { confirmed: number; maxPlayers: number; minPlayers: number | null; actMax?: number | null; lang?: string; openSquad?: boolean }) {
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
      org: { id: "org-vets", name: "Vets", teamLabels: [], language: p.lang ?? "en", openSquad: p.openSquad ?? false },
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

const sides = () => [created.filter((c) => c.team === "RED").length, created.filter((c) => c.team === "YELLOW").length].sort((a, b) => b - a);

describe("generateTeamsForMatch for an open squad (2026-11-17, no format)", () => {
  it("15 in on a 14-place match: 8 v 7, everyone placed", async () => {
    match = buildMatch({ confirmed: 15, maxPlayers: 14, minPlayers: 12, actMax: 16, openSquad: true });
    const r = await generateTeamsForMatch("m1");
    expect(r.ok).toBe(true);
    expect(sides()).toEqual([8, 7]);
    expect(new Set(created.map((c) => c.userId)).size).toBe(15);
  });

  it("19 in: 10 v 9; 22 in: 11 v 11", async () => {
    match = buildMatch({ confirmed: 19, maxPlayers: 14, minPlayers: 12, openSquad: true });
    expect((await generateTeamsForMatch("m1")).ok).toBe(true);
    expect(sides()).toEqual([10, 9]);
    match = buildMatch({ confirmed: 22, maxPlayers: 14, minPlayers: 12, openSquad: true });
    expect((await generateTeamsForMatch("m1")).ok).toBe(true);
    expect(sides()).toEqual([11, 11]);
  });

  it("12 in with a minimum of 12: 6 v 6", async () => {
    match = buildMatch({ confirmed: 12, maxPlayers: 14, minPlayers: 12, openSquad: true });
    expect((await generateTeamsForMatch("m1")).ok).toBe(true);
    expect(sides()).toEqual([6, 6]);
  });

  it("below the minimum: not enough, naming the minimum", async () => {
    match = buildMatch({ confirmed: 11, maxPlayers: 14, minPlayers: 12, openSquad: true });
    const r = await generateTeamsForMatch("m1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/12/);
  });

  it("off: 15 in on a 14-place match still makes 7 v 7, as before", async () => {
    match = buildMatch({ confirmed: 15, maxPlayers: 14, minPlayers: 12 });
    expect((await generateTeamsForMatch("m1")).ok).toBe(true);
    expect(sides()).toEqual([7, 7]);
  });
});
