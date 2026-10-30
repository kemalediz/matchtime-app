/**
 * NO CODE READS A LIST PASTED IN HQ (Kemal, 2026-10-29): "never make
 * MatchTime understand people with regex, string splits or exact phrases,
 * even for pasted lists". FNF HQ, 29 Oct: the string reader that stood in
 * front of the admin group's pipeline read a pasted two-sided teams sheet
 * as a squad of 9 and proposed dropping the other 9; a YES dropped them.
 * Then "Swap / 9 names / With / 9 names" was proposed with two new players
 * called "Swap" and "With". A multi-line HQ message is now read by the HQ
 * squad reader, a model (`hq-squad-reader.ts`). Pinned here, by reading
 * the sources:
 *
 *   1. no production file defines the old readers again;
 *   2. the HQ paste path (`admin-group-paste.ts`, the reader, its prompt
 *      module, and the squad rules it uses) imports no text parser
 *      (`pasted-roster.ts`, `admin-group-name-list.ts`), statically or
 *      dynamically;
 *   3. the paste, the reader and its prompt module split, match or test no
 *      text: no `.split(`, `.match(`, `.matchAll(`, `.test(`, `.replace(`,
 *      `.search(` or `RegExp`, outside comments;
 *   4. the paste reaches the reader.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const PASTE = "src/lib/admin-group-paste.ts";
const READER = "src/lib/hq-squad-reader.ts";
const PROMPT = "src/lib/hq-squad-reader-prompt.ts";
const RULES = "src/lib/admin-group-squad-rules.ts";
const PARSERS = ["src/lib/pasted-roster.ts", "src/lib/admin-group-name-list.ts"];

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

/** Every module a source reaches: static, re-export, `import()`, `require()`. */
function specifiersOf(src: string): string[] {
  const Q = `["']([^"']+)["']`;
  return [
    ...[...src.matchAll(new RegExp(`^\\s*import\\s+(?!type\\b)[^;]*?from\\s+${Q}`, "gm"))].map((m) => m[1]),
    ...[...src.matchAll(new RegExp(`^\\s*import\\s+${Q}`, "gm"))].map((m) => m[1]),
    ...[...src.matchAll(new RegExp(`^\\s*export\\s+(?!type\\b)[^;]*?from\\s+${Q}`, "gm"))].map((m) => m[1]),
    ...[...src.matchAll(new RegExp(`\\bimport\\(\\s*${Q}\\s*\\)`, "g"))].map((m) => m[1]),
    ...[...src.matchAll(new RegExp(`\\brequire\\(\\s*${Q}\\s*\\)`, "g"))].map((m) => m[1]),
  ];
}
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(cand)) return cand;
  return null;
}
const importsOf = (rel: string) =>
  specifiersOf(read(rel))
    .map((s) => resolveImport(path.join(ROOT, rel), s))
    .filter((x): x is string => !!x)
    .map((f) => path.relative(ROOT, f));

/** The code of a source, comments and string contents left out. */
export function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

/** The old readers, defined in any form. */
export const OLD_READER = /export\s+(?:async\s+function|function|const|let|var)\s+(readSquadPaste|readPlainList|nameLikeLine)\b|function\s+(readPlainList|nameLikeLine)\b/;
/** Text handling the paste path must not do. */
export const TEXT_PARSING = /\.(split|match|matchAll|test|replace|replaceAll|search)\s*\(|\bRegExp\s*\(/;

describe("a list pasted in HQ is read by the model, never by code", () => {
  it("no production file defines the old readers", () => {
    const offenders = prodFiles.filter((f) => OLD_READER.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("the HQ paste path imports no text parser", () => {
    for (const f of [PASTE, READER, PROMPT, RULES]) {
      expect(importsOf(f).filter((i) => PARSERS.includes(i)), f).toEqual([]);
    }
  });

  it("the paste, the reader and its prompt module split, match or test no text", () => {
    for (const f of [PASTE, READER, PROMPT]) {
      const hits = codeOf(read(f))
        .split("\n")
        .filter((l) => TEXT_PARSING.test(l));
      expect(hits, f).toEqual([]);
    }
  });

  it("the paste reaches the reader", () => {
    expect(importsOf(PASTE)).toContain(READER);
    expect(importsOf(READER)).toContain(PROMPT);
  });
});

describe("the guard itself catches every way back (2026-10-29)", () => {
  it("an old reader redefined, a split, a regex test, a RegExp, a dynamic import", () => {
    expect(OLD_READER.test("export function readSquadPaste(b: string) {}")).toBe(true);
    expect(OLD_READER.test("function readPlainList(body: string) {}")).toBe(true);
    expect(TEXT_PARSING.test(codeOf("const lines = body.split(/\\r?\\n/);"))).toBe(true);
    expect(TEXT_PARSING.test(codeOf("if (/^reserves/i.test(line)) {}"))).toBe(true);
    expect(TEXT_PARSING.test(codeOf("new RegExp(word)"))).toBe(true);
    expect(specifiersOf(`const P = await import('./pasted-roster');`)).toEqual(["./pasted-roster"]);
  });

  it("comments and strings are not code", () => {
    expect(TEXT_PARSING.test(codeOf("// body.split(x) was the old way"))).toBe(false);
    expect(TEXT_PARSING.test(codeOf('const s = "1. Ali\\n2. Burak.split(";'))).toBe(false);
  });
});
