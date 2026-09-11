/**
 * The nightly `none`-bucket sweep has to leave evidence that it RAN.
 *
 * `src/lib/pipeline/__tests__/none-shadow.test.ts` pins what the sweep
 * decides. This spec pins the half that was actually broken: the WIRING
 * between the sweep and the table. On 2026-09-11 the sweep was found to
 * have filed ONE `WindowVerdict` in its entire life — 1 of 506 rows,
 * dated 2026-09-09 — because the cron only filed when
 * `result.alerts[0]` existed. Production's two most recent nights
 * (2026-09-10 and 2026-09-11) had no gated traffic at all, so even a
 * perfectly healthy sweep wrote nothing, and "ran and found nothing" was
 * the same absence of data as "did not run at all".
 *
 * Every test below is therefore about a night on which NOTHING IS WRONG.
 * That is the case the old code could not express.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function runSweep(request: APIRequestContext, query = "") {
  const res = await request.get(`/api/cron/none-bucket-shadow${query}`, {
    headers: { authorization: `Bearer ${E2E.CRON_SECRET}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.beforeAll(async () => {
  resetDb();
});

test.beforeEach(async ({ db }) => {
  await db.run(`DELETE FROM "WindowVerdict" WHERE "batchHash" LIKE 'none-bucket:%'`);
  await db.run(`DELETE FROM "AnalyzedMessage" WHERE "handledBy" = 'router-gate'`);
});

test("a night with NOTHING to re-examine still files a row", async ({ request, db }) => {
  // Production, 2026-09-10 and 2026-09-11: zero `router-gate` rows in the
  // window. The sweep is healthy and has no work. Without a row, that is
  // byte-for-byte identical to a cron that never fired.
  const out = await runSweep(request);
  expect(out.enabled).toBe(true);
  expect(out.checked).toBe(0);
  expect(out.filed).toBeGreaterThan(0);
  expect(out.batchHash).toMatch(/^none-bucket:\d{4}-\d{2}-\d{2}$/);

  const rows = await db.all<{ batchHash: string; verdictJson: Record<string, unknown> }>(
    `SELECT "batchHash", "verdictJson" FROM "WindowVerdict" WHERE "orgId" = $1 AND "batchHash" = $2`,
    [ORG_ID, out.batchHash],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].verdictJson.ran).toBe(true);
  expect(rows[0].verdictJson.checked).toBe(0);
  expect(rows[0].verdictJson.alertCount).toBe(0);
});

test("the filed row says which window it covered and how many it examined", async ({
  request,
  db,
}) => {
  for (const [i, body] of ["😂😂", "come on you gunners", "nice one"].entries()) {
    await db.run(
      `INSERT INTO "AnalyzedMessage" ("id","waMessageId","orgId","groupId","body","handledBy","authorName","createdAt")
       VALUES ($1,$2,$3,$4,$5,'router-gate','Pat Player', now() - interval '2 hours')`,
      [`nbs-${i}`, `nbs-wa-${i}`, ORG_ID, E2E.GROUP_ID, body],
    );
  }

  const out = await runSweep(request);
  expect(out.checked).toBe(3);
  expect(out.alerts).toBe(0); // the extractor stub finds no claims in banter

  const row = await db.one<{
    windowStart: Date;
    windowEnd: Date;
    verdictJson: Record<string, unknown>;
  }>(
    `SELECT "windowStart", "windowEnd", "verdictJson" FROM "WindowVerdict"
      WHERE "orgId" = $1 AND "batchHash" = $2`,
    [ORG_ID, out.batchHash],
  );
  expect(row).not.toBeNull();
  expect(row!.verdictJson.ran).toBe(true);
  expect(row!.verdictJson.checked).toBe(3);
  expect(row!.verdictJson.available).toBe(3);
  expect(row!.verdictJson.alertCount).toBe(0);
  // 24h of lookback, ending when the sweep ran.
  const spanHours =
    (new Date(row!.windowEnd).getTime() - new Date(row!.windowStart).getTime()) / 3_600_000;
  expect(spanHours).toBeCloseTo(24, 3);
  // The sweep proposes nothing, ever — not even when it files a row on a
  // night it found something to say.
  expect(row!.verdictJson.stateChanges).toEqual([]);
  expect(row!.verdictJson.groupReply).toBeNull();
});

test("a second run the same day updates the day's row instead of losing it", async ({
  request,
  db,
}) => {
  const one = await runSweep(request);
  const first = await db.one<{ windowEnd: Date }>(
    `SELECT "windowEnd" FROM "WindowVerdict" WHERE "orgId" = $1 AND "batchHash" = $2`,
    [ORG_ID, one.batchHash],
  );
  await new Promise((r) => setTimeout(r, 1_100));
  const two = await runSweep(request, "?force=1");
  expect(two.batchHash).toBe(one.batchHash);

  const rows = await db.all<{ windowEnd: Date }>(
    `SELECT "windowEnd" FROM "WindowVerdict" WHERE "orgId" = $1 AND "batchHash" = $2`,
    [ORG_ID, one.batchHash],
  );
  // Still one row for the day…
  expect(rows).toHaveLength(1);
  // …and it moved. `bot-health` reads `windowEnd` as "when did the sweep
  // last run", so a re-run that left the first run's timestamp behind
  // would make a working sweep look stale.
  expect(new Date(rows[0].windowEnd).getTime()).toBeGreaterThan(
    new Date(first!.windowEnd).getTime(),
  );
});

test("the sweep requires the cron secret", async ({ request }) => {
  const res = await request.get("/api/cron/none-bucket-shadow", {
    headers: { authorization: "Bearer nope" },
  });
  expect(res.status()).toBe(401);
});
