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
import { test, expect, postAnalyze, resetDb } from "../fixtures";
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

// Manager review of #296: the same `club` answer in the PLAYERS' group,
// through the real analyze route (so the squad-composition pass and the
// organisers-announce net run too), with the teams line worded for players.
// Nothing private: names only, never a phone number.
test.describe("the players' group asks the same club questions", () => {
  const FEE_Q = "@Match Time how much do we pay each?";
  const TEAMS_Q = "@Match Time what time do the teams come out?";
  const FEE_TR = "@Match Time kişi başı ne kadar?";
  type Result = { waMessageId: string; reply?: string | null };
  const ask = async (request: APIRequestContext, body: string) => {
    const id = `e2e-agq-p-${++seq}`;
    const res = await postAnalyze(request, [{ waMessageId: id, body, authorPhone: PHONE.player.replace(/^\+/, ""), authorName: "Pat Player" }]);
    return (res.results as Result[]).find((x) => x.waMessageId === id)!;
  };

  test.beforeAll(() => {
    engineOn({ [FEE_Q]: q("club"), [TEAMS_Q]: q("club"), [FEE_TR]: q("club") });
  });

  test("how much do we pay each, and when do the teams come out: answered, in plain words", async ({ request }) => {
    const expected = "👥 Admins: Alex Admin\n💷 Money collector: Colin Collector\n💷 Match fee: £8 a player\n⚽ Teams: worked out at 10:00 on match day";
    for (const body of [FEE_Q, TEAMS_Q]) {
      const r = await ask(request, body);
      expect(r.reply).toBe(expected);
      expect(r.reply).not.toMatch(/\d{9,}/);
    }
  });

  test("in Turkish", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
    const r = await ask(request, FEE_TR);
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
    expect(r.reply).toBe("👥 Yöneticiler: Alex Admin\n💷 Parayı toplayan: Colin Collector\n💷 Maç ücreti: kişi başı £8\n⚽ Takımların kurulduğu saat: maç günü 10:00");
  });
});
