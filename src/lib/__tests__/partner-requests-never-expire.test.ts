/**
 * A partner request NEVER expires (Kemal, 2026-11-05: "stop expiring
 * everything for unanswered too"). A request between clubs stays open until
 * the other club accepts or declines it, or the asking club withdraws it. An
 * accepted pairing never expired and still does not.
 *
 * Pinned here, structurally: there is no expiry rule, no sweep, no cron and
 * no schedule; no "your request had no answer in 14 days" notice in either
 * language; no help text or guide line about 14 days; and the column that
 * held a request's expiry is dropped by an idempotent, one-transaction
 * migration. The writer's behaviour (a request a year old can still be
 * accepted) is in partner-requests.test.ts.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as rules from "../club-partnership-rules";
import * as writer from "../club-partnership";
import { t } from "../i18n/t";
import { settingInfo } from "../settings-info";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const MIGRATION = "prisma/migrations/20261105090000_partner_requests_never_expire/migration.sql";

describe("no expiry exists", () => {
  it("the rules have no expiry constant and no expiry check", () => {
    expect("PARTNER_REQUEST_EXPIRES_MS" in rules).toBe(false);
    expect("requestExpired" in rules).toBe(false);
  });
  it("the writer has no expiry sweep", () => {
    expect("runPartnerRequestExpirySweep" in writer).toBe(false);
  });
  it("there is no expiry cron route and no schedule for one", () => {
    expect(existsSync(join(ROOT, "src/app/api/cron/partner-requests/route.ts"))).toBe(false);
    const cfg = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string }> };
    expect(cfg.crons.map((c) => c.path)).not.toContain("/api/cron/partner-requests");
  });
  it("the writer never sets or reads a request's expiry", () => {
    expect(read("src/lib/club-partnership.ts")).not.toMatch(/expiresAt/);
  });
  it("an expired end reason stays allowed, for the old rows that have it", () => {
    expect(rules.PARTNERSHIP_END_REASONS).toContain("expired");
  });
});

describe("no copy says a request ends unanswered", () => {
  for (const lang of ["en", "tr"] as const) {
    it(`${lang}: no expiry notice, and the guide has no 14 days`, () => {
      expect("pr_expired_notice" in t(lang)).toBe(false);
      const info = settingInfo(lang, "partnerClubs");
      const text = [...info.what, info.newClubs, ...(info.together ?? [])].join("\n");
      expect(text).not.toMatch(/14 days|14 gün|expire|süresi dol/i);
      expect(text).not.toMatch(/no answer ends|Yanıtlanmayan bir istek/);
    });
  }
  it("English and Turkish say a request stays open until it is answered or withdrawn", () => {
    expect(settingInfo("en", "partnerClubs").what.join("\n")).toContain(
      "A request stays open until the other club accepts or declines it, or your club withdraws it.",
    );
    expect(settingInfo("tr", "partnerClubs").what.join("\n")).toContain(
      "Bir istek, diğer kulüp kabul edene ya da reddedene veya kulübünüz geri çekene kadar açık kalır.",
    );
  });
});

describe("the column goes", () => {
  it("the schema's ClubPartnership has no expiresAt", () => {
    const schema = read("prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model ClubPartnership {"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(body).not.toMatch(/\bexpiresAt\b/);
  });
  it("the migration drops it idempotently, in one transaction, with no session SET", () => {
    const sql = code(read(MIGRATION));
    expect(sql).toMatch(/ALTER TABLE "ClubPartnership" DROP COLUMN IF EXISTS "expiresAt";/);
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
    expect(sql).not.toMatch(/^\s*SET\s+(?!LOCAL)/im);
    // Nothing else is dropped, and the endReason CHECK (which allows the
    // historical 'expired') is left as it is.
    expect(sql.match(/DROP\s+(COLUMN|TABLE|INDEX|CONSTRAINT)/gi)).toHaveLength(1);
  });
});
