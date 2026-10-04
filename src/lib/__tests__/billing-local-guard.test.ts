/**
 * The local Stripe test helper (scripts/billing-local-test.ts, runbook in
 * MDs/club-fee-billing-plan-2026-10-01.md section 16) writes to a database
 * and talks to Stripe. Its guard must refuse anything that is not a local
 * database and a Stripe TEST key, whatever else the environment holds
 * (the repo's .env points at production).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { londonRow, localBillingTestRefusal, parsePgUtcTimestamp } from "../billing-local-guard";

const OK = {
  DATABASE_URL: "postgresql://localhost:5432/matchtime_billing",
  DIRECT_URL: "postgresql://localhost:5432/matchtime_billing",
  STRIPE_SECRET_KEY: "sk_test_abc",
  NEXTAUTH_URL: "http://localhost:3000",
};

describe("localBillingTestRefusal", () => {
  it("passes a local database, a test key and a localhost app", () => {
    expect(localBillingTestRefusal(OK)).toBeNull();
    expect(localBillingTestRefusal({ ...OK, DATABASE_URL: "postgresql://kemal@127.0.0.1:5432/x", DIRECT_URL: "postgresql://127.0.0.1/x" })).toBeNull();
  });

  it("refuses any database that is not on this Mac", () => {
    expect(localBillingTestRefusal({ ...OK, DATABASE_URL: "postgresql://u:p@aws-0-eu-west-2.pooler.supabase.com:6543/postgres" })).toMatch(/DATABASE_URL/);
    expect(localBillingTestRefusal({ ...OK, DIRECT_URL: "postgresql://u:p@db.abc.supabase.co:5432/postgres" })).toMatch(/DIRECT_URL/);
    expect(localBillingTestRefusal({ ...OK, DATABASE_URL: "postgresql://localhost.evil.com/x" })).toMatch(/DATABASE_URL/);
    expect(localBillingTestRefusal({ ...OK, DATABASE_URL: undefined })).toMatch(/DATABASE_URL/);
  });

  it("refuses a live or missing Stripe key", () => {
    expect(localBillingTestRefusal({ ...OK, STRIPE_SECRET_KEY: "sk_live_abc" })).toMatch(/sk_test_/);
    expect(localBillingTestRefusal({ ...OK, STRIPE_SECRET_KEY: "rk_live_abc" })).toMatch(/sk_test_/);
    expect(localBillingTestRefusal({ ...OK, STRIPE_SECRET_KEY: undefined })).toMatch(/sk_test_/);
  });

  it("refuses links that would point at the real site", () => {
    expect(localBillingTestRefusal({ ...OK, NEXTAUTH_URL: "https://matchtime.ai" })).toMatch(/NEXTAUTH_URL/);
    expect(localBillingTestRefusal({ ...OK, NEXTAUTH_URL: undefined })).toMatch(/NEXTAUTH_URL/);
  });

  it("the script checks the guard before it does anything", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../scripts/billing-local-test.ts"), "utf8");
    const guard = src.indexOf("localBillingTestRefusal(process.env)");
    expect(guard).toBeGreaterThan(-1);
    for (const first of ["new PrismaClient(", "new Pool(", "execFileSync(", "spawnSync("]) {
      const at = src.indexOf(first);
      if (at !== -1) expect(at, first).toBeGreaterThan(guard);
    }
  });
});

// Test mode, 2026-10-05: `status` printed BST times an hour off. The
// columns are TIMESTAMP(3) WITHOUT TIME ZONE holding UTC, and node-pg's
// default parser reads them as the Mac's LOCAL time (Europe/London, BST).
describe("the helper's time display (status printed BST times an hour off)", () => {
  it("reads a TIMESTAMP WITHOUT TIME ZONE as the UTC it holds, whatever the machine's zone", () => {
    expect(parsePgUtcTimestamp("2026-10-05 09:00:00.123").toISOString()).toBe("2026-10-05T09:00:00.123Z");
    expect(parsePgUtcTimestamp("2026-12-01 00:00:00").toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("shows every date of a row in London time, labelled, and leaves other values alone", () => {
    expect(
      londonRow({ trialEndsAt: new Date("2026-09-30T23:00:00Z"), graceEndsAt: null, cardLast4: "4242", n: 3 }),
    ).toEqual({ trialEndsAt: "2026-10-01 00:00 London", graceEndsAt: null, cardLast4: "4242", n: 3 });
    expect(londonRow({ at: new Date("2026-12-01T10:30:00Z") })).toEqual({ at: "2026-12-01 10:30 London" });
  });
});
