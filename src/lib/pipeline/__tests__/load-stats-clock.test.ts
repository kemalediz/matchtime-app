/**
 * THE BATCH'S CLOCK REACHES EVERY MAN OF THE MATCH READ (review of #608,
 * round 4). Which matches are decided depends on `now`, so the period tables
 * and a player's chemistry block must be read at the batch's clock, the same
 * one the whole-record tables and the last Man of the Match are read at.
 * A pinned test clock and the answer then agree.
 */
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ records: [] as unknown[][], season: [] as unknown[][] }));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("../../match-history", () => ({
  loadRecentHistory: vi.fn(),
  loadClubRecordTables: vi.fn(async (...a: unknown[]) => {
    calls.records.push(a);
    return { appearances: [], mom: [], recordsStart: { matches: null, mom: null }, completedMatches: 0 };
  }),
}));
vi.mock("../../player-stats", () => ({
  loadMrReliableHolders: vi.fn(),
  loadRatingLeaderboard: vi.fn(async () => []),
  loadTeamOfSeason: vi.fn(),
  loadPlayerSeasonStats: vi.fn(async (...a: unknown[]) => {
    calls.season.push(a);
    return null;
  }),
}));

import { loadStatsChemistry, loadStatsPeriod } from "../load-stats";

const NOW = new Date("2026-11-10T19:25:00Z");

describe("the loaders pass the batch's clock on", () => {
  it("the period tables", async () => {
    await loadStatsPeriod("org-1", new Date("2026-11-01T00:00:00Z"), NOW);
    expect(calls.records.at(-1)).toEqual(["org-1", { since: new Date("2026-11-01T00:00:00Z"), now: NOW }]);
  });

  it("a player's chemistry (his season stats, MoM count included)", async () => {
    await loadStatsChemistry("org-1", "u-1", NOW);
    expect(calls.season.at(-1)).toEqual(["org-1", "u-1", NOW]);
  });
});
