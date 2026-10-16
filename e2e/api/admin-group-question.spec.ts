/**
 * QUESTIONS IN THE ADMIN GROUP (2026-10-16), against a real Postgres and
 * the real route. FNF, 14:29 London: "MatchTime who are the admins?" was
 * routed `help` and answered with the generic HQ menu. The shared router
 * and the question extractor are STUBBED (what the models would have
 * said); everything after is the shipped code: the players' group's own
 * answering path (`runAnswerBatch`, the engine, the composer), with the
 * organisers as the audience, reading the real club.
 *
 * The fixture club (E2E Test FC, weekly) has its upcoming match at 4 of 5:
 * Alex Admin (OWNER), Colin Collector (the money collector), Pat Player,
 * Tom Third, and Ben Bench on the bench. Its game's fee is £8. Set up like
 * FNF here: the organisers announce the list, so "Teams ready" is 10:00.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000052@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");

const ADMINS = "MatchTime who are the admins?";
const ADMINS_TR = "MatchTime yöneticiler kim?";
const BENCH = "MatchTime who's on the bench?";
const COUNT = "@Match Time how many are in?";
const MENU = "what can you do?";
const WEATHER = "@Match Time what's the weather like on Friday?";

/** The question extractor's raw answer. */
const q = (topic: string) => ({
  route: "question",
  facts: { topic, personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none" },
});

let seq = 0;
async function say(request: APIRequestContext, text: string) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-agq-${++seq}`, text, senderPhone: ADMIN, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "listAnnouncer" = 'organisers' WHERE id = $1`, [ORG_ID, HQ]);
  engineOn({
    // The incident: the router said `help`.
    [ADMINS]: { ...q("club"), route: "help" },
    [ADMINS_TR]: q("club"),
    [BENCH]: q("bench"),
    [COUNT]: q("count"),
    [MENU]: { ...q("how_it_works"), route: "help" },
    [WEATHER]: q("other"),
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("the incident: who are the admins, routed help, is answered from the club", async ({ request }) => {
  expect(await say(request, ADMINS)).toMatchObject({
    handled: true,
    outcome: "hq-answered",
    replyText: "👥 Admins: Alex Admin\n💷 Money collector: Colin Collector\n💷 Match fee: £8 a player\n⚽ Teams ready: 10:00 on match day",
  });
});

test("in Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const out = await say(request, ADMINS_TR);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  expect(out).toMatchObject({
    handled: true,
    outcome: "hq-answered",
    replyText: "👥 Yöneticiler: Alex Admin\n💷 Parayı toplayan: Colin Collector\n💷 Maç ücreti: kişi başı £8\n⚽ Takımlar hazır: maç günü 10:00",
  });
});

test("who's on the bench: the bench itself, though the organisers announce the list to the players", async ({ request }) => {
  const out = await say(request, BENCH);
  expect(out).toMatchObject({ handled: true, outcome: "hq-answered" });
  expect(out.replyText).toContain("Ben Bench");
});

test("how many are in: the count", async ({ request }) => {
  const out = await say(request, COUNT);
  expect(out).toMatchObject({ handled: true, outcome: "hq-answered" });
  expect(out.replyText).toMatch(/4/);
});

test("what can you do: the HQ menu, as before", async ({ request }) => {
  const out = await say(request, MENU);
  expect(out).toMatchObject({ handled: true, outcome: "hq-help" });
  expect(out.replyText).toContain("*MatchTime in your admin group*");
});

test("a question nothing answers: one line, never silent", async ({ request }) => {
  expect(await say(request, WEATHER)).toMatchObject({
    handled: true,
    outcome: "hq-not-here",
    replyText: "I can't do that from this group. Ask *what can you do?* to see what I can do here.",
  });
});
