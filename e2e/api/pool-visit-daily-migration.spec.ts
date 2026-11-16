/**
 * The /play breakdown's four migrations of 2026-11-16 (daily totals only),
 * against real Postgres. `src/lib/pool/__tests__/schema-sql.test.ts` pins
 * their text; this proves what they do:
 *
 *   - 20261116120000 (the table) and 20261116120100 (PoolProfile.staffTest)
 *     re-run cleanly on a database that has them, and the CHECKs refuse a
 *     bad row;
 *   - 20261116120200 (the backfill) adds the per-visit OPENS of
 *     "PoolVisitEvent" up by London day, in-app browser and scanner flag
 *     (no browser, device, interaction type or starts), only the opens the
 *     new rule counts (never "visible-time" or none), ON TOP of the totals
 *     the new code has already written, renames the old table, deletes
 *     nothing, and does nothing on a second run; its after-check (b) agrees
 *     on the deploy day;
 *   - 20261116120300 (the drop) refuses to run before the backfill, and
 *     afterwards drops only the renamed old table.
 *
 * The e2e database is built by `prisma db push`, which no longer has
 * "PoolVisitEvent": it is made here by its own migration of 2026-11-13.
 * No model, no WhatsApp: SQL only. $0.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../fixtures";
import { REPO_ROOT } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const sql = (dir: string) => readFileSync(path.join(REPO_ROOT, "prisma/migrations", dir, "migration.sql"), "utf8");
const OLD_LOG = sql("20261113120000_pool_visit_events");
const DAILY = sql("20261116120000_pool_visit_daily");
const STAFF = sql("20261116120100_pool_profile_staff_test");
const BACKFILL = sql("20261116120200_pool_visit_daily_backfill");
const DROP = sql("20261116120300_drop_pool_visit_events");

const tableOf = async (db: TestDb, name: string) => (await db.one<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [`"${name}"`]))?.t ?? null;

async function clean(db: TestDb) {
  await db.run(`DROP TABLE IF EXISTS "PoolVisitEvent"`);
  await db.run(`DROP TABLE IF EXISTS "PoolVisitEventBackfilled"`);
  await db.run(`DELETE FROM "PoolVisitDaily"`);
}

let seq = 0;
async function oldRow(
  db: TestDb,
  r: { at: string; code?: string; step?: string; openedBy?: string | null; browser?: string; device?: string; inApp?: string; scanner?: boolean; visibleMs?: number | null },
) {
  await db.run(
    `INSERT INTO "PoolVisitEvent" (id, "at", code, step, "openedBy", "visibleMs", "hasRef", browser, "inApp", device, scanner)
     VALUES ($1, $2::timestamp, $3, $4, $5, $6, true, $7, $8, $9, $10)`,
    [
      `e2e-old-${++seq}`,
      r.at,
      r.code ?? "fb",
      r.step ?? "opened",
      r.openedBy === undefined ? "touch" : r.openedBy,
      r.visibleMs ?? 5000,
      r.browser ?? "safari",
      r.inApp ?? "none",
      r.device ?? "mobile",
      r.scanner ?? false,
    ],
  );
}

const totals = (db: TestDb) =>
  db.all<{ code: string; day: string; inApp: string; scanner: boolean; count: number }>(
    `SELECT code, to_char(day, 'YYYY-MM-DD') AS day, "inApp", scanner, count FROM "PoolVisitDaily" ORDER BY day, code, "inApp", scanner`,
  );

/** The backfill header's after-check (b), with the deploy day filled in. */
function afterCheck(deployDay: string): string {
  const header = BACKFILL.slice(0, BACKFILL.indexOf("WHAT APPLYING THIS DOES"));
  const start = header.indexOf("--   SELECT (SELECT count(*) FROM \"PoolVisitEventBackfilled\"");
  const end = header.indexOf("added_before_deploy_day;", start) + "added_before_deploy_day;".length;
  return header
    .slice(start, end)
    .split("\n")
    .map((l) => l.replace(/^--\s?/, ""))
    .join("\n")
    .replaceAll("<deploy day>", deployDay);
}

test.afterAll(async ({ db }) => clean(db));

test("the table and the staff test column: both re-run cleanly, and the CHECKs refuse a bad total", async ({ db }) => {
  await clean(db);
  await db.run(DAILY);
  await db.run(DAILY);
  await db.run(STAFF);
  await db.run(STAFF);
  expect(await db.one(`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'PoolProfile' AND column_name = 'staffTest'`)).toEqual({
    column_default: "false",
    is_nullable: "NO",
  });
  const put = (over: Record<string, unknown>) => {
    const row = { code: "fb", day: "2026-11-16", inApp: "none", scanner: false, count: 1, ...over };
    const cols = Object.keys(row);
    return db.run(`INSERT INTO "PoolVisitDaily" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
  };
  await put({});
  for (const [bad, constraint] of [
    [{ inApp: "tiktok", day: "2026-11-12" }, "PoolVisitDaily_inApp_check"],
    [{ code: "FB Sutton", day: "2026-11-11" }, "PoolVisitDaily_code_check"],
    [{ count: -1, day: "2026-11-10" }, "PoolVisitDaily_count_check"],
  ] as const) {
    await expect(put(bad), constraint).rejects.toThrow(new RegExp(constraint));
  }
  await expect(put({})).rejects.toThrow(/PoolVisitDaily_pkey/);
  await db.run(`DELETE FROM "PoolVisitDaily"`);
});

test("the backfill adds up only the real-interaction opens, by London day, in-app browser and scanner flag, on top of the new code's totals, then renames the old table; a second run does nothing", async ({ db }) => {
  await clean(db);
  await db.run(OLD_LOG);
  // 14 November. Added: a key press and a wheel on two different browsers
  // and devices (one total: no browser, device or interaction type), a
  // scroll in Facebook's app, a scanner's tap. Skipped: two opens by the old
  // 5-second rule, an open that did not say, and a start.
  await oldRow(db, { at: "2026-11-14 09:00:00", browser: "chrome", device: "desktop", openedBy: "key" });
  await oldRow(db, { at: "2026-11-14 21:00:00", browser: "samsung", device: "tablet", openedBy: "wheel" });
  await oldRow(db, { at: "2026-11-14 10:00:00", openedBy: "scroll", visibleMs: 1200, inApp: "facebook" });
  await oldRow(db, { at: "2026-11-14 10:00:00", openedBy: "touch", browser: "other", device: "other", scanner: true });
  await oldRow(db, { at: "2026-11-14 11:00:00", openedBy: "visible-time" });
  await oldRow(db, { at: "2026-11-14 11:00:00", openedBy: "visible-time", scanner: true });
  await oldRow(db, { at: "2026-11-14 12:00:00", openedBy: null });
  await oldRow(db, { at: "2026-11-14 10:00:00", step: "started", openedBy: null });
  // 16 November, the deploy day: one old open before the deploy, and the
  // new code's own total for the same key after it.
  await oldRow(db, { at: "2026-11-16 08:00:00", openedBy: "touch", visibleMs: 300 });
  await db.run(`INSERT INTO "PoolVisitDaily" (code, day, "inApp", scanner, count) VALUES ('fb', '2026-11-16', 'none', false, 2)`);

  // The header's dry run, read only: what will be added and what skipped.
  const dryRun = BACKFILL.slice(BACKFILL.indexOf("--   SELECT (("), BACKFILL.indexOf("--   ROLLBACK;", BACKFILL.indexOf("--   SELECT ((")))
    .split("\n")
    .map((l) => l.replace(/^--\s?/, ""))
    .join("\n");
  const plan = await db.all<{ backfill: string; count: string }>(`SELECT backfill, sum(count)::text AS count FROM (${dryRun.replace(/;\s*$/, "")}) d GROUP BY 1 ORDER BY 1`);
  expect(plan).toEqual([
    { backfill: "added", count: "5" },
    { backfill: "skipped", count: "3" },
  ]);

  await db.run(BACKFILL);
  const after = await totals(db);
  expect(after).toEqual([
    { code: "fb", day: "2026-11-14", inApp: "facebook", scanner: false, count: 1 },
    { code: "fb", day: "2026-11-14", inApp: "none", scanner: false, count: 2 },
    { code: "fb", day: "2026-11-14", inApp: "none", scanner: true, count: 1 },
    { code: "fb", day: "2026-11-16", inApp: "none", scanner: false, count: 3 },
  ]);
  // Nothing deleted: every old row is there, under the new name, the skipped ones among them.
  expect(await tableOf(db, "PoolVisitEvent")).toBeNull();
  expect(await db.one(`SELECT count(*)::int AS n FROM "PoolVisitEventBackfilled"`)).toEqual({ n: 9 });
  expect(after.reduce((n, r) => n + r.count, 0)).toBe(5 + 2);

  // The header's after-check (b), deploy day 16 November: the counted old
  // opens before it and the totals before it agree.
  expect(await db.one(afterCheck("2026-11-16"))).toEqual({ old_opens: "4", added_before_deploy_day: "4" });

  // Once only.
  await db.run(BACKFILL);
  expect(await totals(db)).toEqual(after);
});

test("a visit late in a summer evening, UTC, lands on the next London day", async ({ db }) => {
  await clean(db);
  await db.run(OLD_LOG);
  await oldRow(db, { at: "2026-07-01 23:00:00", openedBy: "key" });
  await db.run(BACKFILL);
  expect((await totals(db)).map((r) => r.day)).toEqual(["2026-07-02"]);
});

test("the drop refuses to run before the backfill; after it, it drops only the renamed old table, and re-runs", async ({ db }) => {
  await clean(db);
  await db.run(OLD_LOG);
  await oldRow(db, { at: "2026-11-14 09:00:00" });
  // The file's guard, run on its own: the whole file would stop at it with
  // its transaction open, which a pooled connection must not be left in.
  const guard = DROP.slice(DROP.indexOf("DO $$"), DROP.indexOf("$$;") + 3);
  expect(DROP.indexOf("DO $$")).toBeLessThan(DROP.indexOf("DROP TABLE IF EXISTS"));
  await expect(db.run(guard)).rejects.toThrow(/never added up/);
  expect(await tableOf(db, "PoolVisitEvent")).toBe('"PoolVisitEvent"');

  await db.run(BACKFILL);
  await db.run(DROP);
  expect(await tableOf(db, "PoolVisitEvent")).toBeNull();
  expect(await tableOf(db, "PoolVisitEventBackfilled")).toBeNull();
  expect(await tableOf(db, "PoolVisitDaily")).toBe('"PoolVisitDaily"');
  expect(await totals(db)).toHaveLength(1);
  await db.run(DROP);
});

test("the backfill on a database that never had the old table does nothing", async ({ db }) => {
  await clean(db);
  await db.run(BACKFILL);
  expect(await totals(db)).toEqual([]);
});
