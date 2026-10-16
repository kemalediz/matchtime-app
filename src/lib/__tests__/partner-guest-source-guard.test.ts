/**
 * ONE WRITER ONTO ANOTHER CLUB'S MATCH (cross-club ask, slice S3).
 *
 * A partner club's player is written onto the asking club's match, and
 * given a guest mark there, ONLY by `src/lib/partner-guest.ts`. So the
 * attendance cause "partner-ask" and a write of the guest columns appear
 * nowhere else in `src/` or `scripts/`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(SRC, "..");
const rel = (f: string) => path.relative(REPO, f);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const WRITER = "src/lib/partner-guest.ts";
const files = [...walk(SRC), ...walk(path.join(REPO, "scripts"))];

describe("partner guests: one writer", () => {
  it("the attendance cause partner-ask is written only by partner-guest.ts", () => {
    const CAUSE = /cause:\s*"partner-ask"/;
    expect(files.filter((f) => rel(f) !== WRITER && CAUSE.test(readFileSync(f, "utf8"))).map(rel)).toEqual([]);
    expect(CAUSE.test(readFileSync(path.join(REPO, WRITER), "utf8"))).toBe(true);
  });

  it("the guest columns are set only by partner-guest.ts", () => {
    // A write names the column with a value; reads filter with `{ not: null }`.
    const SET = /guest(FromOrgId|MatchId):\s*(?!\{\s*not:)(?!true\b)(?!string\b)(?!null\b)[^,}\s]/;
    expect(files.filter((f) => rel(f) !== WRITER && SET.test(readFileSync(f, "utf8"))).map(rel)).toEqual([]);
  });
});
