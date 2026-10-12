/**
 * THE LOCK ORDER FOR A CLUB'S SETUP STATE (written at the top of
 * src/lib/club-setup.ts), as far as source can show it. The proof is the
 * 200-round races against a real Postgres in
 * e2e/helpers/setup-hold-lib-tests.ts (checks 7 to 11).
 *
 * What went wrong on main: two transactions locked the club's row with a
 * plain `SELECT ... FOR UPDATE`. That conflicts with the FOR KEY SHARE an
 * insert of any row referencing the club takes, and the reading's claim
 * is such an insert, so a close holding the club waited for the claim
 * while the claim waited for the club: a deadlock.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { lockClubSetup } from "../club-setup";

const LIB = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(LIB, f), "utf8");
/** The code of a file, without its comments. */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (f: string) => strip(read(f));
const codeOf = (full: string) => strip(readFileSync(full, "utf8"));

const SETUP_FILES = [
  "club-setup.ts",
  "club-setup-dm.ts",
  "club-setup-dm-cancel.ts",
  "club-setup-reminder.ts",
  "club-setup-removal.ts",
  "club-setup-stuck.ts",
  "setup-learning/run.ts",
];

const SRC = path.resolve(LIB, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|sql)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
/** A raw SQL statement (one template literal) that names the club's table
 *  and locks FOR UPDATE. "FOR NO KEY UPDATE" does not match. */
const CLUB_FOR_UPDATE = /`[^`]*"Organisation"[^`]*\bFOR UPDATE\b[^`]*`|`[^`]*\bFOR UPDATE\b[^`]*"Organisation"[^`]*`/;

describe("the lock order for a club's setup state", () => {
  it("lockClubSetup locks the club's row FOR NO KEY UPDATE, the weakest lock that serialises its writers", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    await lockClubSetup(
      {
        $executeRaw: async (q: TemplateStringsArray, ...values: unknown[]) => {
          calls.push({ sql: q.join("?"), values });
          return 1;
        },
      },
      "org-riverside",
    );
    expect(calls).toEqual([{ sql: `SELECT 1 FROM "Organisation" WHERE "id" = ? FOR NO KEY UPDATE`, values: ["org-riverside"] }]);
  });

  it("no setup module locks a row with a plain FOR UPDATE", () => {
    for (const f of SETUP_FILES) expect(code(f), f).not.toMatch(/FOR UPDATE/);
  });

  it("the one explicit lock on the club is lockClubSetup, and both transactions that need it call it FIRST", () => {
    for (const f of SETUP_FILES) {
      const explicit = (code(f).match(/FROM "Organisation"[^`]*FOR NO KEY UPDATE/g) ?? []).length;
      expect(explicit, f).toBe(f === "club-setup.ts" ? 1 : 0);
    }
    // The reading's apply: the club, then the reading row.
    const apply = code("setup-learning/run.ts");
    const applyTx = apply.slice(apply.indexOf("async function applyAndRecord"));
    expect(applyTx.indexOf("lockClubSetup(tx, orgId)")).toBeGreaterThan(0);
    expect(applyTx.indexOf("lockClubSetup(tx, orgId)")).toBeLessThan(applyTx.indexOf("finish(orgId"));
    // The cap's close: the club, then the reading row, then the connect rows.
    const dm = code("club-setup-dm.ts");
    const close = dm.slice(dm.indexOf("export async function closeReadingForGood"));
    const at = (s: string) => close.indexOf(s);
    expect(at("lockClubSetup(tx, orgId)")).toBeGreaterThan(0);
    expect(at("lockClubSetup(tx, orgId)")).toBeLessThan(at(`INSERT INTO "ClubSetupLearning"`));
    expect(at(`INSERT INTO "ClubSetupLearning"`)).toBeLessThan(at("clearCapturedChatForClub(tx, orgId)"));
  });

  it("go-live writes the club before it closes the reading", () => {
    const src = code("club-setup.ts");
    const tx = src.slice(src.indexOf("async function goLiveClubTx"));
    expect(tx.indexOf("tx.organisation.updateMany")).toBeGreaterThan(0);
    expect(tx.indexOf("tx.organisation.updateMany")).toBeLessThan(tx.indexOf("closeUnfinishedSetupLearning(orgId, tx"));
  });

  // THE SOURCE GUARD (so this cannot come back). FOR UPDATE on a club's
  // row conflicts with the FOR KEY SHARE that every insert of a row
  // referencing the club takes, and has deadlocked twice: the setup DM's
  // close, and the billing writer inside go-live. FOR NO KEY UPDATE
  // serialises the club's writers just as well. Nothing is allow-listed.
  it("NO file under src/ locks a club's Organisation row FOR UPDATE in raw SQL", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(300);
    const offenders = files.filter((f) => CLUB_FOR_UPDATE.test(codeOf(f))).map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("the guard sees the statements it must refuse, and lets the right lock through", () => {
    const bad = [
      'await tx.$executeRaw`SELECT 1 FROM "Organisation" WHERE "id" = ${orgId} FOR UPDATE`;',
      'tx.$queryRaw`\n  SELECT "billingStatus" FROM "Organisation"\n  WHERE "id" = ${orgId}\n  FOR UPDATE`',
      'tx.$queryRaw`SELECT 1 FROM "Organisation" o WHERE o."id" = ${id} FOR UPDATE OF o`',
      'tx.$queryRaw`SELECT 1 FROM "ClubBilling" b JOIN "Organisation" o ON o."id" = b."orgId" FOR UPDATE`',
    ];
    for (const s of bad) expect(CLUB_FOR_UPDATE.test(s), s).toBe(true);
    const fine = [
      'await tx.$executeRaw`SELECT 1 FROM "Organisation" WHERE "id" = ${orgId} FOR NO KEY UPDATE`;',
      'tx.$queryRaw`SELECT "trialEndsAt" FROM "ClubBilling" WHERE "orgId" = ${orgId} FOR UPDATE`',
      'tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`',
      // Two statements side by side are two statements.
      'a`SELECT 1 FROM "Organisation" WHERE "id" = ${o} FOR NO KEY UPDATE`; b`SELECT 1 FROM "ClubBilling" FOR UPDATE`',
    ];
    for (const s of fine) expect(CLUB_FOR_UPDATE.test(s), s).toBe(false);
  });

  it("the billing writer locks the club FOR NO KEY UPDATE in both places, and its own row FOR UPDATE", () => {
    const billing = code("club-billing.ts");
    expect(billing.match(/FROM "Organisation" WHERE "id" = \$\{orgId\} FOR NO KEY UPDATE/g)).toHaveLength(2);
    expect(billing.match(/FROM "ClubBilling" WHERE "orgId" = \$\{orgId\} FOR UPDATE/g)).toHaveLength(1);
  });

  it("the reminder takes the club through lockClubSetup, first in its transaction", () => {
    const src = code("club-setup-reminder.ts");
    const tx = src.slice(src.indexOf("db.$transaction"));
    expect(tx.indexOf("lockClubSetup(")).toBeGreaterThan(0);
    expect(tx.indexOf("lockClubSetup(")).toBeLessThan(tx.indexOf("sentNotification.createMany"));
  });

  it("the order is written down once, in club-setup.ts", () => {
    expect(read("club-setup.ts")).toMatch(/THE LOCK ORDER FOR A CLUB'S SETUP STATE/);
    expect(read("club-setup.ts")).toMatch(/FOR NO KEY UPDATE, NEVER FOR UPDATE/);
  });
});
