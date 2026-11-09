/**
 * THE DEFAULT SEED IS 6 (Kemal, 2026-11-02): "so it gives the admins a
 * measurement for medium kind of players".
 *
 * `Membership.seedRating` stays nullable. Null means "no admin has set
 * this", and everywhere a number is needed it is read as
 * `DEFAULT_SEED_RATING`: the balancer's prior, the admin seed boxes, the
 * "Starting ratings" page. These tests pin the number, the one module it
 * lives in, and that nothing else in `src/` quietly assumes 5 again.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SEED_RATING, effectiveSeed, isUnchangedSeed, parseSeedBox, seedBoxValue, seedFromBoxEdit } from "@/lib/default-seed";
import { computeClubRating } from "@/lib/player-rating";

describe("DEFAULT_SEED_RATING", () => {
  it("is 6 out of 10", () => {
    expect(DEFAULT_SEED_RATING).toBe(6);
  });

  it("an unset seed is read as 6, a set one as itself", () => {
    expect(effectiveSeed(null)).toBe(6);
    expect(effectiveSeed(undefined)).toBe(6);
    expect(effectiveSeed(3)).toBe(3);
    expect(effectiveSeed(9)).toBe(9);
  });

  it("the admin seed box shows 6 for an unset seed, and a set one as it is, never rounded to a whole number", () => {
    expect(seedBoxValue(null)).toBe("6");
    expect(seedBoxValue(undefined)).toBe("6");
    expect(seedBoxValue(8)).toBe("8");
    expect(seedBoxValue(6.6)).toBe("6.6");
    expect(seedBoxValue(6.5)).toBe("6.5");
    // A carried seed at full precision (Mustafa at the Vets, 2026-11-09):
    // shown to two places, the stored value itself is never touched.
    expect(seedBoxValue(6.41666666666667)).toBe("6.42");
    expect(seedBoxValue(8.333333333333334)).toBe("8.33");
    expect(seedBoxValue(7.0952380952380949)).toBe("7.1");
  });

  it("leaving the prefilled 6 on an unset player is not a change, so nothing is written", () => {
    expect(isUnchangedSeed(6, null)).toBe(true);
    expect(isUnchangedSeed(7, null)).toBe(false);
    expect(isUnchangedSeed(5, null)).toBe(false);
    expect(isUnchangedSeed(8, 8)).toBe(true);
    expect(isUnchangedSeed(6, 8)).toBe(false);
  });

  it("leaving a decimal seed as the box shows it is not a change, so it is never written back rounded", () => {
    expect(isUnchangedSeed(Number(seedBoxValue(6.41666666666667)), 6.41666666666667)).toBe(true);
    expect(isUnchangedSeed(6.42, 6.41666666666667)).toBe(true);
    expect(isUnchangedSeed(6, 6.41666666666667)).toBe(false);
    expect(isUnchangedSeed(6.4, 6.41666666666667)).toBe(false);
    expect(isUnchangedSeed(6.6, 6.6)).toBe(true);
    expect(isUnchangedSeed(7, 6.6)).toBe(false);
  });
});

describe("parseSeedBox: what an admin typed, exactly as typed", () => {
  it("whole numbers and decimals both work, nothing is rounded", () => {
    expect(parseSeedBox("7")).toBe(7);
    expect(parseSeedBox(" 6.5 ")).toBe(6.5);
    expect(parseSeedBox("6.25")).toBe(6.25);
    expect(parseSeedBox("6,5")).toBe(6.5);
    expect(parseSeedBox("10")).toBe(10);
    expect(parseSeedBox("1")).toBe(1);
  });

  it("empty, not a number, or outside 1 to 10: null, so nothing is saved", () => {
    for (const raw of ["", "  ", "abc", "0", "0.5", "10.1", "11", "-3", "NaN", "Infinity"]) {
      expect(parseSeedBox(raw), raw).toBeNull();
    }
  });
});

describe("seedFromBoxEdit: the seed a form holds after the box is edited (onboarding, finish setup)", () => {
  it("a typed value is kept as typed, whole or decimal", () => {
    expect(seedFromBoxEdit("7", null)).toBe(7);
    expect(seedFromBoxEdit("6.5", 8)).toBe(6.5);
  });

  it("an emptied box is unset", () => {
    expect(seedFromBoxEdit("", 7)).toBeNull();
  });

  it("outside 1 to 10 is held at the nearest end, as before", () => {
    expect(seedFromBoxEdit("12", null)).toBe(10);
    expect(seedFromBoxEdit("0", null)).toBe(1);
  });

  it("typing back what the box showed keeps the seed it showed: an unset 6 stays unset, a 6.4166 is not cut to 6.42", () => {
    expect(seedFromBoxEdit("6", null)).toBeNull();
    expect(seedFromBoxEdit("6.42", 6.41666666666667)).toBe(6.41666666666667);
    expect(seedFromBoxEdit("6.4", 6.41666666666667)).toBe(6.4);
  });
});

describe("the balancer treats an unseeded player as 6", () => {
  it("with no peer ratings, an unseeded player is exactly 6", () => {
    const r = computeClubRating({ clubSeedRating: null, clubPeerRatings: [] });
    expect(r.rating).toBe(6);
    expect(r.source).toBe("default-seed");
  });

  it("the 6 is a prior like any seed: one peer 9 moves him to (9 + 6x3) / 4", () => {
    const r = computeClubRating({ clubSeedRating: null, clubPeerRatings: [9] });
    expect(r.rating).toBeCloseTo(6.75, 10);
    expect(r.source).toBe("blended");
  });

  it("an admin's seed still wins over the default", () => {
    expect(computeClubRating({ clubSeedRating: 4, clubPeerRatings: [] }).rating).toBe(4);
    expect(computeClubRating({ clubSeedRating: 4, clubPeerRatings: [] }).source).toBe("seed");
  });

  it("an unseeded player and a player seeded 6 are balanced identically", () => {
    for (const peers of [[], [9], [3, 4], [7, 7, 7, 7, 7, 7, 7, 7, 7, 7]]) {
      expect(computeClubRating({ clubSeedRating: null, clubPeerRatings: peers }).rating).toBe(
        computeClubRating({ clubSeedRating: 6, clubPeerRatings: peers }).rating,
      );
    }
  });
});

/**
 * THE GUARD. Every "assumed rating for a player nobody rated" goes
 * through `DEFAULT_SEED_RATING`. A bare `?? 5` (or `?? 6`) on a rating
 * is how the old midpoint survived in three places after the club mean
 * replaced it, so the sweep refuses one anywhere in `src/` outside the
 * allowlisted non-rating fallbacks.
 */
describe("no other module assumes a default seed", () => {
  const SRC = path.resolve(__dirname, "../..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (name === "generated" || name === "__tests__" || name === "node_modules") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(SRC);

  // `?? 5` / `?? 6` / `?? 5.0` that are not about a player's rating.
  const ALLOWED = new Set([
    "lib/club-billing-rules.ts", // playersPerTeam fallback, a squad size
    // The slider a player starts at when HE rates a team-mate after a
    // game: a peer score, not an assumed seed.
    "app/matches/[matchId]/rate/page.tsx",
  ]);

  it("finds no bare `?? 5` or `?? 6` fallback on a rating", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(SRC, f).split(path.sep).join("/");
      if (ALLOWED.has(rel) || rel === "lib/default-seed.ts") continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, "");
          if (/^\s*\*/.test(code)) return;
          if (/\?\?\s*[56](\.0+)?\b(?!\s*\*)/.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("player-rating.ts takes its prior from the default-seed module", () => {
    const src = readFileSync(path.join(SRC, "lib/player-rating.ts"), "utf8");
    expect(src).toMatch(/from "\.\/default-seed"/);
    expect(src).not.toMatch(/NO_INFORMATION_PRIOR/);
  });

  // Kemal, 2026-11-09: "keep the ratings as they are, never round them".
  // A seed box that parses with parseInt, or steps in whole numbers,
  // would cut a 6.4166 to 6 on save (or flag it as invalid).
  it("no seed box parses a whole number only or steps in whole numbers", () => {
    for (const rel of [
      "app/admin/players/page.tsx",
      "app/admin/players/ratings/page.tsx",
      "components/seed-input.tsx",
    ]) {
      const src = readFileSync(path.join(SRC, rel), "utf8");
      const seedCode = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
      expect(seedCode, rel).not.toMatch(/step=\{1\}|step="1"/);
      expect(seedCode, rel).toMatch(/step="any"/);
      expect(seedCode, rel).toMatch(/parseSeedBox|seedFromBoxEdit/);
    }
  });

  it("a carried seed is never rounded", () => {
    const src = readFileSync(path.join(SRC, "lib/carried-seed.ts"), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/Math\.(round|floor|ceil|trunc)|toFixed/);
  });

  it("every admin seed box reads the default from the default-seed module", () => {
    for (const rel of [
      "app/admin/players/page.tsx",
      "app/admin/players/ratings/page.tsx",
      "app/finish-setup/[sessionId]/FinishSetupForm.tsx",
      "app/onboarding/page.tsx",
    ]) {
      const src = readFileSync(path.join(SRC, rel), "utf8");
      expect(src, rel).toMatch(/@\/lib\/default-seed|@\/components\/seed-input/);
    }
  });
});
