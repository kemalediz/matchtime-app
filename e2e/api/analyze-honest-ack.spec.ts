/**
 * Honest ack on the GROUP path — /api/whatsapp/analyze.
 *
 * The bug: the attendance write was wrapped in a bare try/catch, so a
 * thrown write was swallowed and the LLM's cheerful "you're in!" went
 * out anyway. The player turns up believing they're playing; no squad
 * row exists; nothing surfaces anywhere.
 *
 * How a failure is simulated WITHOUT a test-only hook in production
 * code: a Postgres BEFORE-trigger on "Attendance" that raises for the
 * targeted userId. That is exactly what a real DB failure looks like
 * from Prisma's side — the write throws.
 *
 * The other half of the contract, tested just as hard: a legitimate
 * no-op must NOT produce an apology. An OUT from someone who was never
 * down, and a repeat IN from a confirmed player, are both normal.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { setLlmStub } from "../helpers/stub";
import { U, MATCH } from "../helpers/constants";
import { testDb, type TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

let n = 0;
const msgId = () => `e2e-honest-ack-${Date.now()}-${++n}`;

/** Make every Attendance write for these users throw, like a DB fault. */
async function blockAttendanceWrites(db: TestDb, userIds: string[]): Promise<void> {
  const list = userIds.map((u) => `'${u}'`).join(", ");
  await db.run(`
    CREATE OR REPLACE FUNCTION mt_e2e_block_attendance() RETURNS trigger AS $fn$
    DECLARE uid text;
    BEGIN
      IF TG_OP = 'DELETE' THEN uid := OLD."userId"; ELSE uid := NEW."userId"; END IF;
      IF uid IN (${list}) THEN
        RAISE EXCEPTION 'simulated attendance write failure for %', uid;
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END; $fn$ LANGUAGE plpgsql;`);
  await db.run(`DROP TRIGGER IF EXISTS mt_e2e_block_attendance_trg ON "Attendance"`);
  await db.run(`
    CREATE TRIGGER mt_e2e_block_attendance_trg
    BEFORE INSERT OR UPDATE OR DELETE ON "Attendance"
    FOR EACH ROW EXECUTE FUNCTION mt_e2e_block_attendance()`);
}

async function unblockAttendanceWrites(db: TestDb): Promise<void> {
  await db.run(`DROP TRIGGER IF EXISTS mt_e2e_block_attendance_trg ON "Attendance"`);
}

interface AnalyzedRow {
  handledBy: string;
  action: string | null;
  intent: string | null;
}

const analyzed = (db: TestDb, waMessageId: string) =>
  db.one<AnalyzedRow>(`SELECT * FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [waMessageId]);

const attendanceRow = (db: TestDb, userId: string) =>
  db.one<{ status: string }>(
    `SELECT * FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, userId],
  );

const confirmedCount = (db: TestDb) =>
  db.count(
    `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`,
    [MATCH.upcoming],
  );

const CHEERFUL = "You're in Ian! Squad's looking good 💪";

test.beforeAll(async () => {
  resetDb();
});

test.afterAll(async () => {
  // Belt and braces: never leave the trigger behind for later specs.
  await unblockAttendanceWrites(testDb());
});

test("a FAILED IN write never gets a cheerful confirmation", async ({ request, db }) => {
  await blockAttendanceWrites(db, [U.fresh]);
  const id = msgId();
  setLlmStub({
    [id]: {
      intent: "in",
      registerAttendance: "IN",
      react: "👍",
      reply: CHEERFUL,
      confidence: 0.96,
      reasoning: "stub",
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "im in for tuesday", authorPhone: "447700900009", authorName: "Ian Innes" },
  ]);
  await unblockAttendanceWrites(db);

  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);

  // 1. Nothing landed.
  expect(await attendanceRow(db, U.fresh)).toBeNull();

  // 2. So we must NOT claim it did — no cheerful text, no ✅ tick.
  expect(r.reply ?? "").not.toContain("You're in");
  expect(r.react).toBeNull();

  // 3. We say something TRUE and useful instead.
  expect(r.reply).toBeTruthy();
  expect(r.reply).toContain("not on the list");
  expect(r.reply).not.toContain("—");
  expect(r.reply).not.toContain("/");

  // 4. The stored record reflects what HAPPENED, not what was intended.
  expect(r.handledBy).toBe("error");
  const row = await analyzed(db, id);
  expect(row?.handledBy).toBe("error");
  expect(row?.action).toContain("attendance-failed");
  expect(row?.action).not.toBe("IN");
});

test("a FAILED OUT write tells them they are still down as playing", async ({ request, db }) => {
  await blockAttendanceWrites(db, [U.player]);
  const id = msgId();
  setLlmStub({
    [id]: {
      intent: "out",
      registerAttendance: "OUT",
      react: "👋",
      reply: "No worries Pat, you're out. Squad is 3/5 now.",
      confidence: 0.95,
      reasoning: "stub",
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "cant make tuesday sorry", authorPhone: "447700900003", authorName: "Pat Player" },
  ]);
  await unblockAttendanceWrites(db);

  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect((await attendanceRow(db, U.player))?.status).toBe("CONFIRMED"); // still playing
  expect(r.react).toBeNull();
  expect(r.reply).toContain("still down as playing");
  expect(r.handledBy).toBe("error");
  const row = await analyzed(db, id);
  expect(row?.action).toContain("attendance-failed:OUT");
});

test("a SUCCESSFUL IN is completely unchanged", async ({ request, db }) => {
  const id = msgId();
  setLlmStub({
    [id]: {
      intent: "in",
      registerAttendance: "IN",
      react: "👍",
      reply: CHEERFUL,
      confidence: 0.96,
      reasoning: "stub",
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "im in for tuesday", authorPhone: "447700900009", authorName: "Ian Innes" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);

  expect((await attendanceRow(db, U.fresh))?.status).toBe("CONFIRMED");
  expect(r.react).toBe("✅"); // server recomputes from the real slot
  expect(r.handledBy).toBe("llm");
  expect(r.reply ?? "").not.toContain("Sorry");
  const row = await analyzed(db, id);
  expect(row?.handledBy).toBe("llm");
  expect(row?.action).toBe("IN");
});

test("an OUT from someone with no row is a legitimate no-op, not a failure", async ({ request, db }) => {
  const id = msgId();
  expect(await attendanceRow(db, U.extra)).toBeNull(); // Zara was never down
  setLlmStub({
    [id]: {
      intent: "out",
      registerAttendance: "OUT",
      react: "👋",
      reply: "No worries Zara, squad is 4/5 now.",
      confidence: 0.9,
      reasoning: "stub",
    },
  });
  const before = await confirmedCount(db);
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "im out lads", authorPhone: "447700900010", authorName: "Zara Zest" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);

  expect(r.handledBy).toBe("llm"); // NOT "error"
  expect(r.react).toBeNull();
  expect(r.reply).toBeNull(); // silent, and above all NOT an apology
  expect(await confirmedCount(db)).toBe(before);
  const row = await analyzed(db, id);
  expect(row?.action).not.toContain("attendance-failed");
});

test("a repeat IN from an already-confirmed player is idempotent, not a failure", async ({ request, db }) => {
  const id = msgId();
  const before = await confirmedCount(db);
  setLlmStub({
    [id]: {
      intent: "in",
      registerAttendance: "IN",
      react: "👍",
      reply: "Already got you down Ian 👍",
      confidence: 0.9,
      reasoning: "stub",
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "in again", authorPhone: "447700900009", authorName: "Ian Innes" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);

  expect(r.handledBy).toBe("llm");
  expect(r.react).toBe("✅");
  expect(r.reply ?? "").not.toContain("Sorry");
  expect(await confirmedCount(db)).toBe(before); // no duplicate
  expect(
    await db.count(
      `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
      [MATCH.upcoming, U.fresh],
    ),
  ).toBe(1);
});

test("a FAILED third-party registration is not confirmed either", async ({ request, db }) => {
  await blockAttendanceWrites(db, [U.extra]);
  const id = msgId();
  setLlmStub({
    [id]: {
      intent: "in",
      registerAttendance: null,
      registerFor: [{ name: "Zara Zest", action: "IN" }],
      react: "👍",
      reply: "Zara's in 👍",
      confidence: 0.9,
      reasoning: "stub",
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "zara is in as well", authorPhone: "447700900001", authorName: "Alex Admin" },
  ]);
  await unblockAttendanceWrites(db);

  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(await attendanceRow(db, U.extra)).toBeNull();
  expect(r.react).toBeNull();
  expect(r.reply ?? "").not.toContain("Zara's in");
  expect(r.reply).toContain("Zara");
  expect(r.handledBy).toBe("error");
});
