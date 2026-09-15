/**
 * The Recent History block must be BOUNDED — and the aggregates must not be.
 *
 * `loadRecentHistory` had no `take:` (analyzer-redesign-2026-08-31.md §8.1).
 * The per-match detail rows it produces sit inside the user message's first
 * content block, which carries `cache_control: {ttl: "1h"}`, so the club's
 * ENTIRE match list was re-sent on every batch and grew monotonically for
 * the life of the club. At Sutton's weekly cadence that is ~52 rows a year,
 * forever, in a segment that is also re-WRITTEN (2×) every time a match
 * completes.
 *
 * The naive fix — `take:` on the one query — is wrong, and these tests exist
 * to stop it coming back. Three things are computed from that same result set:
 *
 *   1. the per-match detail rows (the thing that should be bounded),
 *   2. `totalCompletedMatches`,
 *   3. the attendance leaderboard's DENOMINATOR, which the module comment
 *      records Kemal asking for on 2026-05-15: it is the org's TOTAL completed
 *      matches, so a late joiner who has played every match since shows 3/4
 *      (75%) rather than a flattering 3/3 (100%).
 *
 * Bounding (2) or (3) would silently start reporting different percentages.
 * So: the DETAIL query is bounded, the aggregates are not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const matchFindMany = vi.fn();
const orgFindUnique = vi.fn();
const attendanceFindMany = vi.fn();
const userFindMany = vi.fn();
const teamAssignmentFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: { findMany: (...a: unknown[]) => matchFindMany(...a) },
    organisation: { findUnique: (...a: unknown[]) => orgFindUnique(...a) },
    attendance: { findMany: (...a: unknown[]) => attendanceFindMany(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    teamAssignment: { findMany: (...a: unknown[]) => teamAssignmentFindMany(...a) },
  },
}));
vi.mock("@/lib/mom", () => ({ getMomSummaries: async () => new Map() }));
vi.mock("@/lib/team-labels", () => ({ resolveTeamLabels: () => ["Reds", "Yellows"] }));

import {
  loadRecentHistory,
  formatRecentHistoryBlock,
  RECENT_MATCH_DETAIL_LIMIT,
} from "@/lib/match-history";

const ORG = "org-1";

/** `n` completed matches, one a week, oldest first — the real cadence.
 *
 *  The series ENDS at "now" rather than starting at a fixed date in the
 *  past, because the leaderboards now drop players with no match in the
 *  last three months (`ranked-table-activity.ts`). A fixture list that
 *  finished two years ago would put every seeded player outside that
 *  window, and these tests would pass over four empty tables while
 *  appearing to assert something about their contents. */
const WEEK = 7 * 86_400_000;
function completedMatches(n: number) {
  const mostRecent = Date.now() - 2 * 86_400_000;
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    date: new Date(mostRecent - (n - 1 - i) * WEEK),
    redScore: 5,
    yellowScore: 4,
    activity: { sport: { teamLabels: null } },
  }));
}

/** Every call to `db.match.findMany`, in order. */
function calls(): Array<Record<string, unknown>> {
  return matchFindMany.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

/** The call that pulls the per-match DETAIL rows: the one with an `include`
 *  (it needs the sport's team labels to render a score line). */
function detailCall(): Record<string, unknown> {
  const c = calls().find((x) => x.include !== undefined);
  if (!c) throw new Error("no detail query issued");
  return c;
}

/** The call that enumerates every completed match for the aggregates: the
 *  one filtered to COMPLETED + non-historical that is NOT the detail call. */
function aggregateCall(): Record<string, unknown> {
  const c = calls().find(
    (x) =>
      x.include === undefined &&
      (x.where as Record<string, unknown> | undefined)?.status === "COMPLETED",
  );
  if (!c) throw new Error("no aggregate query issued");
  return c;
}

function seed(matchCount: number, opts: { attendanceRows?: number } = {}) {
  const all = completedMatches(matchCount);
  matchFindMany.mockImplementation(async (args: Record<string, unknown>) => {
    // Elo path: distinct team assignments — a different model, handled below.
    const where = (args.where ?? {}) as Record<string, unknown>;
    if (where.status !== "COMPLETED") {
      // "every match for the org" (MoM leaderboard) — ids only.
      return all.map((m) => ({ id: m.id }));
    }
    if (args.include) {
      const take = args.take as number | undefined;
      const desc =
        (args.orderBy as { date?: string } | undefined)?.date === "desc";
      const ordered = desc ? [...all].reverse() : all;
      return typeof take === "number" ? ordered.slice(0, take) : ordered;
    }
    // `date` as well as `id`: the aggregate query really does select
    // both, because the inactivity filter needs to know when each
    // appearance happened. A mock that returns bare ids makes the
    // filter compare against `undefined` and silently pass everyone.
    return all.map((m) => ({ id: m.id, date: m.date }));
  });
  orgFindUnique.mockResolvedValue({ teamLabels: null });
  // One player, present for `attendanceRows` matches taken from the
  // RECENT end of the fixture list. Recent because the four
  // leaderboards drop anyone with no match in the last three months, so
  // a player seeded onto the oldest matches would vanish from the very
  // tables these tests assert on.
  attendanceFindMany.mockResolvedValue(
    all
      .slice(-(opts.attendanceRows ?? matchCount))
      .map((m) => ({ userId: "u1", matchId: m.id })),
  );
  userFindMany.mockResolvedValue([{ id: "u1", name: "Kemal", matchRating: 1000 }]);
  teamAssignmentFindMany.mockResolvedValue([{ userId: "u1" }]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RECENT_MATCH_DETAIL_LIMIT", () => {
  it("is a real bound, not a placeholder", () => {
    expect(RECENT_MATCH_DETAIL_LIMIT).toBeGreaterThan(0);
    expect(Number.isFinite(RECENT_MATCH_DETAIL_LIMIT)).toBe(true);
  });

  it("covers at least a season half of weekly matches, so 'the last few games' always resolves", () => {
    expect(RECENT_MATCH_DETAIL_LIMIT).toBeGreaterThanOrEqual(20);
  });
});

describe("loadRecentHistory — the per-match detail rows are bounded", () => {
  it("asks the database for at most RECENT_MATCH_DETAIL_LIMIT detail rows", async () => {
    seed(120);
    await loadRecentHistory(ORG);
    expect(detailCall().take).toBe(RECENT_MATCH_DETAIL_LIMIT);
  });

  it("returns at most RECENT_MATCH_DETAIL_LIMIT rows however long the club has run", async () => {
    seed(120);
    const h = await loadRecentHistory(ORG);
    expect(h!.recentMatches.length).toBe(RECENT_MATCH_DETAIL_LIMIT);
  });

  it("keeps the NEWEST matches, still rendered oldest-first", async () => {
    seed(120);
    const h = await loadRecentHistory(ORG);
    const dates = h!.recentMatches.map((m) => m.date.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    // m120 is the most recent; it must be the last row.
    expect(h!.recentMatches.at(-1)!.id).toBe("m120");
    expect(h!.recentMatches[0]!.id).toBe(`m${120 - RECENT_MATCH_DETAIL_LIMIT + 1}`);
  });

  it("does not truncate a young club", async () => {
    seed(4);
    const h = await loadRecentHistory(ORG);
    expect(h!.recentMatches.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });
});

describe("loadRecentHistory — the aggregates stay over the WHOLE history", () => {
  it("counts every completed match, not just the ones it shows", async () => {
    seed(120);
    const h = await loadRecentHistory(ORG);
    expect(h!.totalCompletedMatches).toBe(120);
  });

  it("never puts a take: on the query the aggregates are computed from", async () => {
    seed(120);
    await loadRecentHistory(ORG);
    expect(aggregateCall().take).toBeUndefined();
  });

  it("keeps the attendance denominator at the org's TOTAL completed matches (Kemal, 2026-05-15)", async () => {
    // 120 matches, the player attended 40 of them. If the denominator ever
    // silently became the bounded window this reads 40/20 (200%).
    seed(120, { attendanceRows: 40 });
    const h = await loadRecentHistory(ORG);
    expect(h!.attendanceLeaderboard[0]!.detail).toBe("40/120 (33%)");
  });
});

describe("formatRecentHistoryBlock — the model is told the list is a window", () => {
  it("says how many of the total are shown when the list is truncated", async () => {
    seed(120);
    const h = await loadRecentHistory(ORG);
    const block = formatRecentHistoryBlock(h!);
    expect(block).toContain(`most recent ${RECENT_MATCH_DETAIL_LIMIT} of 120`);
  });

  it("does not claim a window when the whole history fits", async () => {
    seed(4);
    const h = await loadRecentHistory(ORG);
    expect(formatRecentHistoryBlock(h!)).not.toContain("most recent");
  });
});
