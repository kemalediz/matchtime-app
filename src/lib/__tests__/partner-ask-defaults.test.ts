/**
 * The partner ask's defaults (Kemal, 2026-10-29): when a club has not set
 * them, the automatic ask goes out at 08:00 London on match day, and the
 * last ask goes out 2 hours before kickoff. Each default is defined once,
 * in club-partnership-rules.ts, and every reader uses that constant.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS, PARTNER_ASK_TIME_DEFAULT, effectiveAskTime } from "../club-partnership-rules";
import { askWindows, autoAskAt } from "../partner-ask-rules";

const ROOT = join(__dirname, "..", "..", "..");
const H = 3600_000;

describe("the partner ask's defaults", () => {
  it("the cut-off is 2 hours and the automatic time 08:00", () => {
    expect(PARTNER_ASK_CUTOFF_DEFAULT_HOURS).toBe(2);
    expect(PARTNER_ASK_TIME_DEFAULT).toBe("08:00");
  });

  it("not set: the last ask falls 2 hours before kickoff", () => {
    const kickoff = new Date("2026-10-30T20:30:00Z");
    expect(askWindows(kickoff, PARTNER_ASK_CUTOFF_DEFAULT_HOURS).postBy.getTime()).toBe(kickoff.getTime() - 2 * H);
  });

  it("not set, in summer time (BST): the automatic ask is 08:00 London, 07:00 UTC", () => {
    const kickoff = new Date("2026-10-23T19:30:00Z"); // Fri 23 Oct 20:30 BST
    expect(autoAskAt(kickoff, effectiveAskTime(null)).toISOString()).toBe("2026-10-23T07:00:00.000Z");
  });

  it("not set, in winter time (GMT): the automatic ask is 08:00 London, 08:00 UTC", () => {
    const kickoff = new Date("2026-10-30T20:30:00Z"); // Fri 30 Oct 20:30 GMT
    expect(autoAskAt(kickoff, effectiveAskTime(null)).toISOString()).toBe("2026-10-30T08:00:00.000Z");
  });

  it("the column default in the schema is the same 2 hours, and its comment says NULL = 08:00", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(new RegExp(`partnerAskCutoffHours\\s+Int\\s+@default\\(${PARTNER_ASK_CUTOFF_DEFAULT_HOURS}\\)`));
    expect(schema).toContain(`NULL = ${PARTNER_ASK_TIME_DEFAULT}.`);
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
