/**
 * THE RATING ADJUSTER READS THE NEWEST CHAT OF THE WEEK, NOT THE OLDEST
 * (Kemal, 2026-10-20).
 *
 * `runRatingAdjuster` asked Postgres for the week's messages oldest first
 * and took 300. In a busy group that kept Monday's banter and dropped the
 * match-day lines that matter ("pulled my hamstring this morning"). It now
 * takes the NEWEST 300 and hands them to the adjuster oldest first, which
 * is also what `adjustRatings`' own `slice(-MAX_HISTORY_MESSAGES)` keeps.
 *
 * The db is a small in-memory fake that honours `orderBy` and `take`, so
 * the test proves what a real query returns, not the shape of the call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const MATCH_ID = "match-1";
const ORG_ID = "org-fnf";
const MATCH_DATE = new Date("2026-10-23T19:30:00Z");

const SQUAD = [
  { id: "u-a", name: "Ayse", seed: 9 },
  { id: "u-b", name: "Bilal", seed: 8 },
  { id: "u-c", name: "Cem", seed: 6 },
  { id: "u-d", name: "Deniz", seed: 4 },
  { id: "u-e", name: "Emre", seed: 3 },
  { id: "u-f", name: "Faruk", seed: 5 },
];

// 400 messages over the week before the match, one every 20 minutes,
// ending on match day. The last one is the injury line.
const ROWS = Array.from({ length: 400 }, (_, i) => ({
  authorUserId: SQUAD[i % SQUAD.length].id,
  body: i === 399 ? "pulled my hamstring this morning, I'll play but can't run" : `message ${i}`,
  createdAt: new Date(MATCH_DATE.getTime() - (400 - i) * 20 * 60 * 1000),
}));

let adjusterInputs: Array<{ messages: Array<{ authorName: string | null; body: string; timestamp: Date }> }> = [];

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/rating-adjuster", () => ({
  adjustRatings: (input: { messages: Array<{ authorName: string | null; body: string; timestamp: Date }> }) => {
    adjusterInputs.push(input);
    return Promise.resolve(new Map());
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
    rating: {
      findMany: () => Promise.resolve([{ score: 7 }]),
      aggregate: () => Promise.resolve({ _avg: { score: 6.5 } }),
    },
    membership: {
      findMany: () => Promise.resolve(SQUAD.map((p) => ({ userId: p.id, seedRating: p.seed }))),
      findUnique: () => Promise.resolve({ userId: "u-a", seedRating: 9 }),
    },
    user: {
      findMany: (args: { where?: { id?: { in?: string[] } } }) =>
        Promise.resolve(SQUAD.filter((p) => args.where?.id?.in?.includes(p.id) ?? true).map((p) => ({ id: p.id, name: p.name }))),
      findUnique: () => Promise.resolve(null),
    },
    analyzedMessage: {
      findMany: (args: {
        where?: { createdAt?: { gte?: Date } };
        orderBy?: { createdAt?: "asc" | "desc" };
        take?: number;
      }) => {
        const gte = args.where?.createdAt?.gte;
        let rows = ROWS.filter((r) => !gte || r.createdAt >= gte);
        rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (args.orderBy?.createdAt === "desc") rows.reverse();
        if (typeof args.take === "number") rows = rows.slice(0, args.take);
        return Promise.resolve(rows);
      },
    },
    ratingAdjustment: { upsert: () => Promise.resolve({}) },
    botJob: {
      create: () => Promise.resolve({}),
      createMany: () => Promise.resolve({}),
      upsert: () => Promise.resolve({}),
    },
  },
}));

import { generateTeamsForMatch } from "@/lib/team-generation";

function buildMatchRow() {
  return {
    id: MATCH_ID,
    activityId: "act-1",
    date: MATCH_DATE,
    status: "UPCOMING",
    teamLabels: [],
    activity: {
      orgId: ORG_ID,
      venue: "The Cage",
      org: { id: ORG_ID, name: "FNF", teamLabels: [], language: "en" },
      sport: {
        name: "Football 3-a-side",
        playersPerTeam: 3,
        balancingStrategy: "rating-only",
        positionComposition: null,
        teamLabels: [],
      },
    },
    attendances: SQUAD.map((p) => ({
      userId: p.id,
      user: { name: p.name, image: null, seedRating: 1, matchRating: 1000, activityPositions: [] },
    })),
  };
}

beforeEach(() => {
  adjusterInputs = [];
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

describe("the rating adjuster's chat window", () => {
  it("with 400 messages in the week, it gets the NEWEST 300, oldest first", async () => {
    await generateTeamsForMatch(MATCH_ID);
    expect(adjusterInputs).toHaveLength(1);
    const msgs = adjusterInputs[0].messages;
    expect(msgs).toHaveLength(300);
    expect(msgs[0].body).toBe("message 100");
    expect(msgs[299].body).toBe("pulled my hamstring this morning, I'll play but can't run");
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].timestamp.getTime()).toBeGreaterThan(msgs[i - 1].timestamp.getTime());
    }
  });

  it("names each line by the roster name", async () => {
    await generateTeamsForMatch(MATCH_ID);
    const last = adjusterInputs[0].messages[299];
    expect(last.authorName).toBe(SQUAD[399 % SQUAD.length].name);
  });
});
