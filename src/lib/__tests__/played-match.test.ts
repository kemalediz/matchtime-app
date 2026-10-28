/**
 * A CANCELLED MATCH IS NEVER PLAYED (2026-10-28): every club-wide read of
 * ratings and Man of the Match votes excludes a cancelled match, so a game
 * marked as not played (`match-cancel.ts`) leaves no rating, vote, MoM win
 * or club rating behind, and putting it back brings them all back (the
 * rows are kept).
 *
 * A scan of the source, so a NEW reader that forgets the filter fails here
 * rather than in a club's numbers. A read passes when its call carries
 * `NOT_CANCELLED` (`played-match.ts`) or `COMPLETED`, or is about one match
 * or a known list of matches (`matchId`), or is listed below with why.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NOT_CANCELLED } from "../played-match";

const SRC = path.resolve(__dirname, "../..");

/** Reads that are about a person's rows, not about play: merges, the wipe. */
const NOT_ABOUT_PLAY = new Set([
  "app/actions/players.ts", // counts before deleting a placeholder player
  "lib/merge-players-core.ts", // moves every row of a merged player
  "lib/cross-club-link.ts", // counts rows in other clubs before linking
  "lib/wipe-org.ts", // counts before wiping a club
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" || f === "generated" ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

/** The text of the call starting at `start`, to its closing parenthesis. */
function callText(src: string, start: number): string {
  let depth = 0;
  for (let i = src.indexOf("(", start); i < src.length; i++) {
    if (src[i] === "(") depth++;
    if (src[i] === ")" && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

describe("played-match: a cancelled match is never counted", () => {
  it("the filter excludes CANCELLED and nothing else", () => {
    expect(NOT_CANCELLED).toEqual({ status: { not: "CANCELLED" } });
  });

  it("every club-wide Rating and MoMVote read excludes a cancelled match", () => {
    const leaks: string[] = [];
    let seen = 0;
    for (const file of files(SRC)) {
      const rel = path.relative(SRC, file);
      if (NOT_ABOUT_PLAY.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      const re = /\b(?:db|tx)\.(?:rating|moMVote)\.(?:findMany|findFirst|aggregate|count|groupBy)\(/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        seen++;
        const call = callText(src, m.index);
        if (/NOT_CANCELLED|COMPLETED|\bmatchId\b/.test(call)) continue;
        leaks.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(leaks).toEqual([]);
  });

  it("the readers that list a club's matches for Man of the Match wins exclude a cancelled one", () => {
    const src = readFileSync(path.join(SRC, "lib/match-history.ts"), "utf8");
    const lists = src.match(/db\.match\.findMany\(\{\s*where: \{ activity: \{ orgId \}[^}]*\}/g) ?? [];
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const l of lists) expect(l).toMatch(/NOT_CANCELLED|COMPLETED/);
  });
});
