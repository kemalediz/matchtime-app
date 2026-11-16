/**
 * The privacy policy promises the /play visit breakdown is never linked to
 * sign-ups or profiles (review of #600, 2026-11-13; daily totals only since
 * 2026-11-16). This keeps it true in the code: one file reads or writes
 * "PoolVisitDaily" (`visits.ts`), only to add one to a total and to delete
 * old days, and no SQL anywhere joins it to another table. Nothing reads or
 * writes the per-visit "PoolVisitEvent" of 2026-11-13 any more.
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

/** The code without its comments, which may name the table to explain it. */
const withoutComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SOURCES = files(SRC).map((p) => ({ path: relative(ROOT, p), text: withoutComments(readFileSync(p, "utf8")) }));

describe("the visit breakdown is never linked to a person", () => {
  it("only visits.ts touches the table", () => {
    const touching = SOURCES.filter((f) => /\bpoolVisitDaily\b|"PoolVisitDaily"/.test(f.text)).map((f) => f.path);
    expect(touching).toEqual(["src/lib/pool/visits.ts"]);
  });

  it("and only to add one to a total, by one INSERT naming no other table, and to delete old days", () => {
    const visits = SOURCES.find((f) => f.path === "src/lib/pool/visits.ts")!.text;
    const calls = new Set([...visits.matchAll(/poolVisitDaily\.(\w+)/g)].map((m) => m[1]));
    expect([...calls].sort()).toEqual(["deleteMany"]);
    const statements = [...visits.matchAll(/\$executeRaw`([^`]*"PoolVisitDaily"[^`]*)`/g)].map((m) => m[1]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^INSERT INTO "PoolVisitDaily"/);
    const tables = new Set([...statements[0].matchAll(/"(Pool\w+)"/g)].map((m) => m[1]));
    expect([...tables]).toEqual(["PoolVisitDaily"]);
    expect(statements[0]).not.toMatch(/\b(FROM|JOIN|SELECT)\b/);
  });

  it("nothing touches the per-visit table of 2026-11-13", () => {
    const touching = SOURCES.filter((f) => /\bpoolVisitEvent\b|"PoolVisitEvent(Backfilled)?"/.test(f.text)).map((f) => f.path);
    expect(touching).toEqual([]);
  });
});
