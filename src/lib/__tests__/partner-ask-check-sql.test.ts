/**
 * L5 (review of the partner-clubs stack): re-running the CHECK file must
 * never open a window with no one-open-ask unique index. The index is
 * created IF NOT EXISTS and never dropped, in the check file and in the
 * migration alike, and the check file runs as one transaction.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("the one-open-ask index is never dropped on a re-run", () => {
  for (const file of ["prisma/sql/partner-ask-check.sql", "prisma/migrations/20261016180000_partner_clubs/migration.sql"]) {
    it(file, () => {
      const sql = code(read(file));
      expect(sql).not.toMatch(/DROP INDEX[^;]*PartnerAsk_one_open_per_match_partner/);
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "PartnerAsk_one_open_per_match_partner"/);
    });
  }
  it("the check file is one transaction", () => {
    const sql = code(read("prisma/sql/partner-ask-check.sql"));
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
  });
});

describe("a guest is a PLAYER (review of #400, M1)", () => {
  const sql = readFileSync(join(__dirname, "..", "..", "..", "prisma", "sql", "partner-ask-check.sql"), "utf8");
  it("the CHECK binds new rows without failing on old ones", () => {
    expect(sql).toMatch(/ADD CONSTRAINT "Membership_guest_player_check"\s+CHECK \("guestMatchId" IS NULL OR "role" = 'PLAYER'\) NOT VALID;/);
  });
});
