/**
 * ONE WRITER FOR `setupStage` (go-live plan 2.1, slice S1), modelled on
 * club-approval-source-guard.test.ts.
 *
 * "Approved but setting up" is read and written only through
 * `src/lib/club-setup.ts` and its pure half, `club-setup-rules.ts`.
 * Anywhere else, the only legal mentions of the field as a key are
 * `setupStage: true` in a Prisma `select` and a type annotation
 * (`setupStage: string`). A `data: { setupStage: "live" }` or an ad-hoc
 * `where: { setupStage: ... }` in some route would be a second idea of
 * what "setting up" means, and the club's silence hangs on there being
 * exactly one.
 *
 * Raw SQL that names the column in quotes ("setupStage") is not matched
 * by this scan; there is none in src/ today.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const ALLOWED = new Set([
  path.join(SRC, "lib", "club-setup.ts"),
  path.join(SRC, "lib", "club-setup-rules.ts"),
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const USES_KEY = /\bsetupStage\??\s*:/;
const SELECT_OR_TYPE = /\bsetupStage\??\s*:\s*(true|string)\b/;

describe("setupStage has one writer", () => {
  it("no source file outside club-setup uses setupStage as a key, except a select or a type", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (ALLOWED.has(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (USES_KEY.test(line) && !SELECT_OR_TYPE.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the scan can see both club-setup files (so the test is not vacuous)", () => {
    const files = walk(SRC);
    for (const allowed of ALLOWED) expect(files).toContain(allowed);
  });

  it("the pattern catches a write and a filter, and lets a select and a type through", () => {
    const bad = (line: string) => USES_KEY.test(line) && !SELECT_OR_TYPE.test(line);
    expect(bad(`data: { setupStage: "live" },`)).toBe(true);
    expect(bad(`where: { id, setupStage: "setting-up" },`)).toBe(true);
    expect(bad(`where: { setupStage: { not: "live" } },`)).toBe(true);
    expect(bad(`select: { id: true, setupStage: true },`)).toBe(false);
    expect(bad(`  setupStage: string;`)).toBe(false);
  });

  it("the AI budget exception has ONE caller: only the setup-learning sweep opens the setup-reading scope", () => {
    const users: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      if (/\bwithSetupReadingAiBudget\b|\bsetupReading\s*:\s*true\b/.test(text)) users.push(path.relative(SRC, file));
    }
    expect(users.sort()).toEqual(["lib/ai-budget.ts", "lib/setup-learning/run.ts"]);
  });

  it("the stage is actually written down in the pure half", () => {
    const rules = readFileSync(path.join(SRC, "lib", "club-setup-rules.ts"), "utf8");
    expect(rules).toMatch(/setupStage: "setting-up"/);
  });
});
