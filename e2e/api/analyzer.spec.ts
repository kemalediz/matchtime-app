/**
 * Analyzer apply-path integration tests — /api/whatsapp/analyze.
 *
 * The LLM is STUBBED (MT_TEST_LLM_STUB_FILE): each test writes the
 * verdict it wants the "LLM" to return, POSTs a batch the way the Pi
 * bot does, and asserts the deterministic server-side apply path via
 * direct DB reads. No Anthropic call, no WhatsApp send (BotJobs are
 * just rows).
 *
 * Tests are serial and share cumulative state on the UPCOMING match:
 *   start    4/5 confirmed (admin, collector, player, third) + Ben on bench
 *   T1 IN    Ian "in"             → CONFIRMED (5/5)
 *   T2 IN    Zara "in" while full → BENCH
 *   T3 OUT   Pat drops            → DROPPED + open BenchSlotOffer
 *   T4 BENCH admin demotes Tom (registerFor BENCH) → BENCH, slot freed
 *   T5 net   reply says "Ian Innes has moved to the bench", NO
 *            registerFor → safety net still demotes Ian
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { setLlmStub } from "../helpers/stub";
import { U, MATCH } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let n = 0;
const msgId = () => `e2e-analyzer-${Date.now()}-${++n}`;

interface AttendanceRow {
  status: string;
  userId: string;
}

const attendance = (db: TestDb, userId: string) =>
  db.one<AttendanceRow>(
    `SELECT * FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, userId],
  );

const confirmedCount = (db: TestDb) =>
  db.count(
    `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`,
    [MATCH.upcoming],
  );

test("IN verdict registers the sender as CONFIRMED", async ({ request, db }) => {
  const id = msgId();
  setLlmStub({
    [id]: { intent: "in", registerAttendance: "IN", react: "👍", confidence: 0.95, reasoning: "stub" },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "Count me in for Tuesday lads", authorPhone: "447700900009", authorName: "Ian Innes" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.handledBy).toBe("llm");
  expect(r.react).toBe("✅"); // server recomputes the react from the real slot

  const att = await attendance(db, U.fresh);
  expect(att?.status).toBe("CONFIRMED");
});

test("IN on a full squad lands on the BENCH", async ({ request, db }) => {
  const id = msgId();
  setLlmStub({
    [id]: { intent: "in", registerAttendance: "IN", react: "👍", confidence: 0.95, reasoning: "stub" },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "in for tuesday too", authorPhone: "447700900010", authorName: "Zara Zest" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.react).toBe("🪑");

  const att = await attendance(db, U.extra);
  expect(att?.status).toBe("BENCH");
  expect(await confirmedCount(db)).toBe(5); // capacity respected
});

test("OUT verdict drops the sender and opens a bench-slot offer", async ({ request, db }) => {
  const id = msgId();
  setLlmStub({
    [id]: { intent: "out", registerAttendance: "OUT", react: "👋", confidence: 0.95, reasoning: "stub" },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "Sorry lads, something came up tonight, count me out", authorPhone: "447700900003", authorName: "Pat Player" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.react).toBe("👋");

  const att = await attendance(db, U.player);
  expect(att?.status).toBe("DROPPED");

  // Slot freed + bench non-empty → an OPEN BenchSlotOffer for Pat's slot.
  const offer = await db.one(
    `SELECT * FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL AND "replacingUserId" = $2`,
    [MATCH.upcoming, U.player],
  );
  expect(offer).not.toBeNull();
});

test("third-party BENCH demote: CONFIRMED → BENCH, slot freed, no duplicate", async ({ request, db }) => {
  const before = await confirmedCount(db);
  const id = msgId();
  setLlmStub({
    [id]: {
      intent: "question",
      registerFor: [{ name: "Tom Third", action: "BENCH" }],
      reply: "Done — Tom Third has moved to the bench. A confirmed slot is open.",
      react: "✅",
      confidence: 0.95,
      reasoning: "stub: admin demote",
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "Move Tom to the bench please", authorPhone: "447700900001", authorName: "Alex Admin" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.react).toBe("🪑");
  // Safety net must NOT double-announce when registerFor already carries
  // the BENCH entry — the reply passes through exactly once, unmodified.
  expect(r.reply).toContain("Tom Third has moved to the bench");

  const att = await attendance(db, U.third);
  expect(att?.status).toBe("BENCH");
  // Exactly one attendance row for Tom (no duplicate registration).
  const tomRows = await db.count(
    `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, U.third],
  );
  expect(tomRows).toBe(1);
  // Slot freed: confirmed count went DOWN by one.
  expect(await confirmedCount(db)).toBe(before - 1);
  // A demote (unlike a drop) must NOT open a bench-slot offer for Tom.
  const offer = await db.one(
    `SELECT * FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL AND "replacingUserId" = $2`,
    [MATCH.upcoming, U.third],
  );
  expect(offer).toBeNull();
});

test("bench-demote SAFETY NET: reply claims the move but registerFor is empty → server still demotes", async ({ request, db }) => {
  // Ian is CONFIRMED (from T1). The stubbed verdict ANNOUNCES his demote
  // in the reply but — like the Salman Shelly incident — emits no
  // registerFor. The route must synthesise the BENCH entry itself.
  const pre = await attendance(db, U.fresh);
  expect(pre?.status).toBe("CONFIRMED");

  const id = msgId();
  setLlmStub({
    [id]: {
      intent: "question",
      registerFor: null,
      reply: "Ian Innes has moved to the bench 👍 A confirmed slot is open.",
      react: "✅",
      confidence: 0.9,
      reasoning: "stub: announce without write",
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "Can you put Ian on the bench for now", authorPhone: "447700900001", authorName: "Alex Admin" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.react).toBe("🪑");

  const att = await attendance(db, U.fresh);
  expect(att?.status).toBe("BENCH");
});

test("duplicate waMessageId is deduped (bot retry safety)", async ({ request }) => {
  const id = msgId();
  setLlmStub({
    [id]: { intent: "noise", react: null, reply: null, confidence: 1, reasoning: "stub" },
  });
  const body = { waMessageId: id, body: "noise message", authorPhone: "447700900001", authorName: "Alex Admin" as string | null };
  await postAnalyze(request, [body]);
  const second = await postAnalyze(request, [body]);
  const r = second.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.handledBy).toBe("deduped");
});
