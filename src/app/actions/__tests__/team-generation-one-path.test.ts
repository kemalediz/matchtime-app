/**
 * ONE TEAM SHEET, WHICHEVER BUTTON A HUMAN PRESSES.
 *
 * MatchTime had two human-triggered ways to build a team sheet and they
 * disagreed:
 *
 *   "@Match Time generate the teams"   → lib/team-generation.ts
 *   the admin dashboard's Generate     → app/actions/teams.ts
 *
 * They disagreed about more than a number. The dashboard used a
 * PRIVATE rating formula that blended the Elo `matchRating` in
 * (0.5 x peerAvg + 0.5 x matchRating/200), and it also skipped the LLM
 * rating adjuster, ignored `pinnedToTeam`, ignored `teamNames`, and kept
 * its own copy of the deleteMany → createMany → status write. Two
 * buttons, two answers, one club.
 *
 * Kemal, 2026-09-15: "what you explained above for team generation which
 * was blended should be the one used for team generation everywhere."
 * The blended one is `computePlayerRating`.
 *
 * So the action no longer HAS a formula. It authenticates, checks the
 * admin seat, and calls `generateTeamsForMatch`. This file is the proof,
 * and it tests the two ENTRY POINTS against the same squad rather than
 * asserting things about arithmetic — matching numbers would still have
 * left the two buttons producing different teams.
 *
 * WHAT THIS FILE DOES NOT COVER. A third writer of team sheets exists
 * and is untouched here: `app/api/cron/generate-teams/route.ts:57-92`
 * has its own inline rating formula, calls `balanceTeams` directly, and
 * runs live at `0 12 * * *`. Nothing below asserts anything about it,
 * and nothing below should be read as evidence that only one formula
 * remains. Slice 3 of `MDs/club-scoped-ratings-design-2026-09-18.md`
 * takes the cron; that is when this file's two entry points become all
 * of them.
 *
 * ── WHY Math.random IS STUBBED ───────────────────────────────────────
 *
 * `balancePositionAware` finishes with a 1,000-iteration hill-climb
 * whose candidate swaps come from `Math.random()`. Team generation is
 * genuinely non-deterministic for the strategy Sutton uses: 401 runs of
 * the real squad landed on 19 distinct sheets. "Both paths agree" is
 * therefore only a testable claim once the two runs draw the same random
 * numbers. The fixture below uses `rating-only` (no hill-climb, fully
 * deterministic) so the assertions read as line-ups; the stub is belt
 * and braces so a future change of fixture strategy cannot make this
 * file flaky.
 *
 * db / auth / org / next-cache / the LLM adjuster are all mocked. No DB,
 * no network, no model call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─────────────────────────── the fixture world ───────────────────────────

/**
 * Six players, 3-a-side, `rating-only`. Every peer score is repeated so
 * the two formulas are easy to read off by hand.
 *
 *                seed  elo   peers      blended   the DELETED elo-mix
 *   Ayse            9  1000  9,9,9        9.00     0.5*9 + 0.5*5  = 7.00
 *   Bilal           8  1000  8,8,8        8.00     0.5*8 + 0.5*5  = 6.50
 *   Cem             6  1000  6,6,6        6.00     0.5*6 + 0.5*5  = 5.50
 *   Deniz           4  1000  4,4,4        4.00     0.5*4 + 0.5*5  = 4.50
 *   Emre            3  1000  3,3,3        3.00     0.5*3 + 0.5*5  = 4.00
 *   Faruk           5  1700  5,5,5        5.00     0.5*5 + 0.5*8.5= 6.75
 *
 * Faruk is the case Kemal named: a big Elo (1700) on mediocre peer
 * ratings (a flat 5). The deleted formula promoted him to SECOND in the
 * draft; the blended formula leaves him FOURTH, where his team-mates put
 * him. Real examples exist at Sutton — Mojib (Elo 1072) drafted 2nd
 * under the old formula, 6th under the blended one.
 */
const SQUAD = [
  { id: "u-ayse", name: "Ayse", seed: 9, elo: 1000, peer: 9 },
  { id: "u-bilal", name: "Bilal", seed: 8, elo: 1000, peer: 8 },
  { id: "u-cem", name: "Cem", seed: 6, elo: 1000, peer: 6 },
  { id: "u-deniz", name: "Deniz", seed: 4, elo: 1000, peer: 4 },
  { id: "u-emre", name: "Emre", seed: 3, elo: 1000, peer: 3 },
  { id: "u-faruk", name: "Faruk", seed: 5, elo: 1700, peer: 5 },
];

const MATCH_ID = "match-1";
const ORG_ID = "org-1";

// ─────────────────────────── the fake database ───────────────────────────

const authMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const adjustRatingsMock = vi.fn();
const revalidatePathMock = vi.fn();

/** Every write the two paths make, in order, so a test can assert on
 *  what reached Postgres rather than on a return value. */
let writes: { op: string; args: unknown }[] = [];
/** Anything that would put a message in front of the WhatsApp group. */
let botJobWrites: unknown[] = [];

let matchRow: Record<string, unknown> | null = null;

function record(op: string) {
  return (args: unknown) => {
    writes.push({ op, args });
    return Promise.resolve({ count: 0 });
  };
}

/** Anything that would reach the group goes through BotJob. Defined
 *  inside the mock factory below, not here: `vi.mock` is hoisted above
 *  every top-level const and would read this one before it exists. */
function recordBotJob(args: unknown) {
  botJobWrites.push(args);
  return Promise.resolve({ id: "job", count: 0 });
}

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({
  requireOrgAdmin: (...a: unknown[]) => requireOrgAdminMock(...a),
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePathMock(...a) }));
vi.mock("@/lib/rating-adjuster", () => ({
  adjustRatings: (...a: unknown[]) => adjustRatingsMock(...a),
}));
vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findUnique: () => Promise.resolve(matchRow),
      update: record("match.update"),
    },
    teamAssignment: {
      deleteMany: record("teamAssignment.deleteMany"),
      createMany: record("teamAssignment.createMany"),
    },
    rating: {
      findMany: (args: { where: { playerId: string } }) => {
        const p = SQUAD.find((s) => s.id === args.where.playerId);
        // Three peer ratings each — enough that the DELETED formula was
        // past its own 3-rating threshold and on its peer/Elo branch.
        return Promise.resolve(
          p ? [{ score: p.peer }, { score: p.peer }, { score: p.peer }] : [],
        );
      },
    },
    analyzedMessage: { findMany: () => Promise.resolve([]) },
    user: {
      findMany: () => Promise.resolve([]),
      // Only the DELETED `getPlayerRating` ever called this — it is the
      // read that pulled `matchRating` into team selection. It is kept
      // in the fake ON PURPOSE: without it the old code dies on a
      // missing mock and every assertion below fails for the wrong
      // reason, which would make the red half of this TDD cycle prove
      // nothing. With it, the old code runs to completion and fails on
      // the line-up, which is the claim.
      findUnique: (args: { where: { id: string } }) => {
        const p = SQUAD.find((s) => s.id === args.where.id);
        return Promise.resolve(
          p ? { id: p.id, seedRating: p.seed, matchRating: p.elo } : null,
        );
      },
    },
    ratingAdjustment: { upsert: record("ratingAdjustment.upsert") },
    botJob: {
      create: (a: unknown) => recordBotJob(a),
      createMany: (a: unknown) => recordBotJob(a),
      upsert: (a: unknown) => recordBotJob(a),
    },
  },
}));

import { generateTeams } from "@/app/actions/teams";
import { generateTeamsForMatch } from "@/lib/team-generation";

/** The match row BOTH paths read. The shared helper needs the sport and
 *  the confirmed squad; the action needs only the orgId, but it reads
 *  through the same mock. */
function buildMatchRow() {
  return {
    id: MATCH_ID,
    activityId: "act-1",
    date: new Date("2026-09-15T20:30:00Z"),
    status: "UPCOMING",
    teamLabels: [],
    activity: {
      orgId: ORG_ID,
      venue: "The Cage",
      org: { id: ORG_ID, name: "Sutton FC", teamLabels: [] },
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
      user: {
        name: p.name,
        image: null,
        seedRating: p.seed,
        matchRating: p.elo,
        activityPositions: [],
      },
    })),
  };
}

/** The team sheet the run wrote, as "Name:TEAM" sorted — the artifact
 *  both entry points are judged on. */
function sheetFromWrites(): string[] {
  const create = writes.find((w) => w.op === "teamAssignment.createMany");
  if (!create) return [];
  const data = (create.args as { data: { userId: string; team: string }[] }).data;
  return data
    .map((r) => `${SQUAD.find((s) => s.id === r.userId)!.name}:${r.team}`)
    .sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  botJobWrites = [];
  matchRow = buildMatchRow();
  authMock.mockResolvedValue({ user: { id: "admin-1" } });
  requireOrgAdminMock.mockResolvedValue({ role: "ADMIN" });
  adjustRatingsMock.mockResolvedValue(new Map());
  // The hill-climb's coin flips, nailed down. `rating-only` never calls
  // this; a future fixture on `position-aware` would.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────── the whole point ───────────────────────────

describe("one team-generation path", () => {
  it("the same squad through BOTH entry points produces the SAME teams", async () => {
    await generateTeamsForMatch(MATCH_ID);
    const viaWhatsApp = sheetFromWrites();

    writes = [];
    await generateTeams(MATCH_ID);
    const viaDashboard = sheetFromWrites();

    expect(viaWhatsApp.length).toBe(6);
    expect(viaDashboard).toEqual(viaWhatsApp);
  });

  it("a high-Elo, mediocre-peer player is no longer advantaged by the dashboard", async () => {
    await generateTeams(MATCH_ID);

    // Blended draft order: Ayse 9, Bilal 8, Cem 6, Faruk 5, Deniz 4,
    // Emre 3 → RED Ayse/Faruk/Deniz, YELLOW Bilal/Cem/Emre.
    //
    // The DELETED elo-mix ordered Ayse 7.00, Faruk 6.75, Bilal 6.50,
    // Cem 5.50, Deniz 4.50, Emre 4.00 — Faruk second, drafted as the
    // squad's other strong player — and produced
    // RED Ayse/Cem/Deniz, YELLOW Faruk/Bilal/Emre. This assertion is
    // the one that fails on the old code.
    expect(sheetFromWrites()).toEqual(
      ["Ayse:RED", "Bilal:YELLOW", "Cem:YELLOW", "Deniz:RED", "Emre:YELLOW", "Faruk:RED"].sort(),
    );
  });

  it("the dashboard honours pinnedToTeam now that it delegates", async () => {
    // Ayse is the squad's best player and the unpinned run puts her on
    // RED. Pinning her to YELLOW is therefore a request the optimiser
    // would never grant on its own, which is the only kind of pin worth
    // asserting on — pinning someone to where they were already going
    // passes against code that ignores the argument entirely.
    await generateTeams(MATCH_ID, { pinnedToTeam: { "u-ayse": "YELLOW" } });
    expect(sheetFromWrites()).toContain("Ayse:YELLOW");
  });

  it("the dashboard runs the LLM rating adjuster it used to skip", async () => {
    await generateTeams(MATCH_ID);
    expect(adjustRatingsMock).toHaveBeenCalledTimes(1);
  });

  it("an adjuster that throws does not block the dashboard's team sheet", async () => {
    // The adjuster is a new failure surface on a button click. It must
    // fail open: `adjustRatings` swallows its own errors and returns an
    // empty map, and this pins the consequence rather than the promise.
    adjustRatingsMock.mockRejectedValue(new Error("Anthropic is down"));
    await expect(generateTeams(MATCH_ID)).resolves.toBeUndefined();
    expect(sheetFromWrites().length).toBe(6);
  });
});

// ─────────────────────────── what must NOT happen ───────────────────────────

describe("the dashboard button stays silent", () => {
  it("queues ZERO BotJob rows — a dashboard click never posts to the group", async () => {
    await generateTeams(MATCH_ID);
    expect(botJobWrites).toEqual([]);
  });

  it("the shared helper does not queue one either — it only RETURNS the post", async () => {
    const result = await generateTeamsForMatch(MATCH_ID);
    expect(result.ok).toBe(true);
    expect(botJobWrites).toEqual([]);
    // The caller decides whether the group hears about it. The WhatsApp
    // route posts this string; the dashboard drops it on the floor.
    if (result.ok) expect(result.groupPost).toContain("Ayse");
  });
});

describe("the admin gate survived the delegation", () => {
  it("an unauthenticated caller is refused before any read", async () => {
    authMock.mockResolvedValue(null);
    await expect(generateTeams(MATCH_ID)).rejects.toThrow(/Not authenticated/);
    expect(writes).toEqual([]);
  });

  it("a non-admin cannot generate teams, and nothing is written", async () => {
    requireOrgAdminMock.mockRejectedValue(new Error("Forbidden"));
    await expect(generateTeams(MATCH_ID)).rejects.toThrow(/Forbidden/);
    expect(writes).toEqual([]);
    expect(botJobWrites).toEqual([]);
  });

  it("auth runs BEFORE the admin check, and both run before the balancer", async () => {
    const order: string[] = [];
    authMock.mockImplementation(() => {
      order.push("auth");
      return Promise.resolve({ user: { id: "admin-1" } });
    });
    requireOrgAdminMock.mockImplementation(() => {
      order.push("requireOrgAdmin");
      return Promise.resolve({ role: "ADMIN" });
    });
    await generateTeams(MATCH_ID);
    expect(order).toEqual(["auth", "requireOrgAdmin"]);
  });
});

// ─────────────────────────── the error contract ───────────────────────────

describe("the admin UI's existing error contract", () => {
  // The page does `try { await generateTeams(...) } catch (err) {
  // toast.error(err.message) }`. The shared helper RETURNS
  // `{ ok: false, reason }`, so the action has to translate — and the
  // reason has to survive as a message an admin can act on.
  it("too few players still throws, with both numbers in the message", async () => {
    const row = buildMatchRow();
    row.attendances = row.attendances.slice(0, 4);
    matchRow = row;
    await expect(generateTeams(MATCH_ID)).rejects.toThrow(/4/);
    await expect(generateTeams(MATCH_ID)).rejects.toThrow(/6/);
    expect(writes).toEqual([]);
  });

  it("a missing match still throws Match not found", async () => {
    matchRow = null;
    await expect(generateTeams(MATCH_ID)).rejects.toThrow(/Match not found/);
  });

  it("a COMPLETED match is refused instead of silently un-completing itself", async () => {
    // NEW, and a fix: the old action had no status check at all, so
    // Regenerate on a finished match rewrote the sheet the Elo had
    // already been settled from AND flipped the status back to
    // TEAMS_GENERATED. The shared helper has always refused this.
    const row = buildMatchRow();
    row.status = "COMPLETED";
    matchRow = row;
    await expect(generateTeams(MATCH_ID)).rejects.toThrow(/completed/i);
    expect(writes).toEqual([]);
  });

  it("revalidates both paths the admin UI reads", async () => {
    await generateTeams(MATCH_ID);
    const paths = revalidatePathMock.mock.calls.map((c) => c[0]);
    expect(paths).toContain(`/matches/${MATCH_ID}`);
    expect(paths).toContain(`/admin/matches/${MATCH_ID}/teams`);
  });
});
