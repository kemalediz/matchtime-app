/**
 * Slice L1's migration and its re-runnable CHECK file (2026-10-24).
 *
 *   - every enum-in-a-string CHECK carries exactly the values `../vocab.ts`
 *     knows, and the sport and format CHECK exactly the catalogue in
 *     `../sports.ts`, in the migration and in the CHECK file alike (one
 *     source of truth: the TypeScript; the SQL is pinned to it here);
 *   - every pool switch defaults OFF (decision log #2), in the schema and
 *     in the migration;
 *   - the migration is additive, idempotent and one transaction, with no
 *     session-level SET (the 2026-09-29 pooler incident);
 *   - a pool guest (no home club) is allowed by the guest CHECK, which has
 *     ONE definition, shared with the partner-clubs CHECK file.
 *
 * That the CHECKs really refuse a bad row is proven against Postgres in
 * e2e/api/pool-schema.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POOL_SPORTS, POOL_SPORT_KEYS, OTHER_SPORT, SPORT_LEVELS } from "../sports";
import { POOL_CONFIRM_CODE_ALPHABET, POOL_CONFIRM_CODE_LENGTH, POOL_TRAVEL_MILES, POSTCODE_DISTRICT_RE } from "../rules";
import * as V from "../vocab";

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
const MIGRATION = "prisma/migrations/20261024200000_local_player_pool/migration.sql";
const CHECKS = "prisma/sql/pool-check.sql";
const PARTNER_CHECKS = "prisma/sql/partner-ask-check.sql";
const list = (xs: readonly (string | number)[]) => xs.map((x) => (typeof x === "number" ? String(x) : `'${x}'`)).join(", ");
const inList = (col: string, xs: readonly (string | number)[]) => `CHECK ("${col}" IN (${list(xs)}))`;
const nullOrIn = (col: string, xs: readonly (string | number)[]) => `CHECK ("${col}" IS NULL OR "${col}" IN (${list(xs)}))`;

/** The CHECK each enum column must carry, in both files. */
const ENUM_CHECKS: string[] = [
  inList("status", V.POOL_PROFILE_STATUSES),
  nullOrIn("pausedReason", V.POOL_PAUSE_REASONS),
  nullOrIn("consentChannel", V.POOL_CONSENT_CHANNELS),
  nullOrIn("source", V.POOL_PROFILE_SOURCES),
  inList("maxMiles", POOL_TRAVEL_MILES),
  inList("sport", [...POOL_SPORT_KEYS, OTHER_SPORT]),
  nullOrIn("level", SPORT_LEVELS),
  inList("status", V.POOL_ASK_STATUSES),
  inList("via", V.POOL_ASK_VIA),
  nullOrIn("outcome", V.POOL_OFFER_OUTCOMES),
  nullOrIn("repliedVia", V.POOL_REPLY_VIA),
  inList("wave", V.POOL_OFFER_WAVES),
  inList("by", V.POOL_BLOCK_BY),
  inList("source", V.POOL_CAMPAIGN_SOURCES),
  inList("source", V.GUEST_SOURCES),
  inList("result", V.GUEST_RESULTS),
  inList("status", V.CLUB_INVITATION_STATUSES),
  inList("origin", V.CLUB_INVITATION_ORIGINS),
  nullOrIn("declinedBy", V.INVITATION_DECLINED_BY),
  nullOrIn("playStyle", V.PLAY_STYLES),
];

/** The formats CHECK, built from the catalogue. */
function formatsCheck(): string {
  const withFormats = POOL_SPORTS.filter((s) => s.formats.length > 0);
  const arms = withFormats.map((s) => `("sport" = '${s.key}' AND "formats" <@ ARRAY[${s.formats.join(", ")}]::INTEGER[])`);
  arms.push(`("sport" NOT IN (${list(withFormats.map((s) => s.key))}) AND cardinality("formats") = 0)`);
  return `CHECK (${arms.join(" OR ")})`;
}

const GUEST_CHECK =
  `CHECK (("guestVia" IS NULL AND ("guestFromOrgId" IS NULL) = ("guestMatchId" IS NULL))` +
  ` OR ("guestVia" IS NOT NULL AND "guestVia" = 'partner' AND "guestFromOrgId" IS NOT NULL AND "guestMatchId" IS NOT NULL)` +
  ` OR ("guestVia" IS NOT NULL AND "guestVia" = 'pool' AND "guestFromOrgId" IS NULL AND "guestMatchId" IS NOT NULL))`;

describe("the CHECKs carry the TypeScript's values", () => {
  for (const file of [MIGRATION, CHECKS]) {
    it(`${file}: every enum column`, () => {
      const sql = code(read(file));
      for (const c of ENUM_CHECKS) expect(sql, c).toContain(c);
    });
    it(`${file}: the postcode district`, () => {
      expect(code(read(file))).toContain(`"areaDistrict" ~ '${POSTCODE_DISTRICT_RE.source}'`);
    });
    it(`${file}: the formats per sport`, () => {
      expect(code(read(file))).toContain(formatsCheck());
    });
  }

  it("the vocab lists name the guest marks the CHECK knows", () => {
    expect([...V.MEMBERSHIP_GUEST_VIA].sort()).toEqual(["partner", "pool"]);
  });
});

describe("one definition of the guest CHECK", () => {
  // Each arm that compares "guestVia" first says it is NOT NULL: with
  // "guestVia" NULL a bare comparison is NULL, the OR comes out NULL, and
  // Postgres lets a NULL CHECK pass. That let a match-only guest row with no
  // "guestVia" through (found by e2e/api/pool-schema.spec.ts, 2026-10-24).
  it("the partner-clubs CHECK file carries the pool-aware guest CHECK", () => {
    expect(code(read(PARTNER_CHECKS))).toContain(GUEST_CHECK);
    expect(code(read(PARTNER_CHECKS))).not.toContain(`CHECK (("guestFromOrgId" IS NULL) = ("guestMatchId" IS NULL));`);
  });
  it("the migration replaces it with the same text", () => {
    expect(code(read(MIGRATION))).toContain(GUEST_CHECK);
  });
  it("the pool CHECK file does not redefine it (a second definition could undo the first)", () => {
    expect(code(read(CHECKS))).not.toMatch(/Membership_guest_check/);
  });
});

describe("every pool switch is OFF by default", () => {
  it("the schema", () => {
    const schema = read("prisma/schema.prisma");
    expect(schema).toMatch(/featurePlayerPool\s+Boolean\s+@default\(false\)/);
    expect(schema).toMatch(/poolAutoAsk\s+Boolean\s+@default\(false\)/);
  });
  it("the migration", () => {
    const sql = code(read(MIGRATION));
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "featurePlayerPool" BOOLEAN NOT NULL DEFAULT false;/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "poolAutoAsk" BOOLEAN NOT NULL DEFAULT false;/);
  });
});

describe("the migration is additive and whole", () => {
  const sql = code(read(MIGRATION));
  it("drops no column or table, and drops only constraints it re-adds", () => {
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
    const dropped = [...sql.matchAll(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g)].map((m) => m[1]);
    const added = new Set([...sql.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map((m) => m[1]));
    expect(dropped.length).toBeGreaterThan(10);
    for (const name of dropped) expect(added.has(name), name).toBe(true);
  });
  it("creates every table and index only if missing", () => {
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
  });
  it("is one transaction with a lock timeout and no session-level SET", () => {
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*SET LOCAL lock_timeout = '5s';/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
    expect(sql).not.toMatch(/^\s*SET\s+(?!LOCAL)/im);
  });
  it("changes no existing row", () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/im);
  });
  it("the CHECK file is one transaction", () => {
    const checks = code(read(CHECKS));
    expect(checks).toMatch(/^\s*BEGIN;/m);
    expect(checks).toMatch(/^\s*COMMIT;\s*$/m);
  });
  it("the e2e run arms the pool CHECK file after the partner one", () => {
    const run = read("e2e/run.ts");
    const partner = run.indexOf('"partner-ask-check.sql"');
    const pool = run.indexOf('"pool-check.sql"');
    expect(partner).toBeGreaterThan(0);
    expect(pool).toBeGreaterThan(partner);
  });
});

describe("slice L2's migration (codes, the sign-up IP, attempts, the consent record)", () => {
  const L2 = "prisma/migrations/20261025090000_pool_signup_confirm/migration.sql";
  const sql = code(read(L2));
  const both = [L2, CHECKS];
  const CODE_CHECK = `"confirmCode" ~ '^[${POOL_CONFIRM_CODE_ALPHABET}]{${POOL_CONFIRM_CODE_LENGTH}}$'`;
  const IP_CHECK = `CHECK ("signupIp" IS NULL OR "status" = 'pending-verify')`;
  // L2's migration carries the CHECK as L2 shipped it; the CHECK file and
  // L5a's migration carry it with the offer page's "offer-verify" kind too.
  const ATTEMPT_CHECK_L2 =
    `CHECK (("kind" = 'confirm' AND "result" IN (${list(V.POOL_CONFIRM_ATTEMPT_RESULTS)}))` +
    ` OR ("kind" = 'signup' AND "result" IN (${list(V.POOL_SIGNUP_ATTEMPT_RESULTS)})))`;
  const ATTEMPT_CHECK =
    `CHECK (("kind" = 'confirm' AND "result" IN (${list(V.POOL_CONFIRM_ATTEMPT_RESULTS)}))` +
    ` OR ("kind" = 'signup' AND "result" IN (${list(V.POOL_SIGNUP_ATTEMPT_RESULTS)}))` +
    ` OR ("kind" = 'offer-verify' AND "result" IN (${list(V.POOL_OFFER_VERIFY_ATTEMPT_RESULTS)})))`;
  const L5A = "prisma/migrations/20261025140000_pool_offer_review/migration.sql";
  const ACTION_CHECK = inList("action", V.POOL_CONSENT_ACTIONS);
  const CHANNEL_CHECK = inList("channel", V.POOL_CONSENT_CHANNELS);

  it("the confirm code CHECK is the pool's own length, in both migrations and the CHECK file", () => {
    for (const f of [...both, MIGRATION]) expect(code(read(f)), f).toContain(CODE_CHECK);
    expect(code(read(MIGRATION))).not.toContain("]{4}$'");
    expect(POOL_CONFIRM_CODE_LENGTH).toBe(5);
  });
  it("carries the same CHECKs as the CHECK file, from the vocab", () => {
    for (const f of both) {
      for (const c of [IP_CHECK, ACTION_CHECK, CHANNEL_CHECK]) expect(code(read(f)), `${f}: ${c}`).toContain(c);
      expect(code(read(f)), f).toContain(`CHECK ("action" <> 'consent' OR "version" IS NOT NULL)`);
    }
    expect(code(read(L2))).toContain(ATTEMPT_CHECK_L2);
    for (const f of [CHECKS, L5A]) expect(code(read(f)), `${f}: ${ATTEMPT_CHECK}`).toContain(ATTEMPT_CHECK);
    expect(V.POOL_ATTEMPT_KINDS).toEqual(["confirm", "signup", "offer-verify"]);
  });
  it("the consent record has no foreign key: it outlives the profile and the User (policy: 6 years)", () => {
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS "PoolConsentRecord"'));
    expect(table.slice(0, table.indexOf(");"))).not.toMatch(/REFERENCES/);
    expect(sql).not.toMatch(/"PoolConsentRecord"[^;]*FOREIGN KEY/);
  });
  it("is additive, idempotent and one transaction with no session-level SET", () => {
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
    const dropped = [...sql.matchAll(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g)].map((m) => m[1]);
    const added = new Set([...sql.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map((m) => m[1]));
    for (const name of dropped) expect(added.has(name), name).toBe(true);
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*SET LOCAL lock_timeout = '5s';/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
    expect(sql).not.toMatch(/^\s*SET\s+(?!LOCAL)/im);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/im);
  });
});
