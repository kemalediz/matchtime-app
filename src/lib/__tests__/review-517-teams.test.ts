/**
 * REVIEW OF #517 (uncommitted, failing). A match switched to 8-a-side (16
 * places, 16 confirmed) whose game's range is then narrowed (the organiser
 * clears the maximum, or sets it back to 14) is still a 16-place match:
 * nothing re-sizes it (`savePlayerRange` touches only the Activity). Team
 * generation then reads the size from the RANGE (`perTeamFor` falls back to
 * the format's 7 when 8 is no longer "allowed") and the balancer slices the
 * confirmed list to 14: two confirmed players are silently left off the
 * teams.
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

beforeEach(() => {
  created = [];
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => vi.restoreAllMocks());

describe("review #517: a 16-place match after the range is narrowed", () => {
  it("16 confirmed on a 16-place match whose game's max was cleared: all 16 placed", async () => {
    match = {
      id: "m1",
      activityId: "act-1",
      date: new Date("2026-11-09T20:30:00Z"),
      status: "UPCOMING",
      maxPlayers: 16,
      teamLabels: [],
      activity: {
        orgId: "org-vets",
        venue: "Sandbox Park",
        minPlayers: 12,
        maxPlayers: null, // was 16 when the match was switched; cleared since
        org: { id: "org-vets", name: "Vets", teamLabels: [], language: "en" },
        sport: { name: "Football 7-a-side", playersPerTeam: 7, balancingStrategy: "rating-only", positionComposition: null, teamLabels: [] },
      },
      attendances: Array.from({ length: 16 }, (_, i) => ({
        userId: `u${i + 1}`,
        user: { name: `Player ${i + 1}`, image: null, activityPositions: [] },
      })),
    };
    const r = await generateTeamsForMatch("m1");
    expect(r.ok).toBe(true);
    expect(new Set(created.map((c) => c.userId)).size).toBe(16);
  });
});
