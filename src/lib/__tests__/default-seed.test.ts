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
import { DEFAULT_SEED_RATING, effectiveSeed, isUnchangedSeed, seedBoxValue } from "@/lib/default-seed";
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

  it("the admin seed box shows 6 for an unset seed, and the whole number of a set one", () => {
    expect(seedBoxValue(null)).toBe("6");
    expect(seedBoxValue(undefined)).toBe("6");
    expect(seedBoxValue(8)).toBe("8");
    expect(seedBoxValue(6.6)).toBe("7");
  });

  it("leaving the prefilled 6 on an unset player is not a change, so nothing is written", () => {
    expect(isUnchangedSeed(6, null)).toBe(true);
    expect(isUnchangedSeed(7, null)).toBe(false);
    expect(isUnchangedSeed(5, null)).toBe(false);
    expect(isUnchangedSeed(8, 8)).toBe(true);
    expect(isUnchangedSeed(6, 8)).toBe(false);
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
