/**
 * MAN OF THE MATCH PICKED BY THE ORGANISERS (2026-10-18), against a real
 * Postgres and the real routes. The club's setting is "organisers pick"
 * (`Organisation.momChosenBy`). The router and the score extractor are
 * STUBBED (what the models would have said); everything after is shipped
 * code: the HQ door, the shared score batch and engine, the score writer,
 * the name resolution against the match's players and `setMatchMom`.
 *
 * The fixture club (E2E Test FC, teams Red and Yellow) gets a match played
 * three hours ago with no result and four players: Pat Player, Riley
 * Rater, Omar One and Omar Two. Alex Admin is the OWNER; Pat Player is not
 * an organiser.
 */
import { test, expect, resetDb } from "../fixtures";
import { ACTIVITY_ID, ORG_ID, PHONE, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000062@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");
const MATCH_ID = "e2e-hq-mom-match";

const NO = { hasScore: false, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "", loser: "", momRef: "", correction: false, swapped: false, otherGame: false };
const BOTH = "Yellow won 7-4, MoM Pat";
const SCORE_ONLY = "Yellow won 7-4";
const NAME_ONLY = "MoM was Riley";
const AMBIGUOUS = "MoM Omar";
const ANSWER = "Omar One";
const STRANGER = "MoM Zed";
const CHANGE = "sorry, MoM was Pat";

let seq = 0;
async function say(request: APIRequestContext, text: string, senderPhone = ADMIN, quoted?: { text: string; fromMatchTime: boolean }) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: {
      channel: "admin-group",
      botMentioned: true,
      groupId: HQ,
      messageId: `e2e-hqm-${++seq}`,
      text,
      senderPhone,
      timestamp: String(Math.floor(Date.now() / 1000)),
      ...(quoted ? { quotedText: quoted.text, quotedFromMatchTime: quoted.fromMatchTime } : {}),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** A match that kicked off three hours before `at`, no result, four players. */
async function played(db: TestDb, at = new Date(), score: { red: number; yellow: number } | null = null): Promise<void> {
  await db.run(`DELETE FROM "SentNotification" WHERE "matchId" = $1`, [MATCH_ID]);
  await db.run(`DELETE FROM "AdminGroupMessage" WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(`DELETE FROM "Match" WHERE id = $1`, [MATCH_ID]);
  const kickoff = new Date(at.getTime() - 3 * 60 * 60 * 1000);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline",
                          "redScore", "yellowScore", "postMatchEndFlow", "updatedAt")
     VALUES ($1, $2, $3, 14, $4, $5, $6, $7, false, now())`,
    [MATCH_ID, ACTIVITY_ID, kickoff, score ? "COMPLETED" : "TEAMS_PUBLISHED", new Date(kickoff.getTime() - 60 * 60 * 1000), score?.red ?? null, score?.yellow ?? null],
  );
  let pos = 0;
  for (const u of [U.player, U.rater, U.omar1, U.omar2]) {
    await db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', $4, now())`,
      [`e2e-hqm-att-${u}`, MATCH_ID, u, ++pos],
    );
  }
}

const scoreOf = (db: TestDb) =>
  db.one<{ redScore: number | null; yellowScore: number | null }>(`SELECT "redScore", "yellowScore" FROM "Match" WHERE id = $1`, [MATCH_ID]);
const momRows = (db: TestDb) =>
  db.all<{ voterId: string; playerId: string }>(`SELECT "voterId", "playerId" FROM "MoMVote" WHERE "matchId" = $1`, [MATCH_ID]);

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "momChosenBy" = 'organisers' WHERE id = $1`, [ORG_ID, HQ]);
  engineOn({
    [BOTH]: { route: "score", facts: { ...NO, hasScore: true, first: 7, second: 4, winner: "Yellow", momRef: "Pat" } },
    [SCORE_ONLY]: { route: "score", facts: { ...NO, hasScore: true, first: 7, second: 4, winner: "Yellow" } },
    [NAME_ONLY]: { route: "score", facts: { ...NO, momRef: "Riley" } },
    [AMBIGUOUS]: { route: "score", facts: { ...NO, momRef: "Omar" } },
    // The router calls the bare name an attendance change; quoting the question makes it the answer.
    [ANSWER]: { route: "other_att", facts: { ...NO, momRef: "Omar One" } },
    [STRANGER]: { route: "score", facts: { ...NO, momRef: "Zed" } },
    [CHANGE]: { route: "score", facts: { ...NO, momRef: "Pat" } },
  });
});

test.afterAll(async ({ db }) => {
  clearPipelineStubs();
  await db.run(`DELETE FROM "SentNotification" WHERE "matchId" = $1`, [MATCH_ID]);
  await db.run(`DELETE FROM "Match" WHERE id = $1`, [MATCH_ID]);
  resetDb();
});

test('"Yellow won 7-4, MoM Pat": the score and Man of the Match recorded, a tick, one reply', async ({ request, db }) => {
  await played(db);
  expect(await say(request, BOTH)).toMatchObject({
    handled: true,
    outcome: "hq-score-saved",
    replyText: "Score saved: Yellow 7, Red 4. Man of the Match: Pat Player.",
    react: "✅",
  });
  expect(await scoreOf(db)).toEqual({ redScore: 4, yellowScore: 7 });
  // The same row a vote writes: one MoMVote, so every MoM reader names Pat.
  expect(await momRows(db)).toEqual([{ voterId: U.admin, playerId: U.player }]);
});

test("the score alone asks once for Man of the Match; the name in a later message records it", async ({ request, db }) => {
  await played(db);
  expect(await say(request, SCORE_ONLY)).toMatchObject({
    outcome: "hq-score-saved",
    replyText: "Score saved: Yellow 7, Red 4. Who was Man of the Match?",
    react: "✅",
  });
  expect(await momRows(db)).toEqual([]);
  expect(await say(request, NAME_ONLY)).toMatchObject({ outcome: "hq-mom-saved", replyText: "Man of the Match: Riley Rater.", react: "✅" });
  expect(await momRows(db)).toEqual([{ voterId: U.admin, playerId: U.rater }]);
  // Changed by an organiser: the one row is replaced.
  expect(await say(request, CHANGE)).toMatchObject({ outcome: "hq-mom-changed", replyText: "Man of the Match changed: Pat Player (it was Riley Rater).", react: "✅" });
  expect(await momRows(db)).toEqual([{ voterId: U.admin, playerId: U.player }]);
});

test("an unclear name is asked about once; a reply quoting the question answers it", async ({ request, db }) => {
  await played(db, new Date(), { red: 4, yellow: 7 });
  const asked = await say(request, AMBIGUOUS);
  expect(asked).toMatchObject({ outcome: "hq-mom-asked", replyText: "Which Omar was Man of the Match: Omar One or Omar Two?", react: null });
  expect(await momRows(db)).toEqual([]);
  expect(await say(request, ANSWER, ADMIN, { text: asked.replyText, fromMatchTime: true })).toMatchObject({
    outcome: "hq-mom-saved",
    replyText: "Man of the Match: Omar One.",
    react: "✅",
  });
  expect(await momRows(db)).toEqual([{ voterId: U.admin, playerId: U.omar1 }]);
});

test("a name that is not one of the match's players: asked, nothing written", async ({ request, db }) => {
  await played(db, new Date(), { red: 4, yellow: 7 });
  expect(await say(request, STRANGER)).toMatchObject({
    outcome: "hq-mom-asked",
    replyText: "I can't find Zed among the players of that match. Who was Man of the Match?",
    react: null,
  });
  expect(await momRows(db)).toEqual([]);
});

test("someone who is not an owner or admin cannot set Man of the Match", async ({ request, db }) => {
  await played(db);
  expect(await say(request, BOTH, PLAYER)).toMatchObject({
    outcome: "hq-score-saved",
    replyText: "Score saved: Yellow 7, Red 4. Only the organisers can set Man of the Match.",
  });
  expect(await momRows(db)).toEqual([]);
});

test('the HQ score ask asks for Man of the Match too: "who was Man of the Match?"', async ({ request, db }) => {
  const at = londonAt(0, 14, 0);
  await played(db, at);
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-no-claim": "1", "x-test-now": at.toISOString(), "x-mt-pi-caps": "admin-group" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const ask = ((await res.json()).instructions as Array<Record<string, unknown>>).filter((i) => i.key === `${MATCH_ID}:ask-score`);
  expect(ask).toHaveLength(1);
  expect(ask[0]).toMatchObject({
    kind: "admin-group-message",
    groupId: HQ,
    text: "🏁 *E2E 5-a-side*: what was the final score, which team won, and who was Man of the Match? Tag me here with it and I'll record it. To tag me, type *@* and pick *Match Time* from the list.",
  });
});

test("a club whose players vote: the same message records the score only, exactly as before", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "momChosenBy" = 'players' WHERE id = $1`, [ORG_ID]);
  await played(db);
  expect(await say(request, BOTH)).toMatchObject({ outcome: "hq-score-saved", replyText: "Score saved: Yellow 7, Red 4.", react: "✅" });
  expect(await momRows(db)).toEqual([]);
  await db.run(`UPDATE "Organisation" SET "momChosenBy" = 'organisers' WHERE id = $1`, [ORG_ID]);
});
