/**
 * MR RELIABLE IS THE STATS PAGE'S BADGE (Kemal, 2026-09-23).
 *
 * "who is the most Mr. Reliable?" asked in the group must name the
 * players the stats page gives the badge to, and nobody else: the group
 * must never contradict the page. So the rule lives in ONE pure
 * function, `earnsMrReliable`, and both the page's badge
 * (`loadPlayerSeasonStats`) and the group's list (`loadMrReliableHolders`)
 * call it.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const matchFindMany = vi.fn();
const attendanceFindMany = vi.fn();
const userFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    match: { findMany: (...a: unknown[]) => matchFindMany(...a) },
    attendance: { findMany: (...a: unknown[]) => attendanceFindMany(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
  },
}));

import {
  MR_RELIABLE_MIN_AVG,
  MR_RELIABLE_MIN_GAMES,
  MR_RELIABLE_MAX_SPREAD,
  earnsMrReliable,
  loadMrReliableHolders,
} from "@/lib/player-stats";

describe("the badge rule, once", () => {
  it("is the rule the page has always shown", () => {
    expect(MR_RELIABLE_MIN_AVG).toBe(6.5);
    expect(MR_RELIABLE_MIN_GAMES).toBe(4);
    expect(MR_RELIABLE_MAX_SPREAD).toBe(1);
  });
  it("four steady strong games earn it", () => {
    expect(earnsMrReliable({ perGameAverages: [7, 7.2, 6.9, 7.1], avgRating: 7.05 })).toBe(true);
  });
  it("three games do not", () => {
    expect(earnsMrReliable({ perGameAverages: [7, 7.2, 6.9], avgRating: 7.03 })).toBe(false);
  });
  it("steady but below 6.5 does not", () => {
    expect(earnsMrReliable({ perGameAverages: [6, 6.1, 6.2, 6], avgRating: 6.07 })).toBe(false);
  });
  it("strong but swinging does not", () => {
    expect(earnsMrReliable({ perGameAverages: [9, 5, 9, 5], avgRating: 7 })).toBe(false);
  });
  it("the page's badge is computed by this function, not a copy of it", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../player-stats.ts"), "utf8");
    const badge = src.slice(src.indexOf('key: "reliable"'), src.indexOf('key: "above-field"'));
    expect(badge).toContain("earnsMrReliable(");
  });
});

describe("the holders the group is told about", () => {
  const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
  beforeEach(() => vi.clearAllMocks());

  it("are exactly the badge holders, most consistent first, inactive players out", async () => {
    const scores = (pid: string, s: number[]) => s.map((score) => ({ playerId: pid, score }));
    matchFindMany.mockResolvedValue([
      { id: "m1", date: recent(30), ratings: [...scores("u-sait", [7, 7]), ...scores("u-idris", [8]), ...scores("u-swing", [9]), ...scores("u-gone", [8])] },
      { id: "m2", date: recent(23), ratings: [...scores("u-sait", [7.2]), ...scores("u-idris", [7.5]), ...scores("u-swing", [5]), ...scores("u-gone", [8])] },
      { id: "m3", date: recent(16), ratings: [...scores("u-sait", [6.9]), ...scores("u-idris", [8.2]), ...scores("u-swing", [9]), ...scores("u-gone", [8])] },
      { id: "m4", date: recent(9), ratings: [...scores("u-sait", [7.1]), ...scores("u-idris", [7.9]), ...scores("u-swing", [5]), ...scores("u-gone", [8])] },
    ]);
    attendanceFindMany.mockResolvedValue([
      { userId: "u-sait", match: { date: recent(9) } },
      { userId: "u-idris", match: { date: recent(9) } },
      { userId: "u-swing", match: { date: recent(9) } },
      // Last played five months ago: out of the ranked tables.
      { userId: "u-gone", match: { date: recent(150) } },
    ]);
    userFindMany.mockResolvedValue([
      { id: "u-sait", name: "Sait Demir" },
      { id: "u-idris", name: "Idris Bello" },
    ]);

    const holders = await loadMrReliableHolders("org-1");

    expect(holders.map((h) => h.name)).toEqual(["Sait Demir", "Idris Bello"]);
    expect(holders[0]).toMatchObject({ games: 4 });
    expect(holders[0].spread).toBeLessThan(holders[1].spread);
  });
});
