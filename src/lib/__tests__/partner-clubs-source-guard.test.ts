/**
 * ONE WRITER FOR PARTNER CLUBS (cross-club ask, slice S1).
 *
 * Every write to `ClubPartnership` and to the asking club's partner
 * settings happens in `src/lib/club-partnership.ts`, so the pure rules
 * (who may accept, pause, resume, remove; the values a setting may hold)
 * cannot be skipped by a second writer. This scans `src/` and `scripts/`
 * for a write call on the model, or a write of one of the three columns,
 * anywhere else.
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

const WRITER = "src/lib/club-partnership.ts";
const MODEL_WRITE = /clubPartnership\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
const SETTING_WRITE = /\b(partnerAskWhen|partnerAskTime|partnerAskCutoffHours)\s*:/;

describe("partner clubs: one writer", () => {
  const files = [...walk(SRC), ...walk(path.join(REPO, "scripts"))];

  it("nothing but club-partnership.ts writes a ClubPartnership row", () => {
    const offenders = files.filter((f) => rel(f) !== WRITER && MODEL_WRITE.test(readFileSync(f, "utf8")));
    expect(offenders.map(rel)).toEqual([]);
    expect(MODEL_WRITE.test(readFileSync(path.join(REPO, WRITER), "utf8"))).toBe(true);
  });

  it("nothing but club-partnership.ts names an asking-club setting as an object key", () => {
    // Reads go through `loadPartnerAskSettings`; the only `select` naming
    // them is in the writer too.
    // settings-info.ts names two of them as its explanation KEYS (the ⓘ
    // copy, no database), which is not a write.
    const COPY = "src/lib/settings-info.ts";
    const offenders = files.filter((f) => rel(f) !== WRITER && rel(f) !== COPY && SETTING_WRITE.test(readFileSync(f, "utf8")));
    expect(offenders.map(rel)).toEqual([]);
  });
});
