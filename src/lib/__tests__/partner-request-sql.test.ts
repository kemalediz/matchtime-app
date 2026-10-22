/**
 * Partner requests, slice P3: the per-ask default (2026-10-22).
 * "Post without asking" is the default for pairings made by a request
 * (Kemal, 2026-10-22). The column default changes for NEW rows only: the
 * migration changes the DEFAULT and never touches a row.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUEST_DEFAULT_APPROVAL } from "../club-partnership-rules";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const MIGRATION = "prisma/migrations/20261022120000_partner_request_default_approval/migration.sql";

describe("the per-ask default for new pairings", () => {
  it("is 'standing' in the rules and the schema", () => {
    expect(REQUEST_DEFAULT_APPROVAL).toBe("standing");
    expect(read("prisma/schema.prisma")).toMatch(/partnerApproval\s+String\s+@default\("standing"\)/);
  });
  it("the migration changes only the column default, in one transaction, and no existing row", () => {
    const sql = code(read(MIGRATION));
    expect(sql).toContain(`ALTER TABLE "ClubPartnership" ALTER COLUMN "partnerApproval" SET DEFAULT 'standing';`);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
    expect(sql).not.toMatch(/^\s*SET\s+(?!LOCAL)/im);
  });
});
