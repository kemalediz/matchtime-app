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
import { readFileSync } from "node:fs";

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
const LAST_MOM = "@Match Time who was the last man of the match?";
const LAST_MOM_ANSWER = "Pat Player, picked by the organisers.";

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
     VALUES ($1, $2, $3, 10, $4, $5, $6, $7, false, now())`,
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
    // The players' group asks; the unified answer is stubbed, its context is real.
    [LAST_MOM]: { route: "question", facts: { ...NO, personRef: "", statedCount: -1, topic: "other", kind: "other", answer: LAST_MOM_ANSWER } },
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

// Kemal, 2026-11-16: the HQ pick is announced in the players' group, and
// claiming that post stores the name it gave. An organiser correcting the
// pick in HQ afterwards (setMatchMom deletes and recreates the row, so it is
// NEWER than the post) changes the rows, never that record. In an
// organisers' club the CORRECTION WINS (PR #608): "who was the last Man of
// the Match?" is told the latest pick, still as picked by the organisers.
test("the pick's announcement is stored when claimed; after a correction in HQ the answer tells the correction, as a pick", async ({ request, db }) => {
  await played(db, new Date(), { red: 4, yellow: 7 });
  // A finished match whose post-match flow runs, so the scheduler announces it.
  await db.run(`UPDATE "Match" SET "postMatchEndFlow" = true WHERE id = $1`, [MATCH_ID]);
  expect(await say(request, NAME_ONLY)).toMatchObject({ outcome: "hq-mom-saved", replyText: "Man of the Match: Riley Rater." });

  // The first civil-hours tick (09:00 to 21:00 London) from now.
  const londonHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const at = londonHour >= 9 && londonHour < 21 ? new Date() : londonHour < 9 ? londonAt(0, 9, 30) : londonAt(1, 9, 30);
  const key = `${MATCH_ID}:mom-announcement`;
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-test-now": at.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(200);
  const post = ((await res.json()).instructions as Array<Record<string, unknown>>).find((i) => i.key === key);
  expect(post?.text).toContain("Riley Rater");
  const stored = () => db.all<{ result: unknown }>(`SELECT result FROM "MoMAnnouncement" WHERE "matchId" = $1`, [MATCH_ID]);
  const RILEY = { v: 1, kind: "pick", winner: { userId: U.rater, name: "Riley Rater" } };
  expect((await stored()).map((r) => r.result)).toEqual([RILEY]);

  expect(await say(request, CHANGE)).toMatchObject({ outcome: "hq-mom-changed", replyText: "Man of the Match changed: Pat Player (it was Riley Rater)." });
  expect(await momRows(db)).toEqual([{ voterId: U.admin, playerId: U.player }]);
  expect((await stored()).map((r) => r.result)).toEqual([RILEY]);

  // The players' group asks (unified answer on by the test header).
  const msgId = `e2e-hqm-lastmom-${Date.now()}`;
  const asked = await request.post("/api/whatsapp/analyze", {
    headers: { ...KEY, "x-mt-test-unified-answers": "1" },
    data: {
      groupId: E2E.GROUP_ID,
      messages: [{ waMessageId: msgId, body: LAST_MOM, authorPhone: PLAYER, authorName: "Pat Player", botMentioned: true, timestamp: new Date().toISOString() }],
    },
  });
  expect(asked.status(), await asked.text()).toBe(200);
  expect(((await asked.json()).results as Array<{ waMessageId: string; reply?: string }>).find((x) => x.waMessageId === msgId)?.reply).toBe(LAST_MOM_ANSWER);
  const user = readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { label: string; user: string })
    .filter((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(LAST_MOM))
    .pop()!.user;
  const from = user.indexOf("LAST MAN OF THE MATCH");
  expect(from).toBeGreaterThan(-1);
  const end = user.indexOf("\n\n", from);
  const block = user.slice(from, end === -1 ? undefined : end);
  expect(block).toContain("Man of the Match: Pat Player, picked by the organisers. There was no vote");
  expect(block).not.toContain("Riley Rater");
  await db.run(`DELETE FROM "MoMAnnouncement" WHERE "matchId" = $1`, [MATCH_ID]);
});

test("a club whose players vote: the same message records the score only, exactly as before", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "momChosenBy" = 'players' WHERE id = $1`, [ORG_ID]);
  await played(db);
  expect(await say(request, BOTH)).toMatchObject({ outcome: "hq-score-saved", replyText: "Score saved: Yellow 7, Red 4.", react: "✅" });
  expect(await momRows(db)).toEqual([]);
  await db.run(`UPDATE "Organisation" SET "momChosenBy" = 'organisers' WHERE id = $1`, [ORG_ID]);
});
