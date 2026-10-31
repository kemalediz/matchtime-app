/**
 * THE MATCH SCORE IN THE ADMIN GROUP (2026-10-16), against a real Postgres
 * and the real routes. The router and the score extractor are STUBBED
 * (`engineOn`: what the models would have said); everything after is the
 * shipped code: the HQ door, the shared score batch and engine, the score
 * writer and Elo, and due-posts for the "what was the final score?" ask.
 *
 * The fixture club (E2E Test FC, teams Red and Yellow) gets a match played
 * three hours ago with no result. Alex Admin is the OWNER; Pat Player is
 * not an organiser.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { ACTIVITY_ID, ORG_ID, PHONE, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000061@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");
const MATCH_ID = "e2e-hq-score-match";

const NO = { hasScore: false, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "", loser: "", correction: false, swapped: false, otherGame: false };
const WON = "Yellow won 7-4";
const UNCLEAR = "7-4 or 7-5, not sure";
const ANSWER = "7-4, Yellow won";
const BARE = "7-4";
const CORRECT = "@Match Time no, it was 7-5 to yellow";

let seq = 0;
async function say(request: APIRequestContext, text: string, senderPhone = ADMIN) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId: `e2e-hqs-${++seq}`, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** A match of the club that kicked off three hours before `at`, with no result (or the one given). */
async function played(db: TestDb, at = new Date(), score: { red: number; yellow: number } | null = null): Promise<void> {
  await db.run(`DELETE FROM "SentNotification" WHERE "matchId" = $1`, [MATCH_ID]);
  await db.run(`DELETE FROM "Match" WHERE id = $1`, [MATCH_ID]);
  const kickoff = new Date(at.getTime() - 3 * 60 * 60 * 1000);
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline",
                          "redScore", "yellowScore", "postMatchEndFlow", "updatedAt")
     VALUES ($1, $2, $3, 14, $4, $5, $6, $7, false, now())`,
    [MATCH_ID, ACTIVITY_ID, kickoff, score ? "COMPLETED" : "TEAMS_PUBLISHED", new Date(kickoff.getTime() - 60 * 60 * 1000), score?.red ?? null, score?.yellow ?? null],
  );
}

const scoreOf = (db: TestDb) =>
  db.one<{ redScore: number | null; yellowScore: number | null; status: string }>(
    `SELECT "redScore", "yellowScore", status FROM "Match" WHERE id = $1`,
    [MATCH_ID],
  );

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  engineOn({
    [WON]: { route: "score", facts: { ...NO, hasScore: true, first: 7, second: 4, winner: "Yellow" } },
    // Two possible results: the score extractor (a model) reads no one result
    // (as the live one did, 2026-10-30). No code counts the scorelines.
    [UNCLEAR]: { route: "score", facts: { ...NO } },
    [ANSWER]: { route: "score", facts: { ...NO, hasScore: true, first: 7, second: 4, winner: "Yellow" } },
    [BARE]: { route: "score", facts: { ...NO, hasScore: true, first: 7, second: 4 } },
    // A bare "Yellow" while "which team won?" is open: the router, shown
    // that WAITING line, reads it as the answer (2026-10-30: no code
    // override from the words; checked live once on the dev key).
    Yellow: { route: "score", facts: { ...NO, winner: "Yellow" } },
    [CORRECT]: { route: "score", facts: { ...NO, hasScore: true, first: 7, second: 5, winner: "yellow", correction: true } },
  });
});

test.afterAll(async ({ db }) => {
  clearPipelineStubs();
  await db.run(`DELETE FROM "SentNotification" WHERE "matchId" = $1`, [MATCH_ID]);
  await db.run(`DELETE FROM "Match" WHERE id = $1`, [MATCH_ID]);
  resetDb();
});

test('HQ "Yellow won 7-4": recorded through the shared score handling, a tick, "Score saved: Yellow 7, Red 4."', async ({ request, db }) => {
  await played(db);
  expect(await say(request, WON)).toMatchObject({ handled: true, outcome: "hq-score-saved", replyText: "Score saved: Yellow 7, Red 4.", react: "✅" });
  expect(await scoreOf(db)).toEqual({ redScore: 4, yellowScore: 7, status: "COMPLETED" });
});

test('"7-4 or 7-5": one short question, nothing recorded; the answer records it', async ({ request, db }) => {
  await played(db);
  expect(await say(request, UNCLEAR)).toMatchObject({
    handled: true,
    outcome: "hq-score-asked",
    replyText: "I can't tell the final score from that. What was it, and which team won?",
    react: null,
  });
  expect(await scoreOf(db)).toMatchObject({ redScore: null, yellowScore: null });
  expect(await say(request, ANSWER)).toMatchObject({ outcome: "hq-score-saved", replyText: "Score saved: Yellow 7, Red 4." });
  expect(await scoreOf(db)).toMatchObject({ redScore: 4, yellowScore: 7 });
});

test('"7-4" with no team: "which team won?"; the organiser\'s next message "Yellow" records it', async ({ request, db }) => {
  await played(db);
  expect(await say(request, BARE)).toMatchObject({
    outcome: "hq-score-asked",
    replyText: "7 - 4: which team won? Reply with the winning team: Red or Yellow.",
    react: null,
  });
  expect(await scoreOf(db)).toMatchObject({ redScore: null, yellowScore: null });
  expect(await say(request, "Yellow")).toMatchObject({ outcome: "hq-score-saved", replyText: "Score saved: Yellow 7, Red 4.", react: "✅" });
  expect(await scoreOf(db)).toMatchObject({ redScore: 4, yellowScore: 7 });
});

test("a recorded score: anyone else cannot change it; an owner can", async ({ request, db }) => {
  await played(db, new Date(), { red: 4, yellow: 7 });
  expect(await say(request, CORRECT, PLAYER)).toMatchObject({ outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null });
  expect(await scoreOf(db)).toMatchObject({ redScore: 4, yellowScore: 7 });
  expect(await say(request, CORRECT)).toMatchObject({
    outcome: "hq-score-changed",
    replyText: "Score changed: Yellow 7, Red 5 (it was Yellow 7, Red 4).",
    react: "✅",
  });
  expect(await scoreOf(db)).toMatchObject({ redScore: 5, yellowScore: 7 });
});

test("the players' group still records a score reply, for an admin-group club too", async ({ request, db }) => {
  await played(db);
  const id = `e2e-hqs-pg-${Date.now()}`;
  const res = await postAnalyze(request, [{ waMessageId: id, body: WON, authorPhone: ADMIN, authorName: "Alex Admin" }]);
  expect(res.results.find((x: { waMessageId: string }) => x.waMessageId === id).reply).toBe("Got it 👍 *Yellow* won 7 - 4 against Red. Recorded.");
  expect(await scoreOf(db)).toMatchObject({ redScore: 4, yellowScore: 7 });
});

test('"what was the final score?" goes to HQ for an admin-group club, the players\' group otherwise, under the same key', async ({ request, db }) => {
  const at = londonAt(0, 14, 0);
  await played(db, at);
  const poll = async () => {
    const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
      headers: { ...KEY, "x-no-claim": "1", "x-test-now": at.toISOString(), "x-mt-pi-caps": "admin-group" },
    });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()).instructions as Array<Record<string, unknown>>).filter((i) => i.key === `${MATCH_ID}:ask-score`);
  };

  const hq = await poll();
  expect(hq).toHaveLength(1);
  expect(hq[0]).toMatchObject({
    kind: "admin-group-message",
    groupId: HQ,
    text: "🏁 *E2E 5-a-side*: what was the final score, and which team won? Tag me here with it and I'll record it. To tag me, type *@* and pick *Match Time* from the list.",
  });

  await db.run(`UPDATE "Organisation" SET "adminChannelMode" = 'each-admin' WHERE id = $1`, [ORG_ID]);
  const pg = await poll();
  await db.run(`UPDATE "Organisation" SET "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID]);
  expect(pg).toHaveLength(1);
  expect(pg[0]).toMatchObject({ kind: "group-message" });
  expect(String(pg[0].text)).toContain("What was the final score?");
});
