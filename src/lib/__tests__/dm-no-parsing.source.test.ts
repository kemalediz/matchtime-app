/**
 * NO CODE READS WHAT A DM MEANS (Kemal, 2026-10-30): "I don't want any
 * string parsing at all." The DM route's word lists are deleted and their
 * questions are model reads: GO, stop and start, and "is this a question"
 * by the one DM reader (`dm-intent.ts`, `dm-reader.ts`); a bench offer's
 * yes or no, a tentative follow-up's in or out and a cold IN or OUT by the
 * match-availability classifier. Pinned here, by reading the sources:
 *
 *   1. no production file defines or imports the deleted readers again;
 *   2. the files that act on a DM hold no regex or string test on the
 *      message text (`text`), and the pure DM rules files hold no regex
 *      at all.
 *
 * Out of scope, and so not checked: phones, LIDs, our own codes in our own
 * prefilled text (connect, pool confirm, ask ref), JSON from a model, and
 * the clean-up of a model's own answer.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "generated") continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const isTest = (f: string) => /__tests__|\.test\.tsx?$/.test(f);
const prodFiles = walk(SRC).filter((f) => !isTest(f));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** The source with comments taken out, so a history note never trips it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const DELETED = [
  "parseDmSubscriptionCommand",
  "isGoCommand",
  "looksLikeQuestion",
  "readBenchDmReply",
  "readTentativeFastPath",
  "classifyDmSelfAttendance",
  "decideDmSelfAttendanceFallback",
  "looksLikeHypotheticalOrPast",
  "offerIsAboutSomeoneElse",
];

describe("the DM word lists stay deleted", () => {
  it("the dm-reply-words module is gone", () => {
    expect(existsSync(path.join(SRC, "lib/dm-reply-words.ts"))).toBe(false);
  });

  it("no production file defines, imports or calls a deleted reader", () => {
    const hits: string[] = [];
    for (const f of prodFiles) {
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const name of DELETED) if (new RegExp(`\\b${name}\\b`).test(src)) hits.push(`${path.relative(ROOT, f)}: ${name}`);
      if (/dm-reply-words/.test(src)) hits.push(`${path.relative(ROOT, f)}: dm-reply-words`);
    }
    expect(hits).toEqual([]);
  });
});

describe("the files that act on a DM do not read its words", () => {
  /** A string or regex test on the message text. */
  const ON_TEXT = /\btext\b[^;\n]*\.(match|matchAll|split|includes|startsWith|endsWith|test|toLowerCase|toLocaleLowerCase|replace)\(|\.(test|exec|match)\(\s*(input\.|args\.)?text\b/;

  it.each([
    "src/app/api/whatsapp/dm-reply/route.ts",
    "src/lib/setup-go-dm.ts",
    "src/lib/dm-reader.ts",
    "src/lib/dm-self-attendance.ts",
    "src/lib/dm-subscriptions.ts",
    "src/lib/partner-guest-dm.ts",
  ])("%s", (rel) => {
    expect(code(rel).split("\n").filter((l) => ON_TEXT.test(l))).toEqual([]);
  });

  it.each(["src/lib/dm-reader.ts", "src/lib/dm-self-attendance.ts", "src/lib/dm-subscriptions.ts"])("%s holds no regex at all", (rel) => {
    const src = code(rel);
    expect(src).not.toMatch(/new RegExp\(/);
    // A regex literal: `/.../flags` after `(`, `=`, `,`, `:` or `return`.
    expect(src).not.toMatch(/(?:[(=,:]|return)\s*\/(?![/*])(?:\\.|[^/\n])+\/[gimsuy]*/);
  });
});
