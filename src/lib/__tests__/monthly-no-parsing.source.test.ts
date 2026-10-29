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

/** Every import of a file, static (not type-only) and dynamic. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs = [
    ...[...src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]),
    ...[...src.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]),
  ];
  return specs.map((s) => resolveImport(file, s)).filter((x): x is string => !!x);
}

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
    const old = /export (?:async )?function (parseMonthlyList|readMarks|readSignupMessage|isMonthLevelList|quotedSignupMonth|pasteResidual|signupPasteResidual|isMonthListHeader|readPaidMessage|readCollectorReply|monthOfWord)\b/;
    const offenders = prodFiles.filter((f) => old.test(readFileSync(f, "utf8")));
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
