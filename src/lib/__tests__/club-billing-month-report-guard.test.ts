/**
 * CLUB FEE BILLING, slice P1: the report script and the loader it uses are
 * READ ONLY. Kemal runs the script against production, so it must only ever
 * SELECT: no write method, no raw SQL, no transaction and no session SET
 * (a leaked SET on the production pooler broke prod writes on 2026-09-29).
 * And `ClubBillingMonth` has ONE writer, src/lib/club-billing-months.ts
 * (slice P2): no other file or script may write it (plan 10.1, source
 * guards).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "club-billing-month-report.ts");
const LOADER = path.join(ROOT, "src", "lib", "club-billing-month-loader.ts");

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const WRITE_OR_SESSION =
  /\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(|\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe|transaction|runCommandRaw)\b|\bSET\s+(LOCAL\s+|SESSION\s+)?[a-z_]+\s*(=|TO)\b|default_transaction_read_only|\bBEGIN\b/i;

describe("slice P1: the games-played report is read only", () => {
  for (const file of [SCRIPT, LOADER]) {
    const rel = path.relative(ROOT, file);
    it(`${rel}: no write, raw SQL, transaction or SET`, () => {
      const src = strip(readFileSync(file, "utf8"));
      expect(src.match(WRITE_OR_SESSION)?.[0] ?? null).toBeNull();
    });

    it(`${rel}: every Prisma model call is a find`, () => {
      const src = strip(readFileSync(file, "utf8"));
      const calls = [...src.matchAll(/\.(organisation|activity|match|billingEvent|clubBilling|attendance|clubBillingMonth)\.(\w+)\s*\(/g)].map(
        (m) => m[2],
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const name of calls) expect(name).toMatch(/^find(Unique|First|Many)$/);
    });
  }

  it("the guard pattern would catch a write and a SET (so it is not vacuous)", () => {
    expect("db.match.update({})").toMatch(WRITE_OR_SESSION);
    expect("await db.$executeRawUnsafe(`SET statement_timeout = 0`)").toMatch(WRITE_OR_SESSION);
    expect("SET default_transaction_read_only = on").toMatch(WRITE_OR_SESSION);
    expect("db.match.findMany({})").not.toMatch(WRITE_OR_SESSION);
  });
});

describe("slice P2: ClubBillingMonth has one writer (club-billing-months.ts)", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  const WRITE = /clubBillingMonth\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/;

  it("no source file or script but club-billing-months.ts calls a write on clubBillingMonth", () => {
    const writers = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))].filter((f) =>
      WRITE.test(strip(readFileSync(f, "utf8"))),
    );
    expect(writers.map((f) => path.relative(ROOT, f))).toEqual([path.join("src", "lib", "club-billing-months.ts")]);
  });

  it("no raw SQL names the table anywhere in src or scripts (a second writer by the back door)", () => {
    const raw = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))].filter((f) =>
      /"ClubBillingMonth"/.test(strip(readFileSync(f, "utf8"))),
    );
    expect(raw.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
