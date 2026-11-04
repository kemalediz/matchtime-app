/**
 * WhatsApp Cloud API plan, PR C2: the schema (MDs/whatsapp-cloud-api-plan-
 * 2026-11-04.md sections 5.2, 5.5 and 5.6).
 *
 *   - `PlatformJob` gains its channel (NOT NULL, default 'baileys', so
 *     every existing row and every row old code writes is a club number
 *     job) and the columns the Cloud dispatcher and the status webhook
 *     fill later: template name, language and parameters, delivered,
 *     read, Meta's error code;
 *   - `WaInbound`, one row per inbound message (dedupe of Meta's retries,
 *     and the sweep that retries a message never processed);
 *   - `CloudTemplateStatus`, one row per template and language;
 *   - the migration is additive, idempotent and one transaction, with no
 *     session level SET (the 2026-09-29 pooler incident), and its CHECKs
 *     carry exactly the values the TypeScript knows;
 *   - the re-runnable CHECK file carries the same CHECKs, and the e2e
 *     database is armed with it (db push never creates a CHECK).
 *
 * That the CHECKs really refuse a bad row, and that the Pi is never handed
 * a cloud job, is proven against Postgres in e2e/api/platform-jobs.spec.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/pool/switch-env", () => ({ poolEnvForApiRequest: vi.fn() }));

import { SEND_CHANNELS } from "../send-channel";
import { CLOUD_TEMPLATE_CATEGORIES } from "../cloud-api/vocab";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

const MIGRATION = "prisma/migrations/20261104210000_cloud_api_c2/migration.sql";
const CHECKS = "prisma/sql/cloud-api-check.sql";
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

const sql = code(read(MIGRATION));
const checks = code(read(CHECKS));
const schema = read("prisma/schema.prisma");

function model(name: string): string {
  const m = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  expect(m, `model ${name}`).not.toBeNull();
  return m![1];
}

/** Every `ADD CONSTRAINT "<name>" CHECK (...)` statement, by name. */
function checkStatements(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /ADD CONSTRAINT "([^"]+)"\s+CHECK\s*\(([\s\S]*?)\);/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  return out;
}

describe("the channel vocabulary", () => {
  it("is the two numbers", () => {
    expect([...SEND_CHANNELS]).toEqual(["baileys", "cloud"]);
  });
});

describe("the C2 migration", () => {
  it("is one transaction with no session level SET", () => {
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/COMMIT;\s*$/);
    expect(sql.replace(/SET LOCAL/g, "")).not.toMatch(/\bSET\s+\w+\s*=/i);
    expect(sql).not.toMatch(/\bSET\s+(SESSION\s+)?(TRANSACTION|default_transaction)/i);
  });

  it("is additive: no DROP TABLE, DROP COLUMN, DROP INDEX, UPDATE, DELETE or ALTER COLUMN", () => {
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|DROP INDEX|ALTER COLUMN|\bUPDATE\s+"|DELETE FROM|TRUNCATE/i);
    // The only DROP is a CHECK's own, just before it is added again (idempotent).
    for (const m of sql.matchAll(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g)) {
      expect(sql).toContain(`ADD CONSTRAINT "${m[1]}"`);
      expect(m[1]).toMatch(/_check$/);
    }
  });

  it("is idempotent: every column, table and index IF NOT EXISTS", () => {
    for (const m of sql.matchAll(/ADD COLUMN\s+(IF NOT EXISTS\s+)?"/g)) expect(m[1]).toBeTruthy();
    for (const m of sql.matchAll(/CREATE TABLE\s+(IF NOT EXISTS\s+)?"/g)) expect(m[1]).toBeTruthy();
    for (const m of sql.matchAll(/CREATE (UNIQUE )?INDEX\s+(IF NOT EXISTS\s+)?"/g)) expect(m[2]).toBeTruthy();
  });

  it("gives every PlatformJob a channel, NOT NULL and 'baileys' by default, so old rows and old code stay on the Pi", () => {
    expect(sql).toMatch(/ALTER TABLE "PlatformJob" ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'baileys';/);
  });

  it("adds the dispatcher's and the status webhook's columns to PlatformJob, all nullable", () => {
    for (const [col, type] of [
      ["templateName", "TEXT"],
      ["templateLang", "TEXT"],
      ["templateParams", "JSONB"],
      ["deliveredAt", "TIMESTAMP(3)"],
      ["readAt", "TIMESTAMP(3)"],
      ["errorCode", "INTEGER"],
    ]) {
      expect(sql).toContain(`ALTER TABLE "PlatformJob" ADD COLUMN IF NOT EXISTS "${col}" ${type};`);
    }
  });

  it("creates WaInbound and CloudTemplateStatus", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "WaInbound"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "CloudTemplateStatus"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "WaInbound_channel_wamid_key" ON "WaInbound"\("channel", "wamid"\)/);
  });

  it("CHECKs every channel against the vocabulary, on both tables", () => {
    const c = checkStatements(sql);
    expect(c.get("PlatformJob_channel_check")).toBe(`"channel" IN (${list(SEND_CHANNELS)})`);
    expect(c.get("WaInbound_channel_check")).toBe(`"channel" IN (${list(SEND_CHANNELS)})`);
  });

  it("CHECKs a template's category against Meta's three", () => {
    const c = checkStatements(sql);
    expect(c.get("CloudTemplateStatus_category_check")).toBe(`"category" IS NULL OR "category" IN (${list(CLOUD_TEMPLATE_CATEGORIES)})`);
    expect(c.get("CloudTemplateStatus_previousCategory_check")).toBe(
      `"previousCategory" IS NULL OR "previousCategory" IN (${list(CLOUD_TEMPLATE_CATEGORIES)})`,
    );
  });

  it("no regex bound above 255 (Postgres refuses it when a row is checked, not when the CHECK is added)", () => {
    for (const src of [sql, checks]) {
      for (const m of src.matchAll(/\{(\d+)(?:,(\d+))?\}/g)) {
        expect(Number(m[2] ?? m[1])).toBeLessThanOrEqual(255);
      }
    }
  });

  it("an inbound row names its sender by phone or by Meta's user id", () => {
    expect(checkStatements(sql).get("WaInbound_sender_check")).toBe(`"phone" IS NOT NULL OR "waUserId" IS NOT NULL`);
  });
});

describe("the CHECK file", () => {
  it("carries exactly the migration's CHECKs, statement for statement", () => {
    const a = checkStatements(sql);
    const b = checkStatements(checks);
    expect(a.size).toBeGreaterThan(5);
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it("is one transaction, and the e2e database is armed with it", () => {
    expect(checks).toMatch(/^\s*BEGIN;/m);
    expect(checks).toMatch(/COMMIT;\s*$/);
    expect(read("e2e/run.ts")).toContain(`"cloud-api-check.sql"`);
  });
});

describe("prisma/schema.prisma", () => {
  it("PlatformJob's channel defaults to baileys, and the new columns are optional", () => {
    const m = model("PlatformJob");
    expect(m).toMatch(/^\s*channel\s+String\s+@default\("baileys"\)/m);
    for (const [col, type] of [
      ["templateName", "String\\?"],
      ["templateLang", "String\\?"],
      ["templateParams", "Json\\?"],
      ["deliveredAt", "DateTime\\?"],
      ["readAt", "DateTime\\?"],
      ["errorCode", "Int\\?"],
    ]) {
      expect(m).toMatch(new RegExp(`^\\s*${col}\\s+${type}`, "m"));
    }
  });

  it("WaInbound is unique on channel and wamid", () => {
    expect(model("WaInbound")).toMatch(/@@unique\(\[channel, wamid\]\)/);
  });

  it("CloudTemplateStatus is keyed by name and language", () => {
    expect(model("CloudTemplateStatus")).toMatch(/@@id\(\[name, language\]\)/);
  });
});
