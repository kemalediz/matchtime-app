/**
 * Partner discovery, slice P1: the migration and the CHECK file
 * (2026-10-22). Plan: MDs/partner-discovery-plan-2026-10-21.md, section 6.
 *
 *   - existing clubs read as discoverable: the column is added NOT NULL
 *     DEFAULT true, so Postgres fills every existing row with "on" as it is
 *     added (Kemal, 2026-10-22: switched on at once, like new clubs), and
 *     auto-accept DEFAULT false;
 *   - the CHECKs for "origin" and "endReason" carry exactly the values the
 *     rules know, in the migration and in the re-runnable CHECK file alike;
 *   - the migration is additive and one transaction.
 *
 * That the CHECKs really refuse a bad value is proven against Postgres in
 * e2e/api/venue-reminder.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARTNERSHIP_END_REASONS, PARTNERSHIP_ORIGINS } from "../club-partnership-rules";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const MIGRATION = "prisma/migrations/20261022100000_partner_discovery/migration.sql";
const CHECKS = "prisma/sql/partner-ask-check.sql";
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

describe("existing clubs read as discoverable", () => {
  it("the migration adds discoverable NOT NULL DEFAULT true, and auto-accept DEFAULT false", () => {
    const sql = code(read(MIGRATION));
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "discoverable" BOOLEAN NOT NULL DEFAULT true;/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "autoAcceptPartnerRequests" BOOLEAN NOT NULL DEFAULT false;/);
  });
  it("the schema agrees", () => {
    const schema = read("prisma/schema.prisma");
    expect(schema).toMatch(/discoverable\s+Boolean\s+@default\(true\)/);
    expect(schema).toMatch(/autoAcceptPartnerRequests\s+Boolean\s+@default\(false\)/);
  });
});

describe("the CHECKs", () => {
  for (const file of [MIGRATION, CHECKS]) {
    it(`${file} checks origin and endReason with the rules' values`, () => {
      const sql = code(read(file));
      expect(sql).toContain(`CHECK ("origin" IN (${list(PARTNERSHIP_ORIGINS)}))`);
      expect(sql).toContain(`CHECK ("endReason" IS NULL OR "endReason" IN (${list(PARTNERSHIP_END_REASONS)}))`);
      expect(sql).toContain(`CHECK ("blockerOrgId" <> "blockedOrgId")`);
    });
  }
});

describe("the migration is additive and whole", () => {
  it("drops no column, table or index, and runs as one transaction", () => {
    const sql = code(read(MIGRATION));
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE|INDEX)/i);
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
    expect(sql).not.toMatch(/^\s*SET\s+(?!LOCAL)/im);
  });
  it("touches nothing of PartnerAsk (another slice owns it)", () => {
    expect(code(read(MIGRATION))).not.toMatch(/"PartnerAsk"/);
  });
});
