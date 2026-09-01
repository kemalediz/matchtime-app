/**
 * RECURRENCE GUARD — comments that describe a deleted code path.
 *
 * `whatsapp-bot/src/smart-analysis.ts` documented, for four months, that
 * "a regex fast-path in handlers.ts catches obvious IN/OUT/score messages
 * BEFORE they queue here". That fast path was deleted on **2026-04-21**
 * (`handlers.ts` says so itself, in the docblock that replaced it) and
 * `index.ts:398` records the same decision — "no regex fast-path. Claude sees
 * the batch every 10 min". Three files, one of them wrong, and the wrong one
 * is the file you open when you are trying to work out why a message took ten
 * minutes to get a reaction.
 *
 * Found by the cold read in analyzer-redesign-2026-08-31.md §3.4.5, which
 * named one site. There were three.
 *
 * This test is deliberately narrow. It does not police prose. It asserts one
 * thing: no source file claims that a regex short-circuit handles ordinary
 * attendance messages before the LLM batch. The server does still keep a few
 * `handledBy: "fast-path"` branches (personal stats link, DM Q&A, admin
 * rating progress) — those are real, they answer from grounded data the
 * prompt cannot see, and none of them touch IN / OUT / score. The one that
 * did overlap with attendance, recruit, was deleted on 2026-09-01 in PR #33
 * after it swallowed a third-party OUT.
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
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Every non-test source file in the app and in the bot. */
function sources(): string[] {
  return [...walk(path.join(REPO, "src")), ...walk(path.join(REPO, "whatsapp-bot", "src"))];
}

describe("no source file claims a regex fast path still handles attendance", () => {
  it("nothing says a fast path catches IN/OUT/score before the batch", () => {
    const claims: string[] = [];
    for (const file of sources()) {
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // Only the PRESENT-tense claim. A file may — and handlers.ts does —
          // describe the fast path in the past tense to explain its removal.
          if (/regex fast[- ]path/i.test(line) && /\b(catches|handles|acts)\b/i.test(line)) {
            claims.push(`${path.relative(REPO, file)}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(claims).toEqual([]);
  });

  it("nothing says the analyzer receives only what the fast path did not handle", () => {
    const claims: string[] = [];
    for (const file of sources()) {
      const text = fs.readFileSync(file, "utf8");
      if (/fast[- ]path (didn't|did not|doesn't|does not) handle/i.test(text)) {
        claims.push(path.relative(REPO, file));
      }
    }
    expect(claims).toEqual([]);
  });

  it("PREMISE: handlers.ts really has no classification left in it", () => {
    const handlers = fs.readFileSync(path.join(REPO, "whatsapp-bot", "src", "handlers.ts"), "utf8");
    expect(handlers).toContain("It was removed on 2026-04-21");
    // The whole module is now a monitored-groups allow-list; nothing else.
    const exported = [...handlers.matchAll(/export function (\w+)/g)].map((m) => m[1]);
    expect(exported.sort()).toEqual([
      "addMonitoredGroup",
      "isMonitoredGroup",
      "setMonitoredGroups",
    ]);
  });
});

describe("no source file quotes a cost estimate the redesign measured as wrong", () => {
  it("never states a per-club LLM cost without pointing at where it came from", () => {
    // Three figures were in the tree — "~£2/month" (smart-analysis.ts),
    // "~£10/mo each" (message-analyzer.ts) and "Saves ~£10/mo per such group"
    // (analyze/route.ts). All three predate the shadow analyzer and the
    // prompt-cache buster, and all three were read afterwards as if they were
    // measurements. analyzer-redesign-2026-08-31.md §8.4 models $58-$207 per
    // club per month, falling to $28-$101 once step 0's two bugs are fixed,
    // and says plainly that even those are modelled, not measured.
    //
    // The rule this pins is not "no numbers". It is: a cost figure in a
    // comment must carry its source, so the next reader can tell whether it
    // was ever true. A bare figure with no provenance fails.
    const bad: string[] = [];
    for (const file of sources()) {
      const text = fs.readFileSync(file, "utf8");
      if (!/[£$]\s?\d[\d.,]*\s*(\/|\s)\s*(mo\b|month)/i.test(text)) continue;
      if (!text.includes("analyzer-redesign-2026-08-31.md")) {
        bad.push(path.relative(REPO, file));
      }
    }
    expect(bad).toEqual([]);
  });
});
