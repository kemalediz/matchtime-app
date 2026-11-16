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
import { POOL_FUNNEL_STEPS } from "../visit-rules";
import * as L from "../visit-log-rules";

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

const SOURCE_CHECK = nullOrIn("source", V.POOL_PROFILE_SOURCES);
const CAMPAIGN_SOURCE_CHECK = inList("source", V.POOL_CAMPAIGN_SOURCES);
const FRIEND_MIGRATION = "prisma/migrations/20261101090000_friend_link/migration.sql";

describe("the friend link migration (2026-10-31)", () => {
  const sql = code(read(FRIEND_MIGRATION));
  it("carries the current profile source list", () => expect(sql).toContain(SOURCE_CHECK));
  it("is one transaction with no session-level SET", () => {
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/COMMIT;\s*$/);
    expect(sql.replace(/SET LOCAL/g, "")).not.toMatch(/\bSET\s+\w+\s*=/i);
  });
  it("is additive: no DROP TABLE, no DROP COLUMN, no UPDATE, no DELETE", () => {
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|\bUPDATE\s+"|DELETE FROM/i);
  });
  it("the CHECK file carries the same friend CHECKs", () => {
    const checks = code(read(CHECKS));
    for (const name of ["GuestPlace_friend_check", "FriendLink_used_check"]) expect(checks).toContain(name);
  });
});

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
      // The profile source list grew after L1 (the friend link, 2026-10-31):
      // the L1 migration carries the list as it was then, and the friend
      // link migration the current one (pinned below).
      // So did the campaign sources (Facebook and Nextdoor, 2026-11-03),
      // pinned by the campaign visits migration below.
      const checks = file === MIGRATION ? ENUM_CHECKS.filter((c) => c !== SOURCE_CHECK && c !== CAMPAIGN_SOURCE_CHECK) : ENUM_CHECKS;
      for (const c of checks) expect(sql, c).toContain(c);
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
    // `poolAutoAsk` left the model on 2026-11-08 (nothing asks by itself);
    // its column is dropped by 20261108120000_drop_partner_ask_settings.
    expect(schema).not.toMatch(/^\s*poolAutoAsk\s/m);
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

describe("slice L7's migration (no-shows, reviews, blocks kept after deletion, reports)", () => {
  const L7 = "prisma/migrations/20261026090000_pool_no_shows/migration.sql";
  const sql = code(read(L7));
  const reasons = list(V.POOL_MATCHTIME_PAUSE_REASONS);
  const PAUSED =
    `CHECK ((("pausedReason" IS NULL) = ("pausedAt" IS NULL)) AND ("status" <> 'paused' OR "pausedReason" IS NOT NULL)` +
    `\n    AND ("pausedReason" IS NULL OR "status" = 'paused' OR ("status" = 'stopped' AND "pausedReason" IN (${reasons}))))`;
  const REVIEW = `CHECK ("reviewRequestedAt" IS NULL OR "pausedReason" IN (${reasons}))`;
  const BY = inList("by", V.POOL_REPORT_BY);

  it("a MatchTime pause may stay on a stopped profile, in L1, L7 and the CHECK file alike (re-runnable in any order)", () => {
    for (const f of [MIGRATION, L7, CHECKS]) expect(code(read(f)), f).toContain(PAUSED);
    expect(code(read(MIGRATION))).not.toContain(`CHECK (("status" = 'paused') = ("pausedReason" IS NOT NULL AND "pausedAt" IS NOT NULL))`);
  });
  it("carries the same review and report CHECKs as the CHECK file, from the vocab", () => {
    for (const f of [L7, CHECKS]) for (const c of [REVIEW, BY, `CHECK (length("text") BETWEEN 3 AND 1000)`]) expect(code(read(f)), `${f}: ${c}`).toContain(c);
  });
  it("the report keeps no foreign key on the user: it outlives the profile (decision L0.3)", () => {
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS "PoolReport"'));
    expect(table.slice(0, table.indexOf(");"))).not.toMatch(/REFERENCES/);
    expect(sql).not.toMatch(/"PoolReport_userId_fkey"/);
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

describe("the campaign visits migration (2026-11-03)", () => {
  const VISITS = "prisma/migrations/20261104120000_pool_campaign_visits/migration.sql";
  const sql = code(read(VISITS));
  const VISIT_CODE_CHECK = `CHECK ("code" IN ('_direct', '_referral') OR ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("code") <= 32))`;

  it("carries the current campaign source list, as the CHECK file does", () => {
    for (const f of [VISITS, CHECKS]) expect(code(read(f)), f).toContain(CAMPAIGN_SOURCE_CHECK);
  });
  it("the visit row's CHECKs: a campaign code or a reserved bucket, and a count that is never negative", () => {
    for (const f of [VISITS, CHECKS]) {
      expect(code(read(f)), f).toContain(VISIT_CODE_CHECK);
      expect(code(read(f)), f).toContain(`CHECK ("count" >= 0)`);
    }
  });
  it("keeps nothing about a person: the table is the bucket, the day and the count", () => {
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS "PoolCampaignVisit"'));
    const cols = table.slice(0, table.indexOf(");"));
    expect(cols).toMatch(/"code" TEXT NOT NULL/);
    expect(cols).toMatch(/"day" DATE NOT NULL/);
    expect(cols).toMatch(/"count" INTEGER NOT NULL DEFAULT 0/);
    expect(cols).toMatch(/PRIMARY KEY \("code", "day"\)/);
    expect(cols).not.toMatch(/ip|agent|user/i);
  });
  it("is additive, idempotent and one transaction with no session-level SET", () => {
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
    const dropped = [...sql.matchAll(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g)].map((m) => m[1]);
    const added = new Set([...sql.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map((m) => m[1]));
    for (const name of dropped) expect(added.has(name), name).toBe(true);
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*SET LOCAL lock_timeout = '5s';/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
    expect(sql).not.toMatch(/^\s*SET\s+(?!LOCAL)/im);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/im);
  });
  it("the schema has the model (keyed per step too since the funnel steps migration below)", () => {
    expect(read("prisma/schema.prisma")).toMatch(/model PoolCampaignVisit \{[^}]*@@id\(\[code, day, step\]\)/);
  });
});

describe("the funnel steps migration (2026-11-04)", () => {
  const STEPS = "prisma/migrations/20261104180000_pool_funnel_steps/migration.sql";
  const sql = code(read(STEPS));
  const STEP_CHECK = inList("step", POOL_FUNNEL_STEPS);

  it("adds the step column, every existing row an opened visit", () => {
    expect(sql).toContain(`ALTER TABLE "PoolCampaignVisit" ADD COLUMN IF NOT EXISTS "step" TEXT NOT NULL DEFAULT 'opened';`);
  });
  it("the step CHECK carries exactly the four steps, in the migration and the CHECK file alike", () => {
    expect(STEP_CHECK).toBe(`CHECK ("step" IN ('opened', 'started', 'sent', 'confirmed'))`);
    for (const f of [STEPS, CHECKS]) expect(code(read(f)), f).toContain(STEP_CHECK);
  });
  it("one row per code, day and step", () => {
    expect(sql).toContain(`ALTER TABLE "PoolCampaignVisit" ADD CONSTRAINT "PoolCampaignVisit_pkey" PRIMARY KEY ("code", "day", "step");`);
  });
  it("keeps nothing about a person: no column but the step is added", () => {
    expect([...sql.matchAll(/ADD COLUMN IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1])).toEqual(["step"]);
  });
  it("is additive, idempotent and one transaction with no session-level SET and no data written", () => {
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
    const dropped = [...sql.matchAll(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g)].map((m) => m[1]);
    const added = new Set([...sql.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map((m) => m[1]));
    for (const name of dropped) expect(added.has(name), name).toBe(true);
    expect(sql).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*SET LOCAL lock_timeout = '5s';/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
    expect(sql).not.toMatch(/^\s*SET\s+(?!LOCAL)/im);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/im);
  });
  it("the schema has the step, defaulting to opened", () => {
    expect(read("prisma/schema.prisma")).toMatch(/model PoolCampaignVisit \{[^}]*step\s+String\s+@default\("opened"\)/);
  });
});

const additiveOneTransaction = (sql: string) => {
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
};

describe("the per-visit log migration of 2026-11-13, now history", () => {
  const EVENTS = "prisma/migrations/20261113120000_pool_visit_events/migration.sql";
  it("is left as it was applied: the file 20261116120300 drops its table", () => {
    const sql = code(read(EVENTS));
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "PoolVisitEvent"');
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
  });
  it("the schema no longer has the model, and the CHECK file no longer names its table", () => {
    expect(read("prisma/schema.prisma")).not.toMatch(/model PoolVisitEvent\b/);
    expect(code(read(CHECKS))).not.toContain('"PoolVisitEvent"');
  });
});

describe("the daily breakdown migration (2026-11-16): daily totals of opens only, kept 90 days", () => {
  const DAILY = "prisma/migrations/20261116120000_pool_visit_daily/migration.sql";
  const sql = code(read(DAILY));
  const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS "PoolVisitDaily"'));
  const cols = table.slice(0, table.indexOf(");"));
  const KEY = ["code", "day", "inApp", "scanner"];

  it("holds the bucket, the London day, the in-app browser, the scanner flag and a count, and nothing else", () => {
    const names = [...cols.matchAll(/^\s*"([^"]+)" [A-Z]/gm)].map((m) => m[1]);
    expect(names).toEqual([...KEY, "count"]);
    expect(cols).toMatch(/"day" DATE NOT NULL/);
    expect(cols).toContain(`PRIMARY KEY (${KEY.map((k) => `"${k}"`).join(", ")})`);
  });
  it("keeps nothing per visit or about a person: no hour, time on screen, address, user agent, friend's code, user id or cookie", () => {
    expect(cols).not.toMatch(/"at"|hour|visible|TIMESTAMP|\bip\b|address|agent|"ua"|userId|"ref"|hasRef|referralCode|cookie|session|phone|name"|"id"/i);
    // Review of #607: a browser family or device class could single out the
    // one person who signed up that day (13 November, fb2: mobile Safari).
    expect(cols).not.toMatch(/browser|device/i);
    // Round 2: what opened the page tells a computer from a phone (a wheel or
    // key comes first only from a computer), so it is not kept; nor the step,
    // since only opens are.
    expect(cols).not.toMatch(/trigger|openedBy|"step"/i);
  });
  it("each category is one of its values, pinned to the TypeScript, in the migration and the CHECK file alike", () => {
    const checks = [
      inList("inApp", L.POOL_IN_APPS),
      `CHECK ("count" >= 0)`,
      `CHECK ("code" IN ('_direct', '_referral') OR ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("code") <= 32))`,
    ];
    for (const f of [DAILY, CHECKS]) for (const c of checks) expect(code(read(f)), `${f}: ${c}`).toContain(c);
    for (const f of [DAILY, CHECKS]) expect(code(read(f)), f).not.toMatch(/PoolVisitDaily_(step|trigger|started_trigger|browser|device)_check/);
  });
  it("its header claims no more than is true: at very low traffic a day's total can still coincide with a single sign-up", () => {
    expect(read(DAILY).replace(/\n--\s*/g, " ")).toMatch(/at very low traffic a day's total can still coincide with a single sign-up/i);
  });
  it("is indexed by day, for the daily deletion", () => {
    expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "PoolVisitDaily_day_idx" ON "PoolVisitDaily"("day");`);
  });
  it("states its retention, exactly 90 days today included, and its place in the order of four", () => {
    expect(read(DAILY)).toMatch(/RETENTION: 90 DAYS/);
    expect(read(DAILY).replace(/\n--\s*/g, " ")).toMatch(/Exactly 90 London days are kept, today included: on 13 November the oldest day kept is 16 August/);
    expect(read(DAILY)).toMatch(/BEFORE the deploy[\s\S]*BEFORE the deploy[\s\S]*AFTER the deploy[\s\S]*LATER/);
  });
  it("is additive, idempotent and one transaction with no session-level SET and no data written", () => {
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/im);
    additiveOneTransaction(sql);
  });
  it("the schema has the model, keyed by every category and indexed by day", () => {
    const schema = read("prisma/schema.prisma");
    expect(schema).toMatch(/model PoolVisitDaily \{[^}]*@@id\(\[code, day, inApp, scanner\]\)/);
    expect(schema).not.toMatch(/model PoolVisitDaily \{[^}]*\n\s+(browser|device|step|trigger)\s/);
    expect(schema.replace(/\n\/\/\/\s*/g, " ")).toMatch(/at very low traffic a day's total can still coincide with a single sign-up/i);
    expect(schema).toMatch(/model PoolVisitDaily \{[^}]*day\s+DateTime\s+@db\.Date/);
    expect(schema).toMatch(/model PoolVisitDaily \{[^}]*@@index\(\[day\]\)/);
  });
});

describe("the staff test migration (2026-11-16)", () => {
  const STAFF = "prisma/migrations/20261116120100_pool_profile_staff_test/migration.sql";
  const sql = code(read(STAFF));
  it("its header says plainly what fails without it: every PoolProfile insert and every update that returns the row", () => {
    expect(read(STAFF)).toMatch(/EVERY insert into "PoolProfile"/);
    expect(read(STAFF)).toMatch(/every update of a "PoolProfile" that returns the row/i);
  });
  // Round 4 of #607: the flag also goes on the rows that outlive the
  // profile (an erased profile's offers and guest places stay), so a deleted
  // staff test never comes back into a count.
  it("adds the flag to the profile, its offers and its guest places, false for every existing row", () => {
    expect([...sql.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN IF NOT EXISTS "([^"]+)"/g)].map((m) => `${m[1]}.${m[2]}`)).toEqual([
      "PoolProfile.staffTest",
      "PoolOffer.staffTest",
      "GuestPlace.staffTest",
    ]);
    for (const t of ["PoolProfile", "PoolOffer", "GuestPlace"]) {
      expect(sql).toContain(`ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "staffTest" BOOLEAN NOT NULL DEFAULT false;`);
      expect(read("prisma/schema.prisma")).toMatch(new RegExp(`model ${t} \\{[^}]*staffTest\\s+Boolean\\s+@default\\(false\\)`));
    }
    expect(read(STAFF)).toMatch(/EVERY insert into "PoolOffer"/);
    expect(read(STAFF)).toMatch(/EVERY insert into "GuestPlace"/);
  });
  it("is additive, idempotent and one transaction with no data written", () => {
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/im);
    additiveOneTransaction(sql);
  });
});

describe("the backfill migration (2026-11-16): the per-visit rows added up, nothing deleted", () => {
  const BACKFILL = "prisma/migrations/20261116120200_pool_visit_daily_backfill/migration.sql";
  const sql = code(read(BACKFILL));
  it("adds to the totals, never replaces them: the new code's own counts survive", () => {
    expect(sql).toMatch(/INSERT INTO "PoolVisitDaily"[\s\S]*FROM "PoolVisitEvent"[\s\S]*DO UPDATE SET "count" = "PoolVisitDaily"\."count" \+ EXCLUDED\."count"/);
  });
  // Round 3 of #607: only opens the new rule would count, a real tap,
  // touch, key, wheel or scroll, or a start first: not the old 5-second
  // rule ("visible-time"), and not an open that did not say what opened it.
  const REAL = `"openedBy" IN (${L.POOL_OPEN_TRIGGERS.map((t) => `'${t}'`).join(", ")})`;
  it("only real-interaction opens, by London day; the browser, the device, the hour and the time on screen left behind", () => {
    expect(sql).toContain(`(("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date`);
    expect(sql).toMatch(/FROM "PoolVisitEvent"\s+WHERE "step" = 'opened'/);
    expect(sql).toContain(REAL);
    expect(REAL).not.toContain("visible-time");
    expect(sql).toContain(`INSERT INTO "PoolVisitDaily" ("code", "day", "inApp", "scanner", "count")`);
    expect(sql).not.toMatch(/"trigger"|"visibleMs"|"hasRef"|"browser"|"device"/);
  });
  it("its header's dry run, checks and rollback use the same rule", () => {
    const header = read(BACKFILL).replace(/\n--\s*/g, " ");
    expect(header.split(REAL).length - 1).toBeGreaterThanOrEqual(3);
    expect(header).toMatch(/skipped/i);
  });
  it("once only: it renames the old table in the same transaction, and does nothing when it is gone", () => {
    expect(sql).toMatch(/IF to_regclass\('"PoolVisitEvent"'\) IS NULL THEN[\s\S]*RETURN;/);
    expect(sql).toContain(`ALTER TABLE "PoolVisitEvent" RENAME TO "PoolVisitEventBackfilled";`);
  });
  it("deletes nothing, and is one transaction with no session-level SET", () => {
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*SET LOCAL lock_timeout = '5s';/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
    expect(sql).not.toMatch(/^\s*SET\s+(?!LOCAL)/im);
  });
  it("its header says to apply it after the deploy, and how to check it against the counters", () => {
    expect(read(BACKFILL)).toMatch(/APPLY AFTER THE DEPLOY/);
    expect(read(BACKFILL)).toMatch(/FULL JOIN counters/);
  });
  // Review of #607: both sides of the "every old row was added" check count
  // only days before the deploy day, so the deploy day raises no false alarm.
  it("the after-check compares old rows and added totals on the same days", () => {
    const header = read(BACKFILL);
    expect(header).toMatch(/FROM "PoolVisitEventBackfilled"[\s-]+WHERE "step" = 'opened' AND "openedBy" IN \([^)]*\)[\s-]+AND \(\("at" AT TIME ZONE 'UTC'\) AT TIME ZONE 'Europe\/London'\)::date < '<deploy day>'/);
    expect(header).toMatch(/FROM "PoolVisitDaily" WHERE "day" < '<deploy day>'/);
  });
});

describe("the drop migration (2026-11-16): separate, later, and only after the backfill", () => {
  const DROP = "prisma/migrations/20261116120300_drop_pool_visit_events/migration.sql";
  const sql = code(read(DROP));
  it("drops only the renamed old table", () => {
    expect([...sql.matchAll(/DROP TABLE IF EXISTS "([^"]+)"/g)].map((m) => m[1])).toEqual(["PoolVisitEventBackfilled"]);
    expect(sql).not.toMatch(/DROP TABLE (IF EXISTS )?"PoolVisitDaily"|DROP TABLE (IF EXISTS )?"PoolCampaignVisit"/);
  });
  it("refuses to run while the old table was never added up", () => {
    expect(sql).toMatch(/IF to_regclass\('"PoolVisitEvent"'\) IS NOT NULL THEN\s*RAISE EXCEPTION/);
  });
  it("is one transaction with no session-level SET", () => {
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*SET LOCAL lock_timeout = '5s';/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
    expect(sql).not.toMatch(/^\s*SET\s+(?!LOCAL)/im);
  });
});
