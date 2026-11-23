/**
 * WHEN THE NEXT ADMIN ACTION OF A MESSAGE MAY RUN (2026-11-23, review of
 * #629 item 2). `letsNextActionRun` reads the cores' own outcome codes. Every
 * code a core can return is classified in ONE table (`ACTION_OUTCOMES`): a
 * core that gains a code not in it fails the scan below, so the table cannot
 * drift from the cores.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_OUTCOMES, letsNextActionRun } from "../multi-instruction-reply";

describe("letsNextActionRun", () => {
  it("a month's coverage done, the same, or merged goes through (HQ prefixes them)", () => {
    for (const c of ["hq-month-coverage-done", "hq-month-coverage-same", "hq-month-coverage-merged"]) expect(letsNextActionRun(c), c).toBe(true);
    for (const c of ["hq-month-coverage-asked", "hq-month-coverage-confirm", "hq-month-coverage-which"]) expect(letsNextActionRun(c), c).toBe(false);
  });

  it("already so is through: the group already asked, a game already at that time", () => {
    expect(letsNextActionRun("group-ask-already")).toBe(true);
    expect(letsNextActionRun("hq-game-move-stayed-unchanged")).toBe(true);
    expect(letsNextActionRun("format-unchanged")).toBe(true);
    expect(letsNextActionRun("hq-game-move-stayed-started")).toBe(false);
  });

  it("the organisers-only refusals never hold the rest back (each action checks the right itself)", () => {
    for (const c of ["organisers_only", "hq-only-organisers", "match_cancel_organisers_only"]) expect(letsNextActionRun(c), c).toBe(true);
  });

  it("a question back, no game, a refusal: held", () => {
    for (const c of ["format-no-size", "hq-game-move-which", "player-range-which", "venue-which", "hq-pool-not-asked", "xask-words-ambiguous"]) expect(letsNextActionRun(c), c).toBe(false);
  });
});

describe("every outcome code the admin cores return is classified", () => {
  // The cores an admin action goes through, and the code families they own.
  const CORES = [
    "format-switch-words", "format-resize", "quiet-hours-words", "player-range-words", "season-break-words", "open-squad-save",
    "game-move-words", "venue-from-words", "month-coverage-words", "pool-ask-words", "partner-ask-words", "admin-group-ask-group", "named-invite",
  ];
  const FAMILY = /"((?:format|quiet-hours|player-range|season-break|open-squad|game-move|venue|month-coverage|hq-pool|xask-words|group-ask|named)-[a-z0-9-]+|group-asked)"/g;
  // Strings of those families that are not outcomes of the action: a bench
  // offer's close reason, a notification kind, a resize's cause.
  const NOT_OUTCOMES = new Set(["format-switch", "format-up-settled"]);

  it("each is either through or not, in ACTION_OUTCOMES", () => {
    const missing: string[] = [];
    for (const core of CORES) {
      const src = fs.readFileSync(path.join(__dirname, "..", `${core}.ts`), "utf8");
      for (const m of src.matchAll(FAMILY)) if (!NOT_OUTCOMES.has(m[1]) && !(m[1] in ACTION_OUTCOMES)) missing.push(`${core}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it("the game-move stayed reasons are each classified", () => {
    for (const r of ["started", "set-by-hand", "into-the-past", "other-month", "unreadable-time", "unchanged", "gone"]) expect(`game-move-stayed-${r}` in ACTION_OUTCOMES, r).toBe(true);
  });
});
