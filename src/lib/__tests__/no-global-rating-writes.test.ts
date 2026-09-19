/**
 * NOTHING WRITES THE GLOBAL RATING COLUMNS ANY MORE.
 *
 * Slice 4 and slice 5 of MDs/club-scoped-ratings-design-2026-09-18.md
 * move every seed and Elo write onto `Membership`. `User.seedRating` and
 * `User.matchRating` deliberately STAY in the schema until slice 7, and
 * that is what makes this test worth having: a column that still exists
 * and still type-checks is a column a future edit can quietly start
 * writing again, and the symptom would not be an error. It would be one
 * club's balancer silently reading a number another club typed.
 *
 * So this is a source scan, not a behaviour test. It finds every write
 * call on the `user` model and reads the payload that follows it. A unit
 * test covering the call sites we know about today cannot catch the one
 * somebody adds next month; this can.
 *
 * Reads are untouched and must stay legal: `page.tsx` still shows the
 * global number until slice 6, the backfill in
 * `membership-rating-backfill.ts` reads the column it is copying FROM,
 * and slice 7 is the PR that deletes both.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");

/** Every `.ts`/`.tsx` under src, minus the generated Prisma client and
 *  the tests themselves (a test may legitimately name the old column in
 *  a fixture proving it is NOT written). */
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

/**
 * Prisma write calls on the `user` model, whichever client they are on
 * (`db.`, `tx.`, or a destructured one). The payload that matters starts
 * at the call and runs a few lines; 400 characters comfortably covers
 * the longest of the call sites this slice removed, which was a single
 * long `data: { ... }` line in `players.ts`.
 */
const USER_WRITE = /\b(?:db|tx|client|prisma)\.user\.(?:create|createMany|update|updateMany|upsert)\b/g;
const WINDOW = 400;

describe("the global rating columns have no writers left", () => {
  const files = sourceFiles(SRC);

  it("scans a plausible number of source files (guards the walker itself)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds no user write whose payload sets seedRating or matchRating", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(USER_WRITE)) {
        const window = text.slice(m.index, m.index + WINDOW);
        if (/\b(seedRating|matchRating)\s*:/.test(window)) {
          const line = text.slice(0, m.index).split("\n").length;
          offenders.push(`${path.relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no DEFAULT_SEED_RATING constant left to hand a new member somebody else's opinion", () => {
    const offenders = files.filter((f) => /DEFAULT_SEED_RATING/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
