/**
 * ONE HOME FOR THE SETUP STAGE (go-live plan 2.1, slice S1; made strict
 * after the review of PR #232).
 *
 * "Approved but setting up" is read and written only through
 * `src/lib/club-setup.ts` and its pure half, `club-setup-rules.ts`. The
 * first version of this guard looked for the column used as an object
 * key, and missed the shorthand `data: { stage }`, a quoted or computed
 * key, raw SQL, a plain read (`org.<column> === "..."`), a line holding a
 * select and a write, and the writer helper spread from another file.
 *
 * So it is now the simple, strict rule: OUTSIDE AN EXPLICIT ALLOW-LIST,
 * THE WORD DOES NOT APPEAR AT ALL, in code, strings, SQL or comments, in
 * `src/` and `scripts/`. Every other module goes through the exported
 * where-fragments (`SETTING_UP_CLUB_WHERE`, `LIVE_STAGE_WHERE`,
 * `IN_LIVE_STAGE_CLUB_WHERE`, `SETUP_READABLE_CLUB_WHERE`), the select
 * (`SETUP_STAGE_SELECT`), the type (`SetupStageColumns`) and the
 * predicates (`isClubSettingUp`, `settingUpOnly`, `preferLiveClubs`).
 *
 * The same rule guards the one AI budget exception: the setup-reading
 * purpose may be named only by ai-budget.ts and the sweep.
 *
 * Allowed everywhere: test files (`__tests__`, `*.test.ts`), the
 * generated Prisma client, and anything outside `src/` and `scripts/`
 * (the Prisma schema, the migrations, `e2e/`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(SRC, "..");
const SCRIPTS = path.join(REPO, "scripts");
const rel = (file: string) => path.relative(REPO, file);

/** The column itself. */
const STAGE_FILES = ["src/lib/club-setup-rules.ts", "src/lib/club-setup.ts"];
/**
 * The helper that returns the fields a held approval writes. Slice S3
 * added exactly one file here, `src/lib/club-approval.ts`: `decideClub`
 * spreads it in its one approving compare-and-set. Nothing else may.
 */
const STAGE_WRITER_FILES = ["src/lib/club-setup-rules.ts", "src/lib/club-setup.ts", "src/lib/club-approval.ts"];
/** The setup-reading AI budget purpose. */
const READING_FILES = ["src/lib/ai-budget.ts", "src/lib/setup-learning/run.ts"];

const STAGE_WORD = /setupStage/;
const STAGE_WRITER_WORD = /settingUpClubFields/;
const READING_WORD = /setupReading|SetupReading|AllowancePurpose/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|sql)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = [...walk(SRC), ...walk(SCRIPTS)];

function offenders(word: RegExp, allowed: string[]): string[] {
  const out: string[] = [];
  for (const file of FILES) {
    if (allowed.includes(rel(file))) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (word.test(line)) out.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
  }
  return out;
}

describe("the setup stage has one home", () => {
  it("the column's name appears in no file of src/ or scripts/ outside the two club-setup modules", () => {
    expect(offenders(STAGE_WORD, STAGE_FILES)).toEqual([]);
  });

  it("the helper that writes the stage is named in no other file (only decideClub's held approval spreads it)", () => {
    expect(offenders(STAGE_WRITER_WORD, STAGE_WRITER_FILES)).toEqual([]);
    // Slice S3: exactly one use in club-approval.ts, beside its import.
    const approval = readFileSync(path.join(SRC, "lib", "club-approval.ts"), "utf8");
    expect(approval.match(/settingUpClubFields\(\)/g)).toHaveLength(1);
  });

  it("the setup-reading AI budget purpose is named only by ai-budget.ts and the sweep", () => {
    expect(offenders(READING_WORD, READING_FILES)).toEqual([]);
  });

  it("the scan covers src/ and scripts/, and can see every allow-listed file (so it is not vacuous)", () => {
    const seen = FILES.map(rel);
    for (const f of [...STAGE_FILES, ...READING_FILES]) expect(seen).toContain(f);
    expect(seen.some((f) => f.startsWith("scripts/"))).toBe(true);
    expect(readFileSync(path.join(SRC, "lib", "club-setup-rules.ts"), "utf8")).toMatch(/setupStage: "setting-up"/);
  });

  it("the words catch every shape the first guard missed", () => {
    const stage = [
      `data: { setupStage: "live" },`,
      `where: { id, setupStage: "setting-up" },`,
      `data: { setupStage },`,
      `data: { "setupStage": "live" },`,
      `data: { ["setupStage"]: stage },`,
      `await db.$executeRaw\`UPDATE "Organisation" SET "setupStage" = 'live'\`;`,
      `if (org.setupStage === "setting-up") return;`,
      `select: { setupStage: true }, data: { setupStage: "live" },`,
      `select: { id: true, setupStage: true },`,
      `// flips setupStage by hand`,
    ];
    for (const line of stage) expect(STAGE_WORD.test(line), line).toBe(true);
    expect(STAGE_WRITER_WORD.test(`data: { ...settingUpClubFields() },`)).toBe(true);
    const reading = [
      `prismaAiBudgetLedger(undefined, { setupReading: true })`,
      `const p = { setupReading: on };`,
      `const p = { ["setupReading"]: true };`,
      `const p: AllowancePurpose = purposeFromElsewhere;`,
      `withSetupReadingAiBudget(orgId, fn)`,
    ];
    for (const line of reading) expect(READING_WORD.test(line), line).toBe(true);
  });
});
