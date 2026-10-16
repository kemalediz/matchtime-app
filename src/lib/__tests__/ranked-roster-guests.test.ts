/**
 * L3 (review, decided by Kemal): a partner club's guest, current or past,
 * is in NONE of the asking club's season tables (the rating leaderboard,
 * Team of the Season, Man of the Match, Mr Reliable, appearances, Elo).
 * One rule for all of them: the ranked roster every table filters by
 * (`buildRankedRoster`) never ranks a guest, and every table reads it with
 * the club's guests. His own profile still shows his rating there.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRankedRoster } from "../ranked-table-activity";

const NOW = new Date("2026-10-30T12:00:00Z");

describe("the ranked roster never ranks a guest", () => {
  it("a recent player is ranked; the same player as a guest is not", () => {
    const last = new Map([["ali", new Date("2026-10-20T20:00:00Z")], ["bob", new Date("2026-10-20T20:00:00Z")]]);
    const roster = buildRankedRoster(last, NOW, new Set(["ali"]));
    expect(roster.isRanked("bob")).toBe(true);
    expect(roster.isRanked("ali")).toBe(false);
  });
  it("no guests: exactly as before", () => {
    const last = new Map([["bob", new Date("2026-10-20T20:00:00Z")]]);
    expect(buildRankedRoster(last, NOW).isRanked("bob")).toBe(true);
  });
});

describe("every season table reads the roster with the club's guests", () => {
  const read = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");
  it("player-stats.ts: leaderboard, Mr Reliable, Team of the Season", () => {
    const src = read("player-stats.ts");
    const calls = src.match(/buildRankedRoster\([^;]*\)/g) ?? [];
    expect(calls.length).toBe(3);
    for (const c of calls) expect(c).toMatch(/loadGuestUserIds\(db, orgId\)/);
  });
  it("match-history.ts: MoM, Elo, attendance and the record tables", () => {
    const src = read("match-history.ts");
    const calls = src.match(/buildRankedRoster\([\s\S]*?\);/g) ?? [];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toMatch(/loadGuestUserIds\(db, orgId\)/);
  });
});
