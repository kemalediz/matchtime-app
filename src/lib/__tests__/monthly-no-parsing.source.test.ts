/**
 * NO CODE READS A MONTHLY LIST (Kemal, 2026-10-29): "no string splits,
 * regex or code that inspects the text to work out what is going on".
 * Pasted monthly lists and month sign-ups are read by the monthly reader,
 * a model step (`monthly-reader.ts`). Pinned here, by reading the sources:
 *
 *   1. the old deterministic reader lives only in the test fixture
 *      (`fixtures/monthly-legacy.ts`), and no file under src/ outside the
 *      tests imports it, statically or dynamically;
 *   2. no production file defines the old readers again (the list, the
 *      sign-up words, and a month payment's "paid" and "PAID ALL");
 *   3. the admin-group route reaches the monthly reader only through its
 *      shared model door (`admin-group-understand.ts`), following dynamic
 *      imports too (the door test follows static ones).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const FIXTURE = "src/lib/__tests__/fixtures/monthly-legacy.ts";
const READER = "src/lib/monthly-reader.ts";
const DIGEST_READER = "src/lib/month-digest-reply.ts";
const DOOR = "src/lib/admin-group-understand.ts";

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

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(cand)) return cand;
  return null;
}

/** Every module a source reaches: `import ... from`, `export ... from`
 *  (not type-only), `import(...)` and `require(...)`, in either quote. */
export function specifiersOf(src: string): string[] {
  const Q = `["']([^"']+)["']`;
  return [
    ...[...src.matchAll(new RegExp(`^\\s*import\\s+(?!type\\b)[^;]*?from\\s+${Q}`, "gm"))].map((m) => m[1]),
    ...[...src.matchAll(new RegExp(`^\\s*import\\s+${Q}`, "gm"))].map((m) => m[1]),
    ...[...src.matchAll(new RegExp(`^\\s*export\\s+(?!type\\b)[^;]*?from\\s+${Q}`, "gm"))].map((m) => m[1]),
    ...[...src.matchAll(new RegExp(`\\bimport\\(\\s*${Q}\\s*\\)`, "g"))].map((m) => m[1]),
    ...[...src.matchAll(new RegExp(`\\brequire\\(\\s*${Q}\\s*\\)`, "g"))].map((m) => m[1]),
  ];
}

function importsOf(file: string): string[] {
  return specifiersOf(readFileSync(file, "utf8"))
    .map((s) => resolveImport(file, s))
    .filter((x): x is string => !!x);
}

/** The old readers, defined in any form. */
export const OLD_READER =
  /export\s+(?:async\s+function|function|const|let|var)\s+(parseMonthlyList|readMarks|readSignupMessage|isMonthLevelList|quotedSignupMonth|pasteResidual|signupPasteResidual|isMonthListHeader|readPaidMessage|readCollectorReply|monthOfWord|foldListText)\b/;

function reachable(entry: string, stop: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    const rel = path.relative(ROOT, f);
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (stop.includes(rel)) continue;
    for (const next of importsOf(f)) stack.push(next);
  }
  return seen;
}

describe("monthly lists are read by the model, never by code", () => {
  it("no production file imports the legacy reader fixture", () => {
    const offenders = prodFiles.filter((f) => importsOf(f).some((i) => path.relative(ROOT, i) === FIXTURE));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("no production file defines the old readers", () => {
    const offenders = prodFiles.filter((f) => OLD_READER.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("the admin-group route reaches the monthly reader only through its model door", () => {
    const seen = reachable(path.join(SRC, "app/api/whatsapp/admin-group/route.ts"), [DOOR]);
    expect(seen.has(DOOR)).toBe(true);
    expect(seen.has(READER)).toBe(false);
    expect(seen.has(DIGEST_READER)).toBe(false);
    // And the door does reach it (the HQ coming-month list).
    expect(reachable(path.join(ROOT, DOOR), []).has(READER)).toBe(true);
    expect(reachable(path.join(ROOT, DOOR), []).has(DIGEST_READER)).toBe(true);
  });
});

describe("the guard itself catches every way in (review of #465)", () => {
  const fx = "./__tests__/fixtures/monthly-legacy";
  it("single quotes, re-exports, require and import(), and an exported const", () => {
    expect(specifiersOf(`import { parseMonthlyList } from '${fx}';`)).toEqual([fx]);
    expect(specifiersOf(`export { parseMonthlyList } from "${fx}";`)).toEqual([fx]);
    expect(specifiersOf(`const L = require("${fx}");`)).toEqual([fx]);
    expect(specifiersOf(`const L = await import('${fx}');`)).toEqual([fx]);
    expect(specifiersOf(`import type { X } from "${fx}";`)).toEqual([]);
    expect(OLD_READER.test("export const parseMonthlyList = (b: string) => b.split('\\n');")).toBe(true);
    expect(OLD_READER.test("export async function readCollectorReply() {}")).toBe(true);
  });
});
