/**
 * "ASK THE GROUP IF ANYONE CAN PLAY", FROM THE ADMIN GROUP (2026-10-16),
 * against a real Postgres and the real routes. The shared router is
 * STUBBED (`engineOn`: what the model would have said, `ask_group`, or
 * `admin_ops` for another instruction); everything after is the shipped
 * code: the squad state, the one-ask-per-opening claim, the BotJob, and
 * due-posts emitting it into the players' group.
 *
 * The fixture club (E2E Test FC, weekly, first-come) has its upcoming
 * match at 4 of 5: Alex Admin, Colin Collector, Pat Player, Tom Third, and
 * Ben Bench on the bench. Alex is the OWNER.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000051@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");

const ASK = "@Match Time ask in the group if anyone is available";
const ASK_TR = "gruba sor, oynayabilecek var mı";
const REMIND = "@Match Time remind me on Monday";

let seq = 0;
async function say(request: APIRequestContext, text: string, senderPhone = ADMIN) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-aga-${++seq}`, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const groupJobs = (db: TestDb) =>
  db.all<{ id: string; text: string }>(`SELECT id, text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group' ORDER BY "createdAt"`, [ORG_ID]);
const dms = (db: TestDb) => db.all<{ id: string }>(`SELECT id FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm'`, [ORG_ID]);

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  engineOn({
    [ASK]: { route: "ask_group" },
    [ASK_TR]: { route: "ask_group" },
    [REMIND]: { route: "admin_ops" },
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("a non-admin's ask is ignored: no reply, nothing posted", async ({ request, db }) => {
  expect(await say(request, ASK, PLAYER)).toMatchObject({ handled: false, replyText: null });
  expect(await groupJobs(db)).toHaveLength(0);
});

test("an admin instruction HQ has no handler for: one line, nothing posted", async ({ request, db }) => {
  expect(await say(request, REMIND)).toMatchObject({
    handled: true,
    outcome: "hq-not-here",
    replyText: "I can't do that from this group. Ask *what can you do?* to see what I can do here.",
  });
  expect(await groupJobs(db)).toHaveLength(0);
});

test("a place open (4 of 5, first come): the existing place-open post in the players' group, one line in HQ, no DMs", async ({ request, db }) => {
  const out = await say(request, ASK);
  expect(out).toMatchObject({ handled: true, outcome: "group-asked", replyText: "Asked in the main chat for 1 player." });
  const jobs = await groupJobs(db);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].text).toMatch(/^That's 4 of 5 for \w{3} \d{2}:\d{2}\. One slot open, say \*IN\* to take it\.$/);
  expect(await dms(db)).toHaveLength(0);

  // due-posts emits it into the players' group.
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-no-claim": "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const instr = ((await res.json()).instructions as Array<Record<string, unknown>>).find((i) => i.key === `botjob-${jobs[0].id}`);
  expect(instr).toMatchObject({ text: jobs[0].text });
});

test("asked again for the same opening: not posted twice, HQ is told when", async ({ request, db }) => {
  const out = await say(request, ASK);
  expect(out).toMatchObject({ handled: true, outcome: "group-ask-already" });
  expect(out.replyText).toMatch(/^Already asked in the main chat at \d{2}:\d{2} for 1 player\. Ask me again and I'll post it again\.$/);
  expect(await groupJobs(db)).toHaveLength(1);
});

test("asked once more after being told: posted again", async ({ request, db }) => {
  expect(await say(request, ASK)).toMatchObject({ handled: true, outcome: "group-asked", replyText: "Asked in the main chat for 1 player." });
  expect(await groupJobs(db)).toHaveLength(2);
  // And the next one is the "already" answer again.
  expect(await say(request, ASK)).toMatchObject({ outcome: "group-ask-already" });
  expect(await groupJobs(db)).toHaveLength(2);
});

test("an organiser-pick club, after a drop (a new opening): the post says the organisers pick", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "benchPickMode" = 'organiser' WHERE id = $1`, [ORG_ID]);
  await db.run(`UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
  const out = await say(request, ASK);
  expect(out).toMatchObject({ handled: true, outcome: "group-asked", replyText: "Asked in the main chat for 2 players." });
  const jobs = await groupJobs(db);
  expect(jobs).toHaveLength(3);
  expect(jobs[2].text).toMatch(
    /^We need 2 more players for \w{3} \d{2}:\d{2}\. Say \*IN\* and the organisers will pick who takes the places\. I'll message you if it's you\.$/,
  );
  await db.run(`UPDATE "Attendance" SET status = 'CONFIRMED' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
  await db.run(`UPDATE "Organisation" SET "benchPickMode" = 'first-come' WHERE id = $1`, [ORG_ID]);
});

test("a full squad: nothing posted, HQ hears the count, in the club's language", async ({ request, db }) => {
  await db.run(`UPDATE "Match" SET "maxPlayers" = 4 WHERE id = $1`, [MATCH.upcoming]);
  const out = await say(request, ASK);
  expect(out).toMatchObject({ handled: true, outcome: "group-ask-full" });
  expect(out.replyText).toMatch(/^The squad is full for \w{3} \d{2}:\d{2}: 4 of 4\. Nothing to ask the main chat for\.$/);

  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const tr = await say(request, ASK_TR);
  expect(tr).toMatchObject({ handled: true, outcome: "group-ask-full" });
  expect(tr.replyText).toMatch(/kadrosu dolu: 4 kişilik kadroda 4 kişi var\. Ana grupta sorulacak bir şey yok\.$/);
  expect(await groupJobs(db)).toHaveLength(3);

  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  await db.run(`UPDATE "Match" SET "maxPlayers" = 5 WHERE id = $1`, [MATCH.upcoming]);
});
