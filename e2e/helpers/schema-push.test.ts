/**
 * The e2e schema push may discard data, and only ever in the isolated
 * local test database.
 *
 * `.e2e/pgdata` persists between runs, so a checkout whose test database
 * was built before a column left the schema (PR #411 retired seven User
 * columns on 2026-10-24) made `prisma db push` stop with "Use the
 * --accept-data-loss flag" on every later run. The fix passes that flag,
 * so this file proves the flag can only ever reach a loopback URL.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { schemaPushArgs } from "./schema-push";

const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54374/matchtime_test";

describe("schemaPushArgs", () => {
  it("accepts data loss for the embedded local test database", () => {
    expect(schemaPushArgs(LOCAL)).toEqual(["prisma", "db", "push", "--accept-data-loss"]);
    expect(schemaPushArgs("postgresql://postgres:postgres@localhost:5432/matchtime_test")).toContain(
      "--accept-data-loss",
    );
  });

  it.each([
    ["no URL at all", undefined],
    ["an empty URL", ""],
    ["a Supabase pooler", "postgresql://u:p@aws-0-eu-west-2.pooler.supabase.com:6543/postgres"],
    ["a Supabase direct host", "postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres"],
    ["any remote host", "postgresql://u:p@10.0.0.5:5432/matchtime_test"],
    ["a loopback URL naming a hosted provider", "postgresql://u:p@127.0.0.1:5432/neon"],
    ["not a URL", "not a url"],
  ])("refuses %s, so the flag can never reach it", (_label, url) => {
    expect(() => schemaPushArgs(url)).toThrow(/e2e:/);
  });
});

describe("--accept-data-loss appears nowhere else in the harness", () => {
  it("only schema-push.ts may pass the flag", () => {
    const root = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|js|mjs|cjs|json)$/.test(name)) continue;
        if (p.endsWith(path.join("helpers", "schema-push.ts"))) continue;
        if (p.endsWith(path.join("helpers", "schema-push.test.ts"))) continue;
        // The flag as an argument: a quoted "--accept-data-loss" literal.
        // Prose about it (comments, log lines) is fine.
        if (/["'`]--accept-data-loss["'`]/.test(readFileSync(p, "utf8"))) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("run.ts builds its push through schemaPushArgs", () => {
    const run = readFileSync(path.resolve(__dirname, "..", "run.ts"), "utf8");
    expect(run).toMatch(/schemaPushArgs\(E2E_DB_URL\)/);
    expect(run).not.toMatch(/\["prisma",\s*"db",\s*"push"/);
  });
});
