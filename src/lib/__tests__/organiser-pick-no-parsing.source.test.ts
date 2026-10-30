/**
 * NO CODE READS A REPLY TO THE BENCH PICK (Kemal, 2026-10-30): "I don't want
 * any string parsing at all." An organiser's reply to MatchTime's numbered
 * bench list ("2 3", "1-3", "all", "none", names, an @tag, YES) was read by
 * `parsePickReply` with word lists, a numbers regex and name folding. It is
 * read by the pick reader now, a model (`organiser-pick-reader.ts`). Pinned
 * here, by reading the sources:
 *
 *   1. no production file defines the old parser or its word lists again;
 *   2. the pick modules import no removed parser;
 *   3. the rules, the reader and its prompt module split, match or test no
 *      text at all, outside comments;
 *   4. `organiser-pick.ts` touches the reply's text with none of those
 *      either (it handles phones and JIDs, which are not a person's words);
 *   5. the reply reaches the reader.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The code of a source, comments and string contents left out (as in
 *  `hq-squad-paste-no-parsing.source.test.ts`). */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}
/** Text handling these modules must not do. */
const TEXT_PARSING = /\.(split|match|matchAll|test|replace|replaceAll|search)\s*\(|\bRegExp\s*\(/;

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const RULES = "src/lib/organiser-pick-rules.ts";
const PICK = "src/lib/organiser-pick.ts";
const READER = "src/lib/organiser-pick-reader.ts";
const PROMPT = "src/lib/organiser-pick-reader-prompt.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "generated") continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}
const prodFiles = walk(SRC).filter((f) => !f.includes("__tests__") && !f.endsWith(".test.ts"));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** The old parser, defined in any form (its names are its own). */
const OLD_PARSER = /\b(function|const|let|var)\s+(parsePickReply|foldPickText|expandNumbers|looksLikeAPick)\b/;
/** Its word lists and patterns (other modules have their own YES_WORDS,
 *  so these are checked in the pick modules only). */
const OLD_WORDS = /\b(const|let|var)\s+(NONE_WORDS|ALL_WORDS|YES_WORDS|NUMBERS_SHAPE|BOT_MENTION|TAG_TOKEN|resolveName)\b/;
/** Importing a removed name from anywhere. */
const OLD_IMPORT = /\b(parsePickReply|foldPickText|PickReplyContext)\b/;

describe("a reply to the bench pick is read by the model, never by code", () => {
  it("no production file defines the old parser, and the pick modules keep none of its word lists", () => {
    const offenders = prodFiles.filter((f) => OLD_PARSER.test(codeOf(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    for (const f of [RULES, PICK, READER, PROMPT]) expect(OLD_WORDS.test(codeOf(read(f))), f).toBe(false);
  });

  it("nothing in production names the removed parser", () => {
    const offenders = prodFiles.filter((f) => OLD_IMPORT.test(codeOf(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("the rules, the reader and its prompt module split, match or test no text", () => {
    for (const f of [RULES, READER, PROMPT]) {
      const hits = codeOf(read(f))
        .split("\n")
        .filter((l) => TEXT_PARSING.test(l));
      expect(hits, f).toEqual([]);
    }
  });

  it("organiser-pick.ts never splits, matches or tests the reply's text, and keeps no word list", () => {
    const code = codeOf(read(PICK)).split("\n");
    expect(code.filter((l) => /\btext\b/.test(l) && TEXT_PARSING.test(l))).toEqual([]);
    expect(code.filter((l) => /new Set\(\[\s*""/.test(l))).toEqual([]);
  });

  it("the reply reaches the reader, and the reader its prompt", () => {
    expect(read(PICK)).toMatch(/from "\.\/organiser-pick-reader"/);
    expect(read(READER)).toMatch(/from "\.\/organiser-pick-reader-prompt"/);
  });
});

describe("the guard itself catches the old shapes", () => {
  it("a word list, the parser, a numbers regex on the text", () => {
    expect(OLD_WORDS.test(codeOf(`const NONE_WORDS = new Set(["none"]);`))).toBe(true);
    expect(OLD_PARSER.test(codeOf(`export function parsePickReply(t: string) {}`))).toBe(true);
    const line = codeOf(`const tokens = [...text.matchAll(/@(\\d{5,})\\b/g)];`);
    expect(/\btext\b/.test(line) && TEXT_PARSING.test(line)).toBe(true);
  });
});
