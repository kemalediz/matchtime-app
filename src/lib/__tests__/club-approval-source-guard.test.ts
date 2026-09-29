/**
 * ONE WRITER FOR `approvalStatus` (plan section 3.1, enforcement 3 of 3).
 *
 * The club-approval state is read and written only through
 * `src/lib/club-approval.ts` (and its pure half, club-approval-state.ts).
 * Anywhere else, the only legal mentions of the field as a key are
 * `approvalStatus: true` in a Prisma `select` and a type annotation.
 * A `data: { approvalStatus: "approved" }` or an ad-hoc
 * `where: { approvalStatus: ... }` in some route would be a second idea
 * of what "approved" means, which is exactly how the dormancy bug of
 * 2026-09-09 happened (two different ideas of "active").
 *
 * Raw SQL that names the column in quotes ("approvalStatus") is not
 * matched by this scan; there is none in src/ today.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const ALLOWED = new Set([
  path.join(SRC, "lib", "club-approval.ts"),
  path.join(SRC, "lib", "club-approval-state.ts"),
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

describe("approvalStatus has one writer", () => {
  it("no source file outside club-approval uses approvalStatus as a key, except a select or a type", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (ALLOWED.has(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // Allowed: `approvalStatus: true` (a select) and a type annotation
        // (`approvalStatus: string`), which is a shape, not a value.
        if (/\bapprovalStatus\??\s*:/.test(line) && !/\bapprovalStatus\??\s*:\s*(true|string)\b/.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the scan can see club-approval.ts (so the test is not vacuous)", () => {
    expect(walk(SRC)).toContain(path.join(SRC, "lib", "club-approval.ts"));
  });
});
