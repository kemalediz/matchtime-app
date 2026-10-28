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

/** The text from the "(" or "{" at or after `start` to its match. */
function balanced(src: string, start: number, open = "(", close = ")"): string {
  let depth = 0;
  for (let i = src.indexOf(open, start); i >= 0 && i < src.length; i++) {
    if (src[i] === open) depth++;
    if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}
const callText = (src: string, start: number) => balanced(src, start);

/** The call's `where` clause(s), so a `select: { matchId: true }` is not
 *  mistaken for a filter (review of #437, 9). */
function wheres(call: string): string {
  const out: string[] = [];
  for (let i = call.indexOf("where:"); i >= 0; i = call.indexOf("where:", i + 6)) {
    const brace = call.indexOf("{", i);
    const ident = call.slice(i + 6).match(/^\s*([A-Za-z_][\w.]*)/);
    if (ident && (brace < 0 || brace > i + 6 + ident[0].length)) out.push(ident[1]);
    else out.push(balanced(call, brace, "{", "}"));
  }
  return out.join(" ");
}
/** A filter that keeps a cancelled match out, or names the match(es). */
const SCOPED = /NOT_CANCELLED|COMPLETED|matchScope|\bmatchId\b|\bid\b/;

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
        if (/NOT_CANCELLED|COMPLETED|\bmatchId\b/.test(wheres(call))) continue;
        leaks.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(leaks).toEqual([]);
  });

  it("review of #437, 9: a select of matchId is no filter", () => {
    const call = "db.rating.findMany({ where: { playerId }, select: { matchId: true, score: true } })";
    expect(/NOT_CANCELLED|COMPLETED|\bmatchId\b/.test(wheres(call))).toBe(false);
    expect(/NOT_CANCELLED|COMPLETED|\bmatchId\b/.test(wheres("db.rating.findMany({ where: { matchId }, select: { score: true } })"))).toBe(true);
  });

  it("review of #437, 9: ratings and votes read through a relation are scoped too", () => {
    const leaks: string[] = [];
    let seen = 0;
    for (const file of files(SRC)) {
      const rel = path.relative(SRC, file);
      if (NOT_ABOUT_PLAY.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      // A person's own relations: each needs its own where.
      const own = /\b(ratingsReceived|ratingsGiven|momVotesReceived|momVotesGiven)\s*:\s*(true|\{)/g;
      for (let m = own.exec(src); m; m = own.exec(src)) {
        seen++;
        const ok = m[2] === "{" && /NOT_CANCELLED|COMPLETED/.test(wheres(balanced(src, m.index + m[0].length - 1, "{", "}")));
        if (!ok) leaks.push(`${rel}:${src.slice(0, m.index).split("\n").length} ${m[1]}`);
      }
      // A match's ratings or votes: the query that reads them names its
      // matches, or keeps a cancelled one out.
      const read = /\b(?:db|tx)\.\w+\.(?:findMany|findFirst|findUnique)\(/g;
      for (let m = read.exec(src); m; m = read.exec(src)) {
        const call = callText(src, m.index);
        if (!/\b(ratings|momVotes)\s*:\s*(true|\{)/.test(call)) continue;
        seen++;
        if (!SCOPED.test(wheres(call))) leaks.push(`${rel}:${src.slice(0, m.index).split("\n").length} relation`);
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(leaks).toEqual([]);
  });

  it("the readers that list a club's matches for Man of the Match wins exclude a cancelled one", () => {
    const src = readFileSync(path.join(SRC, "lib/match-history.ts"), "utf8");
    const lists = src.match(/db\.match\.findMany\(\{\s*where: \{ activity: \{ orgId \}[^}]*\}/g) ?? [];
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const l of lists) expect(l).toMatch(/NOT_CANCELLED|COMPLETED/);
  });
});
