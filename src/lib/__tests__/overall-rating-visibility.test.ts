/**
 * NOBODY SEES ANOTHER PLAYER'S OVERALL RATING. NOT A CLUBMATE, NOT AN
 * ADMIN, NOT THE MODEL ANSWERING A DM.
 *
 * Decision 4 of `MDs/club-scoped-ratings-design-2026-09-18.md`, section
 * 2, settled by Kemal on 2026-09-18:
 *
 *   - a player's stats page shows the CLUB ratings of other players in
 *     the same club, and club admins see them too;
 *   - a player sees their OWN overall rating;
 *   - nobody ever sees another player's overall rating.
 *
 * The overall is the mean of every rating a player has ever received at
 * every club they have ever played for, so it carries information from
 * clubs the viewer has nothing to do with. That is why it is the one
 * number in this codebase with an access rule.
 *
 * Section 5.3 says the rule is enforced by a test rather than by a
 * comment, and this is that test. It has two halves, because the risk
 * has two shapes:
 *
 *   1. RUNTIME. `loadAllClubsOverview` used to take a bare `userId`
 *      with no viewer and no authorisation. A page with a `[playerId]`
 *      route parameter in scope could hand it the wrong id and the
 *      function would cheerfully answer. It now takes both ids and
 *      refuses when they differ.
 *   2. STATIC. A future page can always add a correct-looking call. No
 *      runtime test catches a caller that does not exist yet, so the
 *      second half scans `src/` for every reference and pins the list
 *      to one file.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");

const ME = "u-me";
const OTHER = "u-other";
const LIVE_ORG = "org-sutton-fc";
const LEFT_ORG = "org-sutton-lads";

interface RatingRow {
  playerId: string;
  orgId: string;
  score: number;
}

let ratingRows: RatingRow[] = [];
/** Memberships, including the one the player has LEFT. */
let membershipRows: { userId: string; orgId: string; orgName: string; leftAt: Date | null }[] = [];
let attendanceRows: { userId: string; orgId: string }[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    membership: {
      findMany: (args: { where: { userId?: string; leftAt?: null } }) =>
        Promise.resolve(
          membershipRows
            .filter((m) => m.userId === args.where?.userId)
            .filter((m) => (args.where?.leftAt === null ? m.leftAt === null : true))
            .map((m) => ({ org: { id: m.orgId, name: m.orgName } })),
        ),
      findUnique: () => Promise.resolve({ seedRating: null }),
    },
    rating: {
      findMany: (args: {
        where: {
          playerId?: string;
          match?: { activity?: { orgId?: { in?: string[] } | string } };
        };
      }) => {
        const scope = args.where?.match?.activity?.orgId;
        const allowed =
          typeof scope === "object" && scope !== null && Array.isArray(scope.in) ? scope.in : null;
        return Promise.resolve(
          ratingRows
            .filter((r) => r.playerId === args.where?.playerId)
            .filter((r) => (allowed ? allowed.includes(r.orgId) : true))
            .map((r) => ({ score: r.score, match: { activity: { orgId: r.orgId } } })),
        );
      },
      aggregate: () => Promise.resolve({ _avg: { score: null } }),
    },
    attendance: {
      findMany: (args: { where: { userId?: string } }) =>
        Promise.resolve(
          attendanceRows
            .filter((a) => a.userId === args.where?.userId)
            .map((a) => ({ match: { activity: { orgId: a.orgId } } })),
        ),
    },
    match: {
      findMany: () => Promise.resolve([]),
    },
  },
}));

beforeEach(() => {
  ratingRows = [];
  membershipRows = [];
  attendanceRows = [];
});

async function overview(args: { userId: string; viewerId: string }) {
  const { loadAllClubsOverview } = await import("@/lib/player-stats");
  return loadAllClubsOverview(args);
}

// ───────────────────────── 1. the runtime rule ─────────────────────────

describe("loading another player's overall rating is refused", () => {
  beforeEach(() => {
    membershipRows = [
      { userId: OTHER, orgId: LIVE_ORG, orgName: "Sutton Football Club", leftAt: null },
    ];
    for (let i = 0; i < 5; i++) ratingRows.push({ playerId: OTHER, orgId: LIVE_ORG, score: 9 });
    attendanceRows = [{ userId: OTHER, orgId: LIVE_ORG }];
  });

  it("a clubmate asking for it gets an error, not a number", async () => {
    await expect(overview({ userId: OTHER, viewerId: ME })).rejects.toThrow(/own overall rating/i);
  });

  it("an admin asking for it gets the same error: there is no admin override", async () => {
    // There is deliberately no `asAdmin` escape hatch to test. If one is
    // ever added this test will still pass, which is why the static half
    // below pins the caller list too.
    await expect(overview({ userId: OTHER, viewerId: "u-club-admin" })).rejects.toThrow();
  });

  it("the player themselves gets it", async () => {
    const r = await overview({ userId: OTHER, viewerId: OTHER });
    expect(r.overallAvg).toBe(9);
  });
});

/**
 * Kemal's open question 3, defaulted to the design's answer: "every
 * rating you have ever had" is read literally, so a club the player has
 * LEFT keeps contributing to their overall. The consequence is
 * deliberate and section 5.2 asks the copy to own it: the per-club
 * breakdown lists only clubs they are currently in, so the overall is
 * not reconstructible from the visible rows.
 */
describe("the overall pools every rating ever received", () => {
  beforeEach(() => {
    membershipRows = [
      { userId: ME, orgId: LIVE_ORG, orgName: "Sutton Football Club", leftAt: null },
      { userId: ME, orgId: LEFT_ORG, orgName: "Sutton Lads", leftAt: new Date("2026-06-18") },
    ];
    attendanceRows = [{ userId: ME, orgId: LIVE_ORG }];
    for (let i = 0; i < 2; i++) ratingRows.push({ playerId: ME, orgId: LIVE_ORG, score: 6 });
    for (let i = 0; i < 2; i++) ratingRows.push({ playerId: ME, orgId: LEFT_ORG, score: 8 });
  });

  it("a left club's ratings still count", async () => {
    const r = await overview({ userId: ME, viewerId: ME });
    expect(r.overallAvg).toBe(7); // (6 + 6 + 8 + 8) / 4
    expect(r.overallCount).toBe(4);
  });

  it("a left club is not listed in the breakdown", async () => {
    const r = await overview({ userId: ME, viewerId: ME });
    expect(r.clubs.map((c) => c.orgName)).toEqual(["Sutton Football Club"]);
  });

  it("a player with no ratings anywhere has no overall, not a zero", async () => {
    ratingRows = [];
    const r = await overview({ userId: ME, viewerId: ME });
    expect(r.overallAvg).toBeNull();
    expect(r.overallCount).toBe(0);
  });

  it("a player with no active membership left keeps their overall", async () => {
    membershipRows = membershipRows.filter((m) => m.leftAt !== null);
    attendanceRows = [];
    const r = await overview({ userId: ME, viewerId: ME });
    expect(r.overallAvg).toBe(7);
    expect(r.clubs).toEqual([]);
  });
});

// ───────────────────────── 2. the static rule ──────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "generated" || entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("only one surface in the whole product loads an overall rating", () => {
  const files = sourceFiles(SRC);

  it("scans a plausible number of source files (guards the walker itself)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("is referenced by exactly one page, plus the module that defines it", () => {
    const callers = files
      .filter((f) => /\bloadAllClubsOverview\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f))
      .sort();
    expect(callers).toEqual(["app/profile/stats/page.tsx", "lib/player-stats.ts"]);
  });

  it("that one caller names the session user for BOTH ids", () => {
    const text = readFileSync(path.join(SRC, "app/profile/stats/page.tsx"), "utf8");
    const call = /loadAllClubsOverview\(([^)]*)\)/.exec(text);
    expect(call, "the call moved or changed shape").not.toBeNull();
    const args = call![1];
    expect(args).toMatch(/userId/);
    expect(args).toMatch(/viewerId/);
    // A `[playerId]` route parameter must never reach it.
    expect(args).not.toMatch(/playerId/);
  });

  it("the surfaces that render SOMEBODY ELSE never reach for it", () => {
    // Each of these takes a player id from the URL or from a DM, so each
    // is one import away from leaking an overall rating.
    const theOthers = [
      "app/profile/[playerId]/page.tsx",
      "app/api/players/[playerId]/route.ts",
      "app/api/wrapped/[playerId]/route.tsx",
      "lib/dm-qa.ts",
      "app/admin/stats/page.tsx",
    ];
    for (const rel of theOthers) {
      const text = readFileSync(path.join(SRC, rel), "utf8");
      expect(text, rel).not.toMatch(/loadAllClubsOverview|overallAvg/);
    }
  });
});

/**
 * The other half of decision 4, stated as its own test so a future
 * reader does not "fix" the leak by hiding clubmates' club ratings too.
 * A club rating is the club's own opinion, formed inside the club, and
 * it is meant to be visible to the club.
 */
describe("a clubmate's CLUB rating stays visible, including to admins", () => {
  it("the squad leaderboard is club-scoped and has no viewer argument", () => {
    const text = readFileSync(path.join(SRC, "lib/player-stats.ts"), "utf8");
    const sig = /export async function loadRatingLeaderboard\(([\s\S]*?)\)/.exec(text);
    expect(sig).not.toBeNull();
    expect(sig![1]).toMatch(/orgId/);
    expect(sig![1]).not.toMatch(/viewerId/);
  });

  it("the admin stats page scopes ratings to the org and shows them", () => {
    const text = readFileSync(path.join(SRC, "app/admin/stats/page.tsx"), "utf8");
    expect(text).toMatch(/ratingsReceived/);
    expect(text).toMatch(/orgId/);
  });
});
