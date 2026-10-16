/**
 * ANYONE IN THE ADMIN GROUP CAN ASK (2026-10-16), against a real Postgres
 * and the real route. Kemal: "Anyone in that group should be able to ask
 * questions." FNF HQ, 15:13 London: Kemal, a PLAYER of FNF, asked "Who are
 * are admins?" and got nothing, and his row in AdminGroupMessage had no
 * sender, because only an owner's or admin's membership was ever looked up.
 *
 * The shared router and extractors are STUBBED (what the models would have
 * said); everything after them is the shipped code. The fixture club (E2E
 * Test FC, weekly) plays TODAY at 22:00 London here, 2-a-side: Alex Admin
 * (OWNER, its only organiser), Colin Collector, Pat Player, Tom Third; Ben
 * Bench on the bench.
 *
 * Pinned: a question from a non-member and from a non-admin member is
 * answered, with the tick; a non-admin's tagged swap is not done and gets
 * one line naming who can (EN and TR), no tick; a non-admin's chat is
 * silent; the same swap from the admin is done.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, SPORT_ID, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, engineOn, teamsFacts } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000063@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");
/** Nobody MatchTime knows. */
const STRANGER = "447700900999";
const KICKOFF = londonAt(0, 22, 0);

const ADMINS_Q = "Who are are admins?";
const BENCH_Q = "MatchTime who's on the bench?";
const CHAT = "who is bringing the bibs?";

/** The question extractor's raw answer. */
const q = (topic: string) => ({
  route: "question",
  facts: { topic, personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none" },
});

let seq = 0;
async function say(request: APIRequestContext, text: string, senderPhone: string) {
  const messageId = `e2e-aga-${++seq}`;
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return { messageId, ...(await res.json()) };
}

const sheet = (db: TestDb) =>
  db.all<{ userId: string; team: string }>(`SELECT "userId", team::text AS team FROM "TeamAssignment" WHERE "matchId" = $1 ORDER BY id`, [MATCH.upcoming]);
const userName = async (db: TestDb, id: string) => (await db.one<{ name: string }>(`SELECT name FROM "User" WHERE id = $1`, [id]))!.name;

let swapText = "";

test.beforeAll(async ({ db, request }) => {
  resetDb();
  await db.run(
    `UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "teamsReadyTime" = NULL, "listAnnouncer" = 'organisers' WHERE id = $1`,
    [ORG_ID, HQ],
  );
  await db.run(`UPDATE "Sport" SET "playersPerTeam" = 2 WHERE id = $1`, [SPORT_ID]);
  await db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $3 WHERE id = $1`, [
    MATCH.upcoming,
    KICKOFF.toISOString(),
    new Date(KICKOFF.getTime() - 5 * 60 * 60 * 1000).toISOString(),
  ]);
  // The teams, proposed in HQ at 10:00 by the real due-posts poll.
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-test-now": londonAt(0, 10, 5).toISOString(), "x-mt-pi-caps": "admin-group" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const rows = await sheet(db);
  expect(rows).toHaveLength(4);
  const a = await userName(db, rows.find((r) => r.team === "RED")!.userId);
  const b = await userName(db, rows.find((r) => r.team === "YELLOW")!.userId);
  swapText = `@Match Time swap ${a} with ${b}`;
  engineOn({
    [ADMINS_Q]: q("club"),
    [BENCH_Q]: q("bench"),
    [swapText]: { route: "balancer", facts: teamsFacts("swap", [a, b]) },
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("the incident: a player of the club asks who the admins are, answered with a tick, and recorded as who sent it", async ({ request, db }) => {
  const out = await say(request, ADMINS_Q, PLAYER);
  expect(out).toMatchObject({ handled: true, outcome: "hq-answered", react: "✅" });
  expect(out.replyText).toContain("👥 Admins: Alex Admin");
  const row = await db.one<{ s: string | null }>(`SELECT "senderUserId" AS s FROM "AdminGroupMessage" WHERE "waMessageId" = $1`, [out.messageId]);
  expect(row?.s).toBe(U.player);
});

test("someone who is not in the club at all: answered too", async ({ request, db }) => {
  const out = await say(request, BENCH_Q, STRANGER);
  expect(out).toMatchObject({ handled: true, outcome: "hq-answered", react: "✅" });
  expect(out.replyText).toContain("Ben Bench");
  const row = await db.one<{ s: string | null }>(`SELECT "senderUserId" AS s FROM "AdminGroupMessage" WHERE "waMessageId" = $1`, [out.messageId]);
  expect(row?.s).toBeNull();
});

test("a player's tagged swap: not done, one line naming who can, no tick", async ({ request, db }) => {
  const before = await sheet(db);
  const out = await say(request, swapText, PLAYER);
  expect(out).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null });
  expect(await sheet(db)).toEqual(before);
});

test("in Turkish", async ({ request, db }) => {
  const before = await sheet(db);
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const out = await say(request, swapText, STRANGER);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  expect(out).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Bunu yalnızca Alex değiştirebilir.", react: null });
  expect(await sheet(db)).toEqual(before);
});

test("a player's chat between the organisers: silent", async ({ request }) => {
  expect(await say(request, CHAT, PLAYER)).toMatchObject({ handled: false, replyText: null });
});

test("the admin: the same swap is done, as before", async ({ request, db }) => {
  const before = await sheet(db);
  const out = await say(request, swapText, ADMIN);
  expect(out).toMatchObject({ handled: true, outcome: "teams-swapped", react: "✅" });
  expect(await sheet(db)).not.toEqual(before);
});
