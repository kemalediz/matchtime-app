/**
 * THE DAILY AI CAP, END TO END, THROUGH /api/whatsapp/analyze.
 *
 * Stubbed models only (no live call is possible in this suite). The stubs
 * sit behind the same guard as the real model (`budgetedModel`), and can
 * report a cost, so this spec drives the real ledger SQL against the real
 * Postgres: the reservation, the booking, the refusal, the once-a-day
 * reply claim and the overshoot bound under concurrent requests.
 *
 * "No model call" is asserted on the usage row itself: `calls` counts
 * every call the guard let through, stub or real, so an unchanged `calls`
 * across a batch means nothing was asked.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn, selfIn } from "../helpers/stub";
import { U, MATCH, ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

let n = 0;
const msgId = () => `e2e-ai-cap-${Date.now()}-${++n}`;

const EN_LINE = "I've answered a lot of questions today, ask me again tomorrow.";
const TR_LINE = "Bugün çok soru yanıtladım, yarın tekrar sor.";

interface UsageRow {
  costUsd: number;
  reservedUsd: number;
  calls: number;
  refusedCalls: number;
  skippedMessages: number;
  cappedAt: Date | null;
  capReplySentAt: Date | null;
}

/** Today's row, London day, as the ledger keys it. */
const usage = (db: TestDb) =>
  db.one<UsageRow>(
    `SELECT "costUsd", "reservedUsd", "calls", "refusedCalls", "skippedMessages", "cappedAt", "capReplySentAt"
       FROM "OrgAiUsage"
      WHERE "orgId" = $1 AND "day" = (now() AT TIME ZONE 'Europe/London')::date`,
    [ORG_ID],
  );

const status = (db: TestDb, userId: string) =>
  db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [
    MATCH.upcoming,
    userId,
  ]);

const find = (res: { results: Array<{ waMessageId: string; reply: string | null }> }, id: string) =>
  res.results.find((r) => r.waMessageId === id)!;

async function setCap(db: TestDb, usd: number | null): Promise<void> {
  await db.run(`UPDATE "Organisation" SET "aiDailyCapUsd" = $2 WHERE id = $1`, [ORG_ID, usd]);
}

test.beforeAll(() => {
  resetDb();
});

test("below the cap, every call is booked at what it cost and the holds drain to zero", async ({ request, db }) => {
  await setCap(db, 1);
  engineOn({ "im in for tuesday": { route: "self_att", facts: selfIn() } }, { routerCostUsd: 0.003, extractorCostUsd: 0.004 });
  const id = msgId();
  await postAnalyze(request, [
    { waMessageId: id, body: "im in for tuesday", authorPhone: "447700900009", authorName: "Ian Innes" },
  ]);
  expect((await status(db, U.fresh))?.status).toBe("CONFIRMED");
  const u = await usage(db);
  expect(u?.calls).toBe(2); // one router call, one extractor call
  expect(Number(u?.costUsd)).toBeCloseTo(0.007, 9);
  expect(Number(u?.reservedUsd)).toBeCloseTo(0, 9);
  expect(u?.cappedAt).toBeNull();
});

test("at the cap: IN and OUT still work, banter is silent, a tagged ask gets ONE line, and no model is called", async ({
  request,
  db,
}) => {
  // Spend exactly the cap.
  await db.run(`UPDATE "OrgAiUsage" SET "costUsd" = 1 WHERE "orgId" = $1`, [ORG_ID]);
  const before = (await usage(db))!;

  // If anything DID reach the stubs, these would show: the tagged ask
  // would be answered as a question and the banter routed somewhere.
  engineOn(
    {
      "@Match Time who is playing tuesday?": { route: "question" },
      "lol what a goal": { route: "self_att", facts: selfIn() },
    },
    { routerCostUsd: 0.003, extractorCostUsd: 0.004 },
  );

  const ids = { in: msgId(), out: msgId(), ask: msgId(), banter: msgId() };
  const res = await postAnalyze(request, [
    { waMessageId: ids.in, body: "in", authorPhone: "447700900010", authorName: "Zara Zest" },
    { waMessageId: ids.out, body: "out", authorPhone: "447700900003", authorName: "Pat Player" },
    {
      waMessageId: ids.ask,
      body: "@Match Time who is playing tuesday?",
      authorPhone: "447700900004",
      authorName: "Riley Rater",
      botMentioned: true,
    },
    { waMessageId: ids.banter, body: "lol what a goal", authorPhone: "447700900008", authorName: "Tom Third" },
  ]);

  // The floor's deterministic path wrote both, with no model.
  expect(["CONFIRMED", "BENCH"]).toContain((await status(db, U.extra))?.status);
  expect((await status(db, U.player))?.status).not.toBe("CONFIRMED");
  // One polite line to the tagged ask; silence for the banter.
  expect(find(res, ids.ask).reply).toBe(EN_LINE);
  expect(find(res, ids.banter).reply).toBeNull();
  expect(EN_LINE).not.toMatch(/[—–]/);

  const after = (await usage(db))!;
  expect(after.calls).toBe(before.calls); // NOTHING was asked
  expect(Number(after.costUsd)).toBe(Number(before.costUsd));
  expect(after.skippedMessages - before.skippedMessages).toBe(2);
  expect(after.cappedAt).not.toBeNull();
  expect(after.capReplySentAt).not.toBeNull();

  // Recorded for the owner's health page, once, and never as a DM.
  expect(await db.count(`SELECT COUNT(*) FROM "OpsAlert" WHERE kind = 'ai-daily-cap' AND "orgId" = $1`, [ORG_ID])).toBe(1);
  expect(
    await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE kind = 'dm' AND text LIKE '%cap%'`),
  ).toBe(0);
});

test("the polite line is sent at most once per club per day", async ({ request }) => {
  const id = msgId();
  const res = await postAnalyze(request, [
    {
      waMessageId: id,
      body: "@Match Time who is playing tuesday?",
      authorPhone: "447700900004",
      authorName: "Riley Rater",
      botMentioned: true,
    },
  ]);
  expect(find(res, id).reply).toBeNull();
});

test("the line speaks the club's language", async ({ request, db }) => {
  await db.run(`UPDATE "OrgAiUsage" SET "capReplySentAt" = NULL WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    const id = msgId();
    const res = await postAnalyze(request, [
      {
        waMessageId: id,
        body: "@Match Time salı kim oynuyor?",
        authorPhone: "447700900004",
        authorName: "Riley Rater",
        botMentioned: true,
      },
    ]);
    expect(find(res, id).reply).toBe(TR_LINE);
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});

test("concurrent requests cannot spend past the cap by more than the stated bound", async ({ request, db }) => {
  await db.run(`DELETE FROM "OrgAiUsage" WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(`DELETE FROM "OpsAlert" WHERE kind = 'ai-daily-cap'`);
  const cap = 0.05;
  await setCap(db, cap);
  const bodies = Array.from({ length: 12 }, (_, i) => `just chatting number ${i + 1}`);
  // Each request is ONE router call at $0.009 (below the $0.01 hold), and
  // the router calls it banter, so nothing else is asked.
  engineOn(Object.fromEntries(bodies.map((b) => [b, { route: "none" }])), { routerCostUsd: 0.009 });

  await Promise.all(
    bodies.map((body) =>
      postAnalyze(request, [{ waMessageId: msgId(), body, authorPhone: "447700900008", authorName: "Tom Third" }]),
    ),
  );

  const u = (await usage(db))!;
  // cap + one hold + Σ max(0, cost − hold); the last term is 0 here.
  expect(Number(u.costUsd)).toBeLessThanOrEqual(cap + 0.01 + 1e-9);
  expect(Number(u.costUsd)).toBeCloseTo(u.calls * 0.009, 9);
  expect(Number(u.reservedUsd)).toBeCloseTo(0, 9);
  expect(u.calls).toBeGreaterThan(0);
  expect(u.calls).toBeLessThan(bodies.length);
  await setCap(db, null);
});
