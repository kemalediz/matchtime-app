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

const DELETED = ["looksLikeRecruitRequest", "looksLikeRatingProgressRequest"] as const;

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
