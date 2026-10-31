/**
 * Quiet hours are OFF for a new club (Kemal, 2026-10-31). Existing clubs
 * keep what they have: only the column default and the create calls
 * change, no row is updated. The times keep 23:00 to 09:00, so a club
 * that switches quiet hours on later starts from sensible hours.
 *
 * Every place a club is born passes `newClubQuietHoursFields()` itself,
 * so a new club is off even on a database whose column default has not
 * been moved yet.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_QUIET_HOURS, NEW_CLUB_QUIET_HOURS_ENABLED, newClubQuietHoursFields } from "../message-hours";

const ROOT = join(__dirname, "..", "..", "..");

/** Every .ts/.tsx file under src, tests and generated code left out. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "generated" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("a new club's quiet hours", () => {
  it("are off, with the times kept at 23:00 to 09:00", () => {
    expect(NEW_CLUB_QUIET_HOURS_ENABLED).toBe(false);
    expect(newClubQuietHoursFields()).toEqual({ quietHoursEnabled: false });
    expect(DEFAULT_QUIET_HOURS.from).toBe("23:00");
    expect(DEFAULT_QUIET_HOURS.to).toBe("09:00");
  });

  it("the schema's column default is off too, and the times keep their defaults", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/quietHoursEnabled\s+Boolean\s+@default\(false\)/);
    expect(schema).toMatch(/quietHoursFrom\s+String\s+@default\("23:00"\)/);
    expect(schema).toMatch(/quietHoursTo\s+String\s+@default\("09:00"\)/);
  });

  it("the migration only moves the column default, and touches no row", () => {
    const dir = join(ROOT, "prisma/migrations/20261031120000_quiet_hours_default_off");
    const sql = readFileSync(join(dir, "migration.sql"), "utf8");
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .trim();
    expect(statements).toBe(`ALTER TABLE "Organisation" ALTER COLUMN "quietHoursEnabled" SET DEFAULT false;`);
    expect(statements).not.toMatch(/UPDATE|INSERT|DELETE/i);
  });

  it("source guard: every organisation.create in src passes newClubQuietHoursFields()", () => {
    const files = sources(join(ROOT, "src")).filter((f) => /organisation\.create\(/.test(readFileSync(f, "utf8")));
    const rel = files.map((f) => relative(ROOT, f)).sort();
    // The creation paths known on 2026-10-31; a new one must be added here.
    expect(rel).toEqual(["src/app/actions/onboarding.ts", "src/app/actions/org.ts", "src/lib/self-join-club.ts"]);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const creates = text.match(/organisation\.create\(/g)!.length;
      const spreads = text.match(/\.\.\.newClubQuietHoursFields\(\)/g)?.length ?? 0;
      expect(spreads, relative(ROOT, f)).toBe(creates);
    }
  });
});
