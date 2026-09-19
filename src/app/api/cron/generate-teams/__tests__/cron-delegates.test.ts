/**
 * THE CRON IS NOT A SECOND OPINION.
 *
 * `/api/cron/generate-teams` used to carry its own rating formula:
 *
 *   ratings.length >= 3 ? mean(last 60 peer scores) : User.seedRating ?? 5.0
 *
 * a global, un-club-scoped step function, followed by its own
 * `balanceTeams` call, its own deleteMany + createMany, and its own
 * flip of `Match.status`. It ran live at `0 12 * * *` (`vercel.json`),
 * so a squad that hit its attendance deadline before noon UTC could get
 * a sheet nobody could reproduce by pressing either human button.
 *
 * Slice 3 of `MDs/club-scoped-ratings-design-2026-09-18.md` deletes
 * that formula. The cron now calls `generateTeamsForMatch`, the same
 * club-scoped, LLM-adjusted implementation behind "@Match Time generate
 * the teams" and the admin dashboard's Generate button, and goes back
 * to being the auto-publish and auto-complete maintenance job its own
 * header already claimed it was.
 *
 * This file tests the OUTPUT, not the arithmetic. Matching numbers
 * would still have left the cron capable of producing a different sheet
 * from the bot, which is the thing that was wrong.
 *
 * ── THE FIXTURE, AND WHY FARUK EXISTS ────────────────────────────────
 *
 * Six players, 3-a-side, `rating-only` (a pure snake draft, no
 * hill-climb, so the sheet is deterministic and reads as a line-up).
 *
 *              club seed   club peer scores   DELETED cron   the shared helper
 *   Ayse            9      9, 9, 9                 9.00       9.00
 *   Bilal           8      8, 8, 8                 8.00       8.00
 *   Cem             6      6, 6, 6                 6.00       6.00
 *   Deniz           4      4, 4, 4                 4.00       4.00
 *   Emre            3      3, 3, 3                 3.00       3.00
 *   Faruk          10      1                      10.00       7.75
 *
 * Faruk is the case the step function gets wrong. He has ONE peer
 * rating, a 1, from the only night his club has rated him. Below the
 * cron's hardcoded threshold of 3 that rating counted for nothing at
 * all, so the cron drafted him FIRST on a seed of 10. The shared
 * helper's Bayesian blend gives the single 1 a quarter of the weight,
 * (1 + 10 x 3) / (1 + 3) = 7.75, and drafts him THIRD, which is where a
 * squad that has seen him play would put him.
 *
 * Those two orders produce two different team sheets, which is what
 * makes "the cron agrees with the helper" a claim worth asserting.
 *
 * db, the org feature flags, match completion and the LLM adjuster are
 * all mocked. No DB, no network, no model call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const MATCH_ID = "match-1";
const ORG_ID = "org-1";
const CRON_SECRET = "test-cron-secret";

const SQUAD = [
  { id: "u-ayse", name: "Ayse", seed: 9, peers: [9, 9, 9] },
  { id: "u-bilal", name: "Bilal", seed: 8, peers: [8, 8, 8] },
  { id: "u-cem", name: "Cem", seed: 6, peers: [6, 6, 6] },
  { id: "u-deniz", name: "Deniz", seed: 4, peers: [4, 4, 4] },
  { id: "u-emre", name: "Emre", seed: 3, peers: [3, 3, 3] },
  { id: "u-faruk", name: "Faruk", seed: 10, peers: [1] },
];

// ─────────────────────────── the fake database ───────────────────────────

const getOrgFeaturesMock = vi.fn();
const completeFinishedMatchesMock = vi.fn();
const adjustRatingsMock = vi.fn();

/** Every write either path makes, in order, so a test can assert on what
 *  reached Postgres rather than on a return value. */
let writes: { op: string; args: unknown }[] = [];
/** Anything that would put a message in front of the WhatsApp group. */
let botJobWrites: unknown[] = [];

/** The UPCOMING, past-deadline matches the cron's first query finds. */
let upcomingMatches: Record<string, unknown>[] = [];
/** The TEAMS_GENERATED matches its auto-publish query finds. */
let publishQueue: Record<string, unknown>[] = [];

function record(op: string) {
  return (args: unknown) => {
    writes.push({ op, args });
    return Promise.resolve({ count: 0 });
  };
}

function recordBotJob(args: unknown) {
  botJobWrites.push(args);
  return Promise.resolve({ id: "job", count: 0 });
}

vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: (...a: unknown[]) => getOrgFeaturesMock(...a),
}));
vi.mock("@/lib/match-completion", () => ({
  completeFinishedMatches: (...a: unknown[]) => completeFinishedMatchesMock(...a),
}));
vi.mock("@/lib/rating-adjuster", () => ({
  adjustRatings: (...a: unknown[]) => adjustRatingsMock(...a),
}));
vi.mock("@/lib/db", () => ({
  db: {
    match: {
      // The cron runs two finds: the generation sweep and the
      // auto-publish sweep. They are told apart by the status they ask
      // for, so a test can seed either one independently.
      findMany: (args: { where?: { status?: string } }) =>
        Promise.resolve(args.where?.status === "TEAMS_GENERATED" ? publishQueue : upcomingMatches),
      // The shared helper's own read.
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(upcomingMatches.find((m) => m.id === args.where.id) ?? null),
      update: record("match.update"),
    },
    teamAssignment: {
      deleteMany: record("teamAssignment.deleteMany"),
      createMany: record("teamAssignment.createMany"),
    },
    rating: {
      findMany: (args: {
        where: { playerId: string; match?: { activity?: { orgId?: string } } };
      }) => {
        const orgId = args.where.match?.activity?.orgId;
        if (orgId && orgId !== ORG_ID) return Promise.resolve([]);
        const p = SQUAD.find((s) => s.id === args.where.playerId);
        return Promise.resolve(p ? p.peers.map((score) => ({ score })) : []);
      },
      // The club mean, the prior of last resort. Every player here has a
      // club seed, so it never reaches the arithmetic.
      aggregate: () => Promise.resolve({ _avg: { score: 6 } }),
    },
    membership: {
      findMany: (args: { where: { orgId?: string } }) =>
        Promise.resolve(
          args.where.orgId === ORG_ID
            ? SQUAD.map((p) => ({ userId: p.id, seedRating: p.seed }))
            : [],
        ),
    },
    analyzedMessage: { findMany: () => Promise.resolve([]) },
    user: { findMany: () => Promise.resolve([]) },
    ratingAdjustment: { upsert: record("ratingAdjustment.upsert") },
    botJob: {
      create: (a: unknown) => recordBotJob(a),
      createMany: (a: unknown) => recordBotJob(a),
      upsert: (a: unknown) => recordBotJob(a),
    },
  },
}));

import { GET } from "@/app/api/cron/generate-teams/route";
import { generateTeamsForMatch } from "@/lib/team-generation";

/** The match row BOTH the cron's sweep and the helper's findUnique read.
 *  The two includes differ (the helper also pulls `activity.org`), so the
 *  fixture carries the union, which is what a real row would give. */
function buildMatchRow(): Record<string, unknown> {
  return {
    id: MATCH_ID,
    activityId: "act-1",
    date: new Date("2026-09-22T20:30:00Z"),
    status: "UPCOMING",
    teamLabels: [],
    activity: {
      orgId: ORG_ID,
      venue: "The Cage",
      org: { id: ORG_ID, name: "Sutton FC", teamLabels: [], language: "en" },
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
        // Still on the row, still the same numbers, and deliberately so:
        // the DELETED cron formula read `User.seedRating` straight off
        // the attendance include. Leaving it here means the old code
        // runs to completion and fails on the LINE-UP rather than dying
        // on a missing mock, which is what makes the red half of this
        // cycle prove something.
        seedRating: p.seed,
        activityPositions: [],
      },
    })),
  };
}

function cronRequest(secret = CRON_SECRET) {
  return new Request("https://matchtime.app/api/cron/generate-teams", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

/** The team sheet the run wrote, as "Name:TEAM" sorted. */
function sheetFromWrites(): string[] {
  const create = writes.find((w) => w.op === "teamAssignment.createMany");
  if (!create) return [];
  const data = (create.args as { data: { userId: string; team: string }[] }).data;
  return data.map((r) => `${SQUAD.find((s) => s.id === r.userId)!.name}:${r.team}`).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  botJobWrites = [];
  upcomingMatches = [buildMatchRow()];
  publishQueue = [];
  process.env.CRON_SECRET = CRON_SECRET;
  getOrgFeaturesMock.mockResolvedValue({ teamBalancing: true });
  completeFinishedMatchesMock.mockResolvedValue({ completed: 0 });
  adjustRatingsMock.mockResolvedValue(new Map());
  // `rating-only` never draws one; belt and braces so a future change of
  // fixture strategy cannot make this file flaky.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────── the whole point ───────────────────────────

describe("the generate-teams cron delegates to the shared helper", () => {
  it("builds the SAME sheet the shared helper builds for the same squad", async () => {
    await GET(cronRequest());
    const viaCron = sheetFromWrites();

    writes = [];
    await generateTeamsForMatch(MATCH_ID);
    const viaHelper = sheetFromWrites();

    expect(viaCron.length).toBe(6);
    expect(viaCron).toEqual(viaHelper);
  });

  it("drafts Faruk on his club rating, not on a seed his peers have contradicted", async () => {
    await GET(cronRequest());

    // Helper draft order: Ayse 9, Bilal 8, Faruk 7.75, Cem 6, Deniz 4,
    // Emre 3 -> RED Ayse/Cem/Deniz, YELLOW Bilal/Faruk/Emre.
    //
    // The DELETED step function ordered Faruk 10, Ayse 9, Bilal 8,
    // Cem 6, Deniz 4, Emre 3 and produced RED Faruk/Cem/Deniz,
    // YELLOW Ayse/Bilal/Emre. This assertion is the one that fails on
    // the old code.
    expect(sheetFromWrites()).toEqual(
      ["Ayse:RED", "Bilal:YELLOW", "Cem:RED", "Deniz:RED", "Emre:YELLOW", "Faruk:YELLOW"].sort(),
    );
  });

  it("runs the LLM rating adjuster the old inline formula skipped", async () => {
    await GET(cronRequest());
    expect(adjustRatingsMock).toHaveBeenCalledTimes(1);
  });

  it("still reports what it generated, and still flips the match", async () => {
    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ generated: 1, skippedNoTeamBalancing: 0 });
    const statusWrite = writes.find(
      (w) =>
        w.op === "match.update" &&
        (w.args as { data?: { status?: string } }).data?.status === "TEAMS_GENERATED",
    );
    expect(statusWrite).toBeDefined();
  });
});

// ─────────────────────────── what must NOT happen ───────────────────────────

describe("the cron stays silent", () => {
  it("queues ZERO BotJob rows: the returned line-up is dropped, not posted", async () => {
    // `generateTeamsForMatch` RETURNS a ready-to-post group message and
    // queues nothing. The WhatsApp route posts that string; the admin
    // dashboard discards it; the cron must go on discarding it too.
    // Delegation must not turn a maintenance job into a group poster.
    await GET(cronRequest());
    expect(botJobWrites).toEqual([]);
  });

  it("does not leak the line-up into its own JSON response either", async () => {
    const body = await (await GET(cronRequest())).json();
    expect(Object.keys(body).sort()).toEqual(
      ["completed", "generated", "published", "skippedNoTeamBalancing"].sort(),
    );
  });
});

// ─────────────────────────── the guards that stayed ───────────────────────────

describe("the guards the route already had", () => {
  it("an unauthorised caller gets 401 and nothing is read or written", async () => {
    const res = await GET(cronRequest("wrong"));
    expect(res.status).toBe(401);
    expect(writes).toEqual([]);
    expect(getOrgFeaturesMock).not.toHaveBeenCalled();
  });

  it("an org with teamBalancing OFF is skipped, and counted", async () => {
    // Without this gate a fully-attended MoM-only org (Amir's Thursday
    // group via squad-from-list) would silently get TeamAssignment rows
    // that never reach the group, polluting the DB.
    getOrgFeaturesMock.mockResolvedValue({ teamBalancing: false });
    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ generated: 0, skippedNoTeamBalancing: 1 });
    expect(writes).toEqual([]);
    expect(botJobWrites).toEqual([]);
  });

  it("the feature gate runs BEFORE anything is read for the balancer", async () => {
    getOrgFeaturesMock.mockResolvedValue({ teamBalancing: false });
    await GET(cronRequest());
    expect(adjustRatingsMock).not.toHaveBeenCalled();
  });

  it("too few confirmed players is skipped, with no partial sheet written", async () => {
    const row = buildMatchRow();
    row.attendances = (row.attendances as unknown[]).slice(0, 4);
    upcomingMatches = [row];
    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ generated: 0 });
    expect(writes).toEqual([]);
  });

  it("one org's skip does not stop the next match being generated", async () => {
    // The loop is a sweep over every club. A `continue` must stay a
    // `continue`: a bailed match cannot take the rest of the run with it.
    const skipped = buildMatchRow();
    skipped.id = "match-skipped";
    (skipped.activity as { orgId: string }).orgId = "org-off";
    upcomingMatches = [skipped, buildMatchRow()];
    getOrgFeaturesMock.mockImplementation((orgId: string) =>
      Promise.resolve({ teamBalancing: orgId === ORG_ID }),
    );
    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ generated: 1, skippedNoTeamBalancing: 1 });
    expect(sheetFromWrites().length).toBe(6);
  });
});

// ─────────────────────── the maintenance job it really is ───────────────────────

describe("auto-publish and auto-complete are untouched", () => {
  it("publishes teams generated more than an hour ago", async () => {
    publishQueue = [{ id: "match-old" }, { id: "match-older" }];
    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ published: 2 });
    const publishes = writes.filter(
      (w) =>
        w.op === "match.update" &&
        (w.args as { data?: { status?: string } }).data?.status === "TEAMS_PUBLISHED",
    );
    expect(publishes.length).toBe(2);
  });

  it("still calls the idempotent match-completion backstop and reports it", async () => {
    completeFinishedMatchesMock.mockResolvedValue({ completed: 3 });
    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ completed: 3 });
    expect(completeFinishedMatchesMock).toHaveBeenCalledTimes(1);
  });

  it("completes matches even when no teams could be generated", async () => {
    getOrgFeaturesMock.mockResolvedValue({ teamBalancing: false });
    completeFinishedMatchesMock.mockResolvedValue({ completed: 1 });
    const res = await GET(cronRequest());
    expect(await res.json()).toMatchObject({ generated: 0, completed: 1 });
  });
});
