/**
 * The privacy policy promises the /play visit log is never linked to
 * sign-ups or profiles (review of #600, 2026-11-13). This keeps it true in
 * the code: one file reads or writes "PoolVisitEvent" (`visits.ts`), only
 * to add a row, count a code's hour (the volume cap) and delete old rows,
 * and no SQL anywhere joins it to another table.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const SRC = join(ROOT, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "generated" || name === "__tests__" ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const SOURCES = files(SRC).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));

describe("the visit log is never linked to a person", () => {
  it("only visits.ts touches the table", () => {
    const touching = SOURCES.filter((f) => /\bpoolVisitEvent\b|(FROM|JOIN|INTO|UPDATE)\s+"PoolVisitEvent"/.test(f.text)).map((f) => f.path);
    expect(touching).toEqual(["src/lib/pool/visits.ts"]);
  });

  it("and only to add a row, count a code's hour and delete old rows", () => {
    const visits = SOURCES.find((f) => f.path === "src/lib/pool/visits.ts")!.text;
    const calls = new Set([...visits.matchAll(/poolVisitEvent\.(\w+)/g)].map((m) => m[1]));
    expect([...calls].sort()).toEqual(["count", "create", "deleteMany"]);
    // No raw SQL on the table (a join would hide there).
    expect(visits).not.toMatch(/(FROM|JOIN|INTO|UPDATE)\s+"PoolVisitEvent"/);
  });
});
