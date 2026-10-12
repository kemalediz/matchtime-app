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
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { lockClubSetup } from "../club-setup";

const LIB = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(LIB, f), "utf8");
/** The code of a file, without its comments. */
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SETUP_FILES = ["club-setup.ts", "club-setup-dm.ts", "club-setup-dm-cancel.ts", "setup-learning/run.ts"];

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

  it("the order is written down once, in club-setup.ts", () => {
    expect(read("club-setup.ts")).toMatch(/THE LOCK ORDER FOR A CLUB'S SETUP STATE/);
    expect(read("club-setup.ts")).toMatch(/FOR NO KEY UPDATE, NEVER FOR UPDATE/);
  });
});
