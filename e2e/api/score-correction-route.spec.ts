/**
 * A tagged score correction reaches the score route through the REAL
 * analyze route (2026-10-07; since 2026-10-30, "no string parsing", the
 * ROUTER routes it).
 *
 * The 2026-10-07 live run had the router send "@Match Time other way
 * round" to `unsure`. Until 2026-10-30 a word test forced such messages
 * to `score` before the router ran. Now the router is shown, as a fact,
 * that a result is recorded and this sender may correct it, and its route
 * stands; here the router STUB routes as the model is expected to, the
 * extractor stub gives the facts the real extractor returned, and the
 * request goes through `/api/whatsapp/analyze` end to end. Whether the
 * real router does route these is the paid live check's.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn, selfOut } from "../helpers/stub";
import { ACTIVITY_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const MATCH_ID = "e2e-score-corr-match";
let n = 0;
const msgId = () => `e2e-score-corr-${Date.now()}-${++n}`;
const ADMIN = { authorPhone: "447700900001", authorName: "Alex Admin" };

/** A match of the e2e club played three hours ago, recorded Red 9, Yellow 6. */
async function playedAndRecorded(db: TestDb, red = 9, yellow = 6): Promise<void> {
  await db.run(`DELETE FROM "Match" WHERE id = $1`, [MATCH_ID]);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline",
                          "redScore", "yellowScore", "postMatchEndFlow", "updatedAt")
     VALUES ($1, $2, (now() AT TIME ZONE 'UTC') - interval '3 hours', 14, 'COMPLETED',
             (now() AT TIME ZONE 'UTC') - interval '4 hours', $3, $4, false, (now() AT TIME ZONE 'UTC'))`,
    [MATCH_ID, ACTIVITY_ID, red, yellow],
  );
}

const scoreOf = (db: TestDb) =>
  db.one<{ redScore: number | null; yellowScore: number | null }>(
    `SELECT "redScore", "yellowScore" FROM "Match" WHERE id = $1`,
    [MATCH_ID],
  );
const analyzed = (db: TestDb, id: string) =>
  db.one<{ handledBy: string; intent: string | null; action: string | null }>(
    `SELECT "handledBy", intent, action FROM "AnalyzedMessage" WHERE "waMessageId" = $1`,
    [id],
  );

const NO_SCORE = { hasScore: false, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "", loser: "", otherGame: false };

test.beforeAll(async () => {
  resetDb();
});

test.afterAll(async ({ db }) => {
  await db.run(`DELETE FROM "Match" WHERE id = $1`, [MATCH_ID]);
});

test('X2: "@Match Time other way round", routed score by the router (shown the RECORDED line), swaps the result', async ({ request, db }) => {
  await playedAndRecorded(db);
  const body = "@Match Time other way round";
  const id = msgId();
  engineOn({ [body]: { route: "score", facts: { ...NO_SCORE, correction: true, swapped: true } } });
  const res = await postAnalyze(request, [{ waMessageId: id, body, ...ADMIN }]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);

  expect(await scoreOf(db)).toEqual({ redScore: 6, yellowScore: 9 });
  expect(r.reply).toBe("Corrected 👍 It was Red 9 - 6 Yellow. Now *Yellow* won 9 - 6 against Red.");
  const row = await analyzed(db, id);
  expect(row?.handledBy).toBe("score-engine");
  expect(row?.action).toBe("score");

  // And the bare swap is used up: saying it again flips nothing back.
  const again = msgId();
  const res2 = await postAnalyze(request, [{ waMessageId: again, body, ...ADMIN }]);
  expect(await scoreOf(db)).toEqual({ redScore: 6, yellowScore: 9 });
  expect(res2.results.find((x: { waMessageId: string }) => x.waMessageId === again).reply).toContain(
    "That match is already recorded",
  );
});

test('T6: a correction with a scoreline, routed score by the router, corrects the result', async ({ request, db }) => {
  await playedAndRecorded(db);
  // The e2e club's teams are Red and Yellow, so the English form of T6.
  const body = "@Match Time wrong, red 6 yellow 9";
  const id = msgId();
  engineOn({
    [body]: {
      route: "score",
      facts: { ...NO_SCORE, hasScore: true, first: 6, second: 9, firstTeam: "red", secondTeam: "yellow", correction: true, swapped: false },
    },
  });
  const res = await postAnalyze(request, [{ waMessageId: id, body, ...ADMIN }]);
  expect(await scoreOf(db)).toEqual({ redScore: 6, yellowScore: 9 });
  expect(res.results.find((x: { waMessageId: string }) => x.waMessageId === id).reply).toMatch(/^Corrected 👍/);
  expect((await analyzed(db, id))?.handledBy).toBe("score-engine");
});

test('"@Match Time no, I\'m out" routed as attendance stays attendance: the result is untouched', async ({ request, db }) => {
  await playedAndRecorded(db);
  const body = "@Match Time no, I'm out";
  const id = msgId();
  engineOn({ [body]: { route: "self_att", facts: selfOut() } });
  await postAnalyze(request, [{ waMessageId: id, body, ...ADMIN }]);
  expect(await scoreOf(db)).toEqual({ redScore: 9, yellowScore: 6 });
  expect((await analyzed(db, id))?.handledBy).not.toBe("score-engine");
});

test("with NO recorded result in the window the router's route stands, and nothing is corrected", async ({ request, db }) => {
  await db.run(`DELETE FROM "Match" WHERE id = $1`, [MATCH_ID]);
  const body = "@Match Time other way round";
  const id = msgId();
  engineOn({ [body]: { route: "unsure", facts: { ...NO_SCORE, correction: true, swapped: true } } });
  await postAnalyze(request, [{ waMessageId: id, body, ...ADMIN }]);
  expect((await analyzed(db, id))?.handledBy).not.toBe("score-engine");
});
