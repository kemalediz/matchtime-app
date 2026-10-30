/**
 * NO CODE READS WHAT A MEMBER MEANT IN HQ (Kemal, 2026-10-30: "I don't want
 * any string parsing at all"). The admin group (HQ) is read by the shared
 * router and then, for who plays, by the HQ squad reader (a model), with
 * the group's recent messages as context. Code gates on facts only: who
 * sent it, which match, who is confirmed, what MatchTime last asked, the
 * quoted message's id, the Pi's tag token.
 *
 * Removed on 2026-10-30, pinned here by reading the sources:
 *   - `admin-group-name-list.ts` (`readHqNameList`, `hqNameListFacts`): a
 *     short list of capitalised names with IN or OUT, read by code ahead of
 *     the router;
 *   - the HQ claim hold (`adminClaimHold`, `HQ_FILLER`, `HQ_COMMAND`,
 *     `HQ_ANCHOR`, `SELF_MARKERS`, `hqClauses`, `isCommandClause`): EN and
 *     TR word lists deciding whether a sentence was an instruction;
 *   - the multi-line gate in front of the HQ squad reader (`text.includes`
 *     a new line): one-line lists never reached it;
 *   - the router's floor (`floorAttendanceFacts`) as a reader of HQ claims;
 *   - the HQ score's scoreline shape checks (`statesSeveralScorelines`,
 *     `hasScorelineShape`) and the score route overrides read from the
 *     words (`scoreRouteOverrides`).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const HQ = [
  "src/lib/admin-group.ts",
  "src/lib/admin-group-understand.ts",
  "src/lib/admin-group-squad-change.ts",
  "src/lib/admin-group-squad-rules.ts",
  "src/lib/admin-group-paste.ts",
  "src/lib/admin-group-score.ts",
  "src/lib/hq-squad-reader.ts",
  "src/lib/hq-squad-reader-prompt.ts",
];
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

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

/** The code of a source, comments and string contents left out. */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

const REMOVED = /\b(readHqNameList|hqNameListFacts|adminClaimHold|HQ_FILLER|HQ_COMMAND|HQ_ANCHOR|SELF_MARKERS|hqClauses|isCommandClause)\b/;
const REMOVED_IMPORTS = /\b(floorAttendanceFacts|statesSeveralScorelines|hasScorelineShape|scoreRouteOverrides|messageTagsBot)\b/;
const TEXT_PARSING = /\.(split|match|matchAll|test|replace|replaceAll|search)\s*\(|\bRegExp\s*\(/;

describe("HQ: the model reads the words, never code", () => {
  it("the name-list parser is gone", () => {
    expect(existsSync(path.join(ROOT, "src/lib/admin-group-name-list.ts"))).toBe(false);
    expect(prodFiles.filter((f) => /admin-group-name-list/.test(codeOf(readFileSync(f, "utf8"))) || /["']\.\/admin-group-name-list["']/.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("no production file defines the old HQ word lists or hold again", () => {
    expect(prodFiles.filter((f) => REMOVED.test(codeOf(readFileSync(f, "utf8")))).map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("no HQ file uses the floor, the scoreline shape checks, the score overrides or the bot-name text test", () => {
    for (const f of HQ) expect(REMOVED_IMPORTS.test(codeOf(read(f))), f).toBe(false);
  });

  it("the HQ door, the paste, the score and the reader split, match or test no text", () => {
    for (const f of ["src/lib/admin-group.ts", "src/lib/admin-group-understand.ts", "src/lib/admin-group-paste.ts", "src/lib/admin-group-score.ts", "src/lib/hq-squad-reader.ts", "src/lib/hq-squad-reader-prompt.ts"]) {
      expect(codeOf(read(f)).split("\n").filter((l) => TEXT_PARSING.test(l)), f).toEqual([]);
    }
  });

  it("the squad change reads no words: only the Pi's raw tag token and the engine's own resolved name", () => {
    const hits = codeOf(read("src/lib/admin-group-squad-change.ts"))
      .split("\n")
      .filter((l) => TEXT_PARSING.test(l))
      .map((l) => l.trim());
    expect(hits).toHaveLength(2);
    // `@<digits>`: WhatsApp's mention token, a fact the Pi supplies.
    expect(hits.some((l) => l.includes("/@\\d{5,}/.test(text)"))).toBe(true);
    // The name the engine's resolver read, shown back without its "@".
    expect(hits.some((l) => l.includes('personRef.trim().replace(/^@/, "")'))).toBe(true);
  });

  it("the squad rules hold no word list: only the name rules that place a model's name on a member", () => {
    const code = codeOf(read("src/lib/admin-group-squad-rules.ts"));
    expect(code).not.toMatch(/new Set\(\[\s*""/);
    expect(code).not.toMatch(/\bhold\b[^\n]*"not-a-command"/);
  });

  it("a squad message reaches the HQ squad reader through the shared door, after the router", () => {
    const door = codeOf(read("src/lib/admin-group-understand.ts"));
    expect(door.indexOf("await gateBatch(")).toBeGreaterThan(-1);
    expect(door.indexOf("readHqSquad(")).toBeGreaterThan(-1);
    expect(read("src/lib/admin-group.ts")).not.toMatch(/proposeSquadPaste|readHqSquad/);
  });
});

describe("the guard catches a way back", () => {
  it("a word set, a split, a regex test", () => {
    expect(REMOVED.test(codeOf("const HQ_FILLER = new Set(['please']);"))).toBe(true);
    expect(TEXT_PARSING.test(codeOf("body.split(/,/)"))).toBe(true);
    expect(REMOVED_IMPORTS.test(codeOf('import { floorAttendanceFacts } from "./pipeline/router";'))).toBe(true);
    expect(TEXT_PARSING.test(codeOf("// body.split(x) was the old way"))).toBe(false);
  });
});
