/**
 * The /profile/stats squad leaderboard follows the Team of the Season
 * rule (Kemal, 2026-09-30): at least GROUP_RATINGS_MIN_GAMES rated
 * matches and a match in the last three months. The page must not
 * override the loader's minimum, and the two info buttons must state
 * the rule from ONE string so they cannot contradict each other.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { en } from "@/lib/i18n/strings.en";
import { tr } from "@/lib/i18n/strings.tr";
import { GROUP_RATINGS_MIN_GAMES } from "@/lib/pipeline/stats-answer";

const page = readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");

describe("the stats page squad leaderboard", () => {
  it("does not lower the loader's minimum of rated matches", () => {
    const call = page.match(/loadRatingLeaderboard\(([^)]*)\)/)![1]!;
    expect(call).not.toMatch(/minGames/);
  });

  it("no longer renders the '1 game' provisional tag", () => {
    expect(page).not.toMatch(/1 game/);
    expect(page).not.toMatch(/\.provisional && !r\.inactive/);
  });

  it("states the rule in both info buttons from the one shared string", () => {
    const uses = page.match(/s\.stats_table_rule\(/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it("tells a viewer below the minimum how to join the table", () => {
    expect(page).toMatch(/s\.stats_leaderboard_join\(/);
  });
});

describe("the shared rule text", () => {
  for (const [lang, table] of [["en", en], ["tr", tr]] as const) {
    it(`${lang}: names the minimum, the three months and the way back, with no em or en dash`, () => {
      const text = table.stats_table_rule({ minGames: GROUP_RATINGS_MIN_GAMES });
      expect(text).toContain(String(GROUP_RATINGS_MIN_GAMES));
      expect(text).toMatch(lang === "en" ? /three months/ : /üç ay/);
      expect(text).not.toMatch(/[—–]/);
    });

    it(`${lang}: the join note counts the games still needed`, () => {
      const text = table.stats_leaderboard_join({ minGames: 3, games: 1 });
      expect(text).toContain("3");
      expect(text).toContain("2");
      expect(text).not.toMatch(/[—–]/);
    });

    it(`${lang}: the away note has no em or en dash`, () => {
      const text = table.stats_leaderboard_away({ avg: "7.4", lastPlayed: "7 Jul 2026" });
      expect(text).toContain("7.4");
      expect(text).toContain("7 Jul 2026");
      expect(text).not.toMatch(/[—–]/);
    });
  }
});
