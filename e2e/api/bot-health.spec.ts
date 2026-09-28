/**
 * The off-Pi signal path, end to end against a real database.
 *
 * `src/lib/__tests__/bot-health.test.ts` pins the JUDGEMENT (which
 * thresholds, which false alarms). This spec pins the WIRING, which is
 * the half that has historically been dead: PR #13's `planFlushRetry`
 * was unreachable, four seatbelts were found dead on 2026-08-31, and the
 * unresolved-sender nudge was gated on the field its own failure mode
 * destroys. A mechanism nobody ever ran is not a mechanism.
 *
 * So: does a heartbeat actually land in the row, does the cron actually
 * read it, does it actually decide, and does the decision land as an
 * `OpsAlert` row for the owner's /admin/health page, opened once, kept
 * open while it holds and closed when it stops.
 *
 * AND IT SENDS NOTHING (2026-09-28). Every cron test below also asserts
 * that no `BotJob` was queued: the owner asked for these alerts to stop
 * reaching his phone and inbox, and a DM sneaking back in is the
 * regression this spec most needs to catch.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const CLEAN_COUNTERS = {
  seen: 40,
  buffered: 36,
  synthetic: 0,
  reconstructed: 0,
  notGroup: 4,
  degradedEnrichment: 0,
  nameless: 0,
  reactFailures: 0,
  flushFailures: 0,
  droppedMessages: 0,
};

async function heartbeat(
  request: APIRequestContext,
  body: Record<string, unknown>,
  key: string = E2E.WHATSAPP_API_KEY,
) {
  return request.post("/api/whatsapp/heartbeat", {
    headers: { "x-api-key": key },
    data: body,
  });
}

async function runHealthCron(request: APIRequestContext, at?: Date) {
  const res = await request.get("/api/cron/bot-health", {
    headers: {
      authorization: `Bearer ${E2E.CRON_SECRET}`,
      // Test-only clock (honoured under MT_TEST_MODE=1).
      ...(at ? { "x-test-now": at.toISOString() } : {}),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.beforeAll(async () => {
  resetDb();
});

test.beforeEach(async ({ db }) => {
  await db.run(`DELETE FROM "BotHealth"`);
  await db.run(`DELETE FROM "BotJob"`);
  await db.run(`DELETE FROM "OpsAlert"`);
  // Pin the participant sweep as FRESH so `sweep-stale` (a real finding,
  // and true of production today) does not colour every assertion below.
  //
  // This sets the SWEEP's own clock, not the members' sightings
  // (2026-09-09). A group message now refreshes the sender's
  // `Membership.lastSeenInGroupAt`, so that column no longer measures the
  // sweep — writing it here would prove nothing about this rule.
  await db.run(`UPDATE "Organisation" SET "lastParticipantSweepAt" = now() WHERE id = $1`, [
    ORG_ID,
  ]);
  // Same argument for the nightly `none`-bucket sweep (2026-09-11): a
  // missing row is now a real finding, and true of production the day
  // this shipped, so pin it FRESH here or it colours every assertion
  // below. The row is what the sweep files when it runs; see
  // `none-bucket-shadow.spec.ts` for the filing itself.
  await fileShadowRow(db, "now()");
});

/** Stand in for last night's `none`-bucket sweep having run. `at` is a
 *  SQL expression so a test can place it in the past. */
async function fileShadowRow(db: TestDb, at: string) {
  await db.run(`DELETE FROM "WindowVerdict" WHERE "batchHash" LIKE 'none-bucket:%'`);
  await db.run(
    `INSERT INTO "WindowVerdict"
       ("id","orgId","windowStart","windowEnd","batchHash","modelMs","costUsd","verdictJson","currentVerdictRefs")
     VALUES ('bh-shadow', $1, ${at} - interval '24 hours', ${at},
             'none-bucket:' || to_char(${at}, 'YYYY-MM-DD'), 0, 0,
             '{"ran":true,"checked":0,"alertCount":0}'::jsonb, '{}')`,
    [ORG_ID],
  );
}

test("the Pi's heartbeat lands on the org's health row", async ({ request, db }) => {
  const res = await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    processStartedAt: "2026-09-09T06:00:00.000Z",
    botVersion: "e2e",
    counters: CLEAN_COUNTERS,
    degradedCapabilities: [],
  });
  expect(res.status(), await res.text()).toBe(200);

  const rows = await db.all<{ seen: number; buffered: number; botVersion: string }>(
    `SELECT "seen", "buffered", "botVersion" FROM "BotHealth" WHERE "orgId" = $1`,
    [ORG_ID],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].seen).toBe(40);
  expect(rows[0].buffered).toBe(36);
  expect(rows[0].botVersion).toBe("e2e");
});

test("a second heartbeat updates the SAME row — one per org, forever", async ({
  request,
  db,
}) => {
  await heartbeat(request, { groupId: E2E.GROUP_ID, counters: CLEAN_COUNTERS });
  await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    counters: { ...CLEAN_COUNTERS, seen: 99 },
  });
  const rows = await db.all<{ seen: number }>(
    `SELECT "seen" FROM "BotHealth" WHERE "orgId" = $1`,
    [ORG_ID],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].seen).toBe(99);
});

test("a heartbeat for a group MatchTime does not know is accepted and dropped", async ({
  request,
  db,
}) => {
  // Never a 4xx. The Pi monitors onboarding groups that have no org yet,
  // and a group can be disabled between two ticks; making the Pi log
  // errors about either would be noise in the one log we are trying to
  // make readable.
  const res = await heartbeat(request, { groupId: "not-a-real-group@g.us" });
  expect(res.status()).toBe(200);
  expect((await res.json()).ignored).toBe("unknown-group");
  expect(await db.all(`SELECT 1 FROM "BotHealth"`)).toHaveLength(0);
});

test("the heartbeat endpoint requires the API key", async ({ request }) => {
  const res = await heartbeat(request, { groupId: E2E.GROUP_ID }, "wrong-key");
  expect(res.status()).toBe(401);
});

type AlertRow = {
  kind: string;
  severity: string;
  title: string;
  resolvedAt: Date | null;
  firstSeenAt: Date;
};

const e2eRow = (out: { report: Array<{ org: string }> }) =>
  out.report.find((r) => r.org === "E2E Test FC") as {
    org: string;
    codes: string[];
    recorded: { opened: number; refreshed: number; closed: number } | null;
  };

async function alerts(db: TestDb): Promise<AlertRow[]> {
  return db.all<AlertRow>(
    `SELECT kind, severity, title, "resolvedAt", "firstSeenAt" FROM "OpsAlert"
      WHERE "orgId" = $1 ORDER BY "createdAt", kind`,
    [ORG_ID],
  );
}

/** Nothing the health cron does may ever reach a phone. */
async function expectNoMessagesQueued(db: TestDb) {
  const jobs = await db.all<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "BotJob"`);
  expect(jobs[0].n, "the health cron must never queue a DM or a group post").toBe(0);
}

test("the cron says nothing about a healthy org", async ({ request, db }) => {
  await heartbeat(request, { groupId: E2E.GROUP_ID, counters: CLEAN_COUNTERS });
  const out = await runHealthCron(request);
  const row = e2eRow(out);
  expect(row.codes).toEqual([]);
  expect(row.recorded).toEqual({ opened: 0, refreshed: 0, closed: 0 });
  expect(await alerts(db)).toEqual([]);
  await expectNoMessagesQueued(db);
});

test("a degraded layer is RECORDED, not sent", async ({ request, db }) => {
  await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    counters: { ...CLEAN_COUNTERS, synthetic: 7, droppedMessages: 2 },
    degradedCapabilities: ["participant-sync"],
  });
  const out = await runHealthCron(request);
  const row = e2eRow(out);
  expect(row.codes).toEqual(
    expect.arrayContaining(["synthetic-ids", "messages-dropped", "capability-degraded"]),
  );
  expect(row.recorded?.opened).toBe(row.codes.length);

  const rows = await alerts(db);
  expect(rows.map((r) => r.kind).sort()).toEqual(
    row.codes.map((c) => `health:${c}`).sort(),
  );
  expect(rows.every((r) => r.resolvedAt === null)).toBe(true);
  await expectNoMessagesQueued(db);
});

test("the same fault an hour later keeps ONE row open rather than opening another", async ({
  request,
  db,
}) => {
  await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    counters: { ...CLEAN_COUNTERS, synthetic: 7 },
  });
  await runHealthCron(request);
  const second = await runHealthCron(request);
  expect(e2eRow(second).recorded).toEqual({ opened: 0, refreshed: 1, closed: 0 });

  const rows = await alerts(db);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("health:synthetic-ids");
  await expectNoMessagesQueued(db);
});

test("a fault that clears closes its row, and the history stays", async ({ request, db }) => {
  await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    counters: { ...CLEAN_COUNTERS, reactFailures: 2 },
  });
  await runHealthCron(request);

  // The Pi restarts clean.
  await heartbeat(request, { groupId: E2E.GROUP_ID, counters: CLEAN_COUNTERS });
  const out = await runHealthCron(request);
  expect(e2eRow(out).recorded).toEqual({ opened: 0, refreshed: 0, closed: 1 });

  const rows = await alerts(db);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("health:reactions-failing");
  expect(rows[0].resolvedAt).not.toBeNull();
  await expectNoMessagesQueued(db);
});

test("a club whose bot is switched off has its open alerts closed", async ({ request, db }) => {
  await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    counters: { ...CLEAN_COUNTERS, synthetic: 1 },
  });
  await runHealthCron(request);
  expect((await alerts(db)).filter((r) => r.resolvedAt === null)).toHaveLength(1);

  await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = false WHERE id = $1`, [ORG_ID]);
  try {
    await runHealthCron(request);
    expect((await alerts(db)).filter((r) => r.resolvedAt === null)).toHaveLength(0);
  } finally {
    await db.run(`UPDATE "Organisation" SET "whatsappBotEnabled" = true WHERE id = $1`, [ORG_ID]);
  }
});

test("a `none`-bucket sweep that has filed NO row is a degradation", async ({ request, db }) => {
  // The sweep is the only thing that ever re-reads a message the router
  // dismissed as banter, and its failure mode is silence: it reports by
  // filing a row, so the absence of one is the only signal there is.
  await heartbeat(request, { groupId: E2E.GROUP_ID, counters: CLEAN_COUNTERS });
  await db.run(`DELETE FROM "WindowVerdict" WHERE "batchHash" LIKE 'none-bucket:%'`);

  const out = await runHealthCron(request);
  expect(e2eRow(out).codes).toContain("none-shadow-stale");
  expect((await alerts(db)).map((r) => r.kind)).toContain("health:none-shadow-stale");
  await expectNoMessagesQueued(db);
});

test("a sweep that ran LAST NIGHT and found nothing raises nothing", async ({ request, db }) => {
  await heartbeat(request, { groupId: E2E.GROUP_ID, counters: CLEAN_COUNTERS });
  await fileShadowRow(db, "now() - interval '9 hours'");

  const out = await runHealthCron(request);
  expect(e2eRow(out).codes).toEqual([]);
});

test("a sweep that last filed two nights ago is stale", async ({ request, db }) => {
  await heartbeat(request, { groupId: E2E.GROUP_ID, counters: CLEAN_COUNTERS });
  await fileShadowRow(db, "now() - interval '48 hours'");

  const out = await runHealthCron(request);
  expect(e2eRow(out).codes).toContain("none-shadow-stale");
});

test("the cron requires the cron secret", async ({ request }) => {
  const res = await request.get("/api/cron/bot-health", {
    headers: { authorization: "Bearer nope" },
  });
  expect(res.status()).toBe(401);
});

test("no heartbeat at all is not treated as an outage", async ({ request, db }) => {
  // The server ships on merge; the Pi is deployed by hand. A healthy Pi on
  // an older build sends nothing here, and flagging that would guarantee
  // a false alarm on the day this shipped.
  const out = await runHealthCron(request);
  expect(e2eRow(out).codes).not.toContain("pi-silent");
  await expectNoMessagesQueued(db);
});
