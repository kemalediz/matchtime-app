/**
 * The partner ask's default (Kemal, 2026-10-29): when a club has not set
 * it, the last ask goes out 2 hours before kickoff. Defined once, in
 * club-partnership-rules.ts, and every reader uses that constant. (The
 * automatic ask's 08:00 default went with the automatic ask, 2026-11-08.)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "../club-partnership-rules";
import { askWindows } from "../partner-ask-rules";

const ROOT = join(__dirname, "..", "..", "..");
const H = 3600_000;

describe("the partner ask's defaults", () => {
  it("the cut-off is 2 hours", () => {
    expect(PARTNER_ASK_CUTOFF_DEFAULT_HOURS).toBe(2);
  });

  it("not set: the last ask falls 2 hours before kickoff", () => {
    const kickoff = new Date("2026-10-30T20:30:00Z");
    expect(askWindows(kickoff, PARTNER_ASK_CUTOFF_DEFAULT_HOURS).postBy.getTime()).toBe(kickoff.getTime() - 2 * H);
  });

  it("the column default in the schema is the same 2 hours", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(new RegExp(`partnerAskCutoffHours\\s+Int\\s+@default\\(${PARTNER_ASK_CUTOFF_DEFAULT_HOURS}\\)`));
  });
});

/** Every .ts/.tsx file under src, tests and generated code left out. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "generated" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("source guard: nobody copies the defaults", () => {
  // src/lib/pool/round.ts still has its own `?? 4` (2026-10-29): it was
  // being changed by another branch at the time, so it is reported rather
  // than edited here. Remove it from this list once it reads the constant.
  const PENDING = new Set(["src/lib/pool/round.ts"]);

  it("no cut-off falls back to a written number instead of PARTNER_ASK_CUTOFF_DEFAULT_HOURS", () => {
    const offenders = sources(join(ROOT, "src"))
      .map((p) => relative(ROOT, p))
      .filter((p) => !PENDING.has(p))
      .filter((p) => /cutoffHours\s*\?\?\s*\d/.test(readFileSync(join(ROOT, p), "utf8")));
    expect(offenders).toEqual([]);
  });
});
