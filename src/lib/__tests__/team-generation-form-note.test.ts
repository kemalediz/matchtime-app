/**
 * A STORED FORM NOTE WINS OVER THE RATING ADJUSTER (Kemal, 2026-11-10).
 *
 * A player told MatchTime how they will play, MatchTime said the amount
 * ("Noted: -0.5 for Ayse (tired) in Friday's game"), and it may have been
 * changed since ("make it -1"). When the teams are made that amount is the
 * one used for that player: the adjuster still runs for everyone else, and
 * the RatingAdjustment audit row says the amount came from the note. A
 * note of 0 (a cancel) keeps the adjuster off the player. A note applies
 * even when the adjuster gives nothing (a failed call, the AI cap).
 *
 * The db is a small in-memory fake; the adjuster is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const MATCH_ID = "match-1";
const ORG_ID = "org-fnf";
const MATCH_DATE = new Date("2026-11-13T19:30:00Z");

const SQUAD = [
  { id: "u-a", name: "Ayse", seed: 9 },
  { id: "u-b", name: "Bilal", seed: 8 },
  { id: "u-c", name: "Cem", seed: 6 },
  { id: "u-d", name: "Deniz", seed: 4 },
  { id: "u-e", name: "Emre", seed: 3 },
  { id: "u-f", name: "Faruk", seed: 5 },
];

const h = vi.hoisted(() => ({
  notes: [] as Array<{ userId: string; delta: number; reason: string }>,
  adjusterPlayers: [] as string[][],
  adjusterResult: new Map<string, { playerId: string; delta: number; reason: string; confidence: number }>(),
  upserts: [] as Array<{ userId: string; delta: number; reason: string; confidence: number }>,
  notesThrow: false,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/rating-adjuster", () => ({
  adjustRatings: (input: { players: Array<{ id: string }> }) => {
    h.adjusterPlayers.push(input.players.map((p) => p.id));
    // As the real one: one entry per player it was given, zero for silence.
    return Promise.resolve(
      new Map(input.players.map((p) => [p.id, h.adjusterResult.get(p.id) ?? { playerId: p.id, delta: 0, reason: "No reason", confidence: 0 }])),
    );
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findUnique: () => Promise.resolve(buildMatchRow()),
      update: () => Promise.resolve({}),
    },
    teamAssignment: {
      deleteMany: () => Promise.resolve({ count: 0 }),
      createMany: () => Promise.resolve({ count: 0 }),
    },
    rating: { findMany: () => Promise.resolve([]) },
    membership: {
      findMany: () => Promise.resolve(SQUAD.map((p) => ({ userId: p.id, seedRating: p.seed }))),
    },
    user: {
      findMany: () => Promise.resolve(SQUAD.map((p) => ({ id: p.id, name: p.name }))),
    },
    analyzedMessage: {
      findMany: () =>
        Promise.resolve([{ authorUserId: "u-a", body: "bit tired after work but in", createdAt: new Date(MATCH_DATE.getTime() - 3_600_000) }]),
    },
    formNote: {
      findMany: () => (h.notesThrow ? Promise.reject(new Error('relation "FormNote" does not exist')) : Promise.resolve(h.notes)),
    },
    ratingAdjustment: {
      upsert: (args: { create: { userId: string; delta: number; reason: string; confidence: number } }) => {
        h.upserts.push(args.create);
        return Promise.resolve({});
      },
    },
    userAlias: { findMany: () => Promise.resolve([]) },
  },
}));
vi.mock("@/lib/ai-budget", () => ({ withOrgAiBudget: (_org: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/player-display-name", () => ({
  loadPlayerNames: async (_org: string, ids: string[]) => new Map(ids.map((id) => [id, { display: id }])),
}));

import { generateTeamsForMatch } from "@/lib/team-generation";

function buildMatchRow() {
  return {
    id: MATCH_ID,
    activityId: "act-1",
    date: MATCH_DATE,
    status: "UPCOMING",
    maxPlayers: null,
    teamLabels: [],
    activity: {
      orgId: ORG_ID,
      venue: "The Cage",
      minPlayers: null,
      maxPlayers: null,
      org: { id: ORG_ID, name: "FNF", teamLabels: [], language: "en" },
      sport: { name: "Football 3-a-side", playersPerTeam: 3, balancingStrategy: "rating-only", positionComposition: null, teamLabels: [] },
    },
    attendances: SQUAD.map((p) => ({ userId: p.id, user: { name: p.name, image: null, activityPositions: [] } })),
  };
}

const adj = (playerId: string, delta: number) => ({ playerId, delta, reason: "from the chat", confidence: 0.8 });
const row = (userId: string) => h.upserts.find((u) => u.userId === userId);

beforeEach(() => {
  h.notes = [];
  h.adjusterPlayers = [];
  h.adjusterResult = new Map();
  h.upserts = [];
  h.notesThrow = false;
});

describe("a stored form note when the teams are made", () => {
  it("wins for that player; the adjuster runs for everyone else and is not asked about the noted player", async () => {
    h.notes = [{ userId: "u-a", delta: -1, reason: "tired" }];
    h.adjusterResult = new Map([
      ["u-a", adj("u-a", -0.5)],
      ["u-b", adj("u-b", 0.5)],
    ]);
    const r = await generateTeamsForMatch(MATCH_ID);
    expect(r.ok).toBe(true);
    expect(h.adjusterPlayers).toEqual([["u-b", "u-c", "u-d", "u-e", "u-f"]]);
    expect(row("u-a")).toEqual({ matchId: MATCH_ID, userId: "u-a", delta: -1, reason: "Form note in the chat: tired", confidence: 1 });
    expect(row("u-b")!.delta).toBe(0.5);
    expect(row("u-c")!.delta).toBe(0);
  });

  it("a cancelled note (0) keeps the adjuster off the player", async () => {
    h.notes = [{ userId: "u-a", delta: 0, reason: "" }];
    h.adjusterResult = new Map([["u-a", adj("u-a", -0.5)]]);
    await generateTeamsForMatch(MATCH_ID);
    expect(row("u-a")).toMatchObject({ delta: 0, reason: "Form note in the chat: no adjustment" });
  });

  it("with no notes, the adjuster decides for everyone, as before", async () => {
    h.adjusterResult = new Map([["u-a", adj("u-a", -0.5)]]);
    await generateTeamsForMatch(MATCH_ID);
    expect(h.adjusterPlayers[0]).toHaveLength(6);
    expect(row("u-a")!.delta).toBe(-0.5);
  });

  it("the notes cannot be read (the table not migrated yet): the adjuster alone, the teams still made", async () => {
    h.notesThrow = true;
    h.adjusterResult = new Map([["u-a", adj("u-a", -0.5)]]);
    const r = await generateTeamsForMatch(MATCH_ID);
    expect(r.ok).toBe(true);
    expect(row("u-a")!.delta).toBe(-0.5);
  });

  it("every player noted: no adjuster call at all", async () => {
    h.notes = SQUAD.map((p) => ({ userId: p.id, delta: -0.5, reason: "tired" }));
    await generateTeamsForMatch(MATCH_ID);
    expect(h.adjusterPlayers).toEqual([]);
    expect(h.upserts).toHaveLength(6);
    expect(h.upserts.every((u) => u.delta === -0.5)).toBe(true);
  });
});
