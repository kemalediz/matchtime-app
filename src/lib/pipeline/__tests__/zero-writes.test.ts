/**
 * "STILL ZERO WRITES" — asserted by scanning the source, not promised in
 * a comment.
 *
 * §10 step 2 is a dry run: the pipeline decides what it WOULD do and the
 * shadow harness persists that for comparison. The whole reason step 2
 * carries "none" in the risk column is that nothing on this path can
 * change a squad.
 *
 * A comment saying so is worth nothing. Four seatbelts were found dead
 * on 2026-08-31, all silent, ALL WITH COMMENTS CLAIMING THEY WORKED, and
 * PR #30's own header says "a comment did not prevent recurrence twice
 * over". So this reads every file under `src/lib/pipeline/` and fails
 * the build if a mutating call appears in one.
 *
 * The single exemption is the shadow harness's `WindowVerdict` row, and
 * it is exempted BY NAME below, in the one file allowed to make it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "..");

/** Prisma mutations, raw SQL mutations, and the outbound queue. */
const WRITE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/, what: "a Prisma mutation" },
  { re: /\b(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE)\b/i, what: "a mutating SQL statement" },
  { re: /\$executeRaw|\$queryRawUnsafe/, what: "a raw Prisma execute" },
  { re: /\b(?:registerAttendance|cancelAttendance|forceBench)\s*\(/, what: "an attendance apply call" },
  { re: /\bbotJob\.\w*[Cc]reate/, what: "an outbound BotJob" },
];

/** file → the one mutation it is allowed to make, and why. */
const ALLOWED: Record<string, { pattern: RegExp; why: string }> = {
  "shadow.ts": {
    // shadow.ts itself creates no row; window-analyzer.ts does, using
    // shadow.ts's payload. Listed so the entry cannot rot into a rubber
    // stamp if that ever moves.
    pattern: /^$/,
    why: "no mutation; the WindowVerdict row is created by window-analyzer.ts",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the dry-run pipeline writes nothing", () => {
  const files = walk(DIR);

  it("finds the pipeline source (the scanner still works)", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.map((f) => path.basename(f))).toContain("engine.ts");
  });

  it.each(WRITE_PATTERNS)("no file performs $what", ({ re, what }) => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.basename(file);
      const src = fs.readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        // `messages.create` is the Anthropic SDK, not a database write.
        if (/messages\s*\.\s*create/.test(line)) return;
        // Comments describe; they do not mutate.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (!re.test(line)) return;
        const allow = ALLOWED[rel];
        if (allow && allow.pattern.source !== "(?:)" && allow.pattern.test(line)) return;
        offenders.push(`src/lib/pipeline/${rel}:${i + 1} — ${line.trim()}`);
      });
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `\n\n${what} found in the DRY-RUN pipeline:\n\n${offenders.join("\n")}\n\n` +
            `§10 step 2 is "still zero writes", and that is the entire reason\n` +
            `its risk column says "none". If a write genuinely belongs here,\n` +
            `that is step 6, not step 2 — and step 6 only happens after step\n` +
            `3's two weeks of comparison data.\n`,
    ).toEqual([]);
  });

  it("the engine is a pure function of its input (no clock, no env, no I/O)", () => {
    const src = fs.readFileSync(path.join(DIR, "engine.ts"), "utf8");
    expect(src).not.toMatch(/new Date\(\)/);
    expect(src).not.toMatch(/Date\.now\(\)/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/from ["']\.\.\/db["']/);
    expect(src).not.toMatch(/fetch\(/);
  });

  it("the composer never reaches for a model", () => {
    const src = fs.readFileSync(path.join(DIR, "compose.ts"), "utf8");
    expect(src).not.toMatch(/anthropic|messages\.create/i);
  });
});
