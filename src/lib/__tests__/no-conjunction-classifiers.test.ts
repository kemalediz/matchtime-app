/**
 * RECURRENCE GUARD — the conjunction-shaped classifier, by name.
 *
 * This codebase has now deleted a regex that decided what a message
 * MEANT four times, each time after a production incident:
 *
 *   2026-04-21  `handlers.ts:7-10`, at Kemal's explicit request
 *   2026-09-01  `looksLikeRecruitRequest` on the GROUP path — it matched
 *               the second sentence of "Najib is out. We need one more
 *               player.", the drop was never analysed by anything, and
 *               MatchTime told the owner his squad was full
 *   2026-09-10  the stats blast's three ANDed keyword tests — 69 mass
 *               DMs off an owner's reminder to his players
 *   2026-09-11  the last two, both on the DM surface:
 *               `looksLikeRecruitRequest`'s final caller and
 *               `looksLikeRatingProgressRequest`
 *   2026-09-11  `isAffirmative` / `isNegative` on the MONEY path — an
 *               emoji ANYWHERE in the body released the squad's pay
 *               links, so "great game 👍" charged 8-13 real people, and
 *               an unanchored word list made "ok so I'll sort it
 *               tomorrow" a yes. Replaced by `lib/fee-confirm.ts`: an
 *               anchored whole-body allowlist first, the model only for
 *               what it abstains on. That one is an ARGUED hybrid
 *               rather than a straight deletion — the argument is at
 *               `FEE_CONFIRM_ANCHORS_BEFORE_IT_ASKS`.
 *
 * Every one had the same shape: two or three keyword tests ANDed over a
 * whole body, standing in for reading a sentence. This file asserts the
 * two deleted functions stay deleted and that nothing imports them, so
 * the fifth one has to be argued for rather than merged.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "generated" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Every source file that could CALL one of them: `src/`, the bot, the
 *  e2e suite and the scripts. Comments are allowed to name them — the
 *  tombstones have to — so this looks for a call or an import. */
function sources(): string[] {
  return [
    ...walk(path.join(REPO, "src")),
    ...walk(path.join(REPO, "whatsapp-bot", "src")),
    ...walk(path.join(REPO, "e2e")),
    ...walk(path.join(REPO, "scripts")),
  ];
}

const DELETED = [
  "looksLikeRecruitRequest",
  "looksLikeRatingProgressRequest",
  "isAffirmative",
  "isNegative",
] as const;

describe("the deleted conjunction classifiers have ZERO callers", () => {
  for (const name of DELETED) {
    it(`nothing imports or calls ${name}`, () => {
      const hits: string[] = [];
      for (const file of sources()) {
        fs.readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            // A call (`name(`) or an import binding. A mention inside a
            // comment or a string is the tombstone doing its job.
            const trimmed = line.trim();
            if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
            if (new RegExp(`\\b${name}\\s*\\(`).test(line)) {
              hits.push(`${path.relative(REPO, file)}:${i + 1}  ${trimmed}`);
            }
            if (new RegExp(`(import|from)[^\\n]*\\b${name}\\b`).test(line)) {
              hits.push(`${path.relative(REPO, file)}:${i + 1}  ${trimmed}`);
            }
          });
      }
      expect(hits).toEqual([]);
    });
  }

  it("neither function is exported any more", () => {
    const recruit = fs.readFileSync(path.join(REPO, "src", "lib", "recruit.ts"), "utf8");
    const rating = fs.readFileSync(path.join(REPO, "src", "lib", "rating-progress.ts"), "utf8");
    expect(recruit).not.toMatch(/export function looksLikeRecruitRequest/);
    expect(rating).not.toMatch(/export function looksLikeRatingProgressRequest/);
  });

  it("the money path no longer tests for an emoji ANYWHERE in the body", () => {
    const flow = fs.readFileSync(path.join(REPO, "src", "lib", "payment-flow.ts"), "utf8");
    const code = flow
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");
    // The exact shape that released a live club's pay links off "great
    // game 👍". Any unanchored emoji or word test in this file is the
    // regression.
    expect(code).not.toMatch(/\/\[[^\]]*[\u2705\u2714\u{1F44D}][^\]]*\]\/u?\.test/u);
    expect(code).not.toMatch(/\^\(yes\|/);
    // …and the replacement is wired in.
    expect(code).toContain("anchoredFeeReply");
  });

  it("the money path's replacement carries its argument, not just its code", () => {
    const fee = fs.readFileSync(path.join(REPO, "src", "lib", "fee-confirm.ts"), "utf8");
    expect(fee).toContain("FEE_CONFIRM_ANCHORS_BEFORE_IT_ASKS");
    // The measured history, so nobody re-argues this from imagination.
    expect(fee).toContain("6   fee-confirmation prompts ever sent");
    // Both directions priced, and the failure direction named.
    expect(fee).toMatch(/A WRONG RELEASE costs/);
    expect(fee).toMatch(/A WRONG REFUSAL costs/);
  });

  it("each deletion left a tombstone naming the incident that caused it", () => {
    const recruit = fs.readFileSync(path.join(REPO, "src", "lib", "recruit.ts"), "utf8");
    const rating = fs.readFileSync(path.join(REPO, "src", "lib", "rating-progress.ts"), "utf8");
    // The group incident that killed it for the group, and the DM
    // conversion that killed it outright.
    expect(recruit).toContain("2026-09-01");
    expect(recruit).toContain("2026-09-11");
    expect(rating).toContain("2026-09-11");
    // And the cost each one names out loud.
    expect(rating).toMatch(/clause peel/i);
  });
});
