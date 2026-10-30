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
import { engineOn, clearPipelineStubs, setRouterStub } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000052@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");

const ADMINS = "@Match Time who are the admins?";
const ADMINS_TR = "@Match Time yöneticiler kim?";
const BENCH = "@Match Time who's on the bench?";
const COUNT = "@Match Time how many are in?";
const MENU = "@Match Time what can you do?";
const WEATHER = "@Match Time what's the weather like on Friday?";
// FNF HQ, 2026-10-30 23:31 UTC: an organiser asking the other organisers.
const MOTM = "Who got motm";
const MENU_UNTAGGED = "what can you do?";

/** The question extractor's raw answer. */
const q = (topic: string) => ({
  route: "question",
  facts: { topic, personRef: "", statedCount: -1, table: "none", listSize: -1, listEnd: "top", period: "none", periodCount: -1, periodUnit: "none", feature: "none" },
});

let seq = 0;
async function say(request: APIRequestContext, text: string, extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-agq-${++seq}`, text, senderPhone: ADMIN, timestamp: String(Math.floor(Date.now() / 1000)), ...extra },
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
    [MOTM]: q("club"),
    [MENU_UNTAGGED]: { ...q("how_it_works"), route: "help" },
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
    replyText: "I can't do that from this group.",
  });
});

// FNF HQ, 2026-10-30 23:31 UTC: right after MatchTime's "Who was Man of
// the Match?", Raihan, an organiser, wrote "Who got motm" to the other
// organisers, untagged and not a reply to MatchTime. The router called it a
// question and MatchTime posted the all-time Man of the Match table. In HQ,
// MatchTime answers only when asked: a real tag or a reply to its message.
test.describe("an untagged question or help in HQ is the organisers' own talk (FNF HQ 2026-10-30)", () => {
  test("the incident: an organiser's untagged question, not a reply to MatchTime: silent, nothing recorded as said", async ({ request, db }) => {
    const before = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "AdminGroupMessage" WHERE "fromMatchTime" = true`);
    expect(await say(request, MOTM)).toMatchObject({ handled: false, replyText: null });
    const after = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "AdminGroupMessage" WHERE "fromMatchTime" = true`);
    expect(after?.n).toBe(before?.n);
  });

  test("untagged help from an organiser: silent too", async ({ request }) => {
    expect(await say(request, MENU_UNTAGGED)).toMatchObject({ handled: false, replyText: null });
  });

  test("the same words as a WhatsApp reply to MatchTime's own message: answered", async ({ request }) => {
    const out = await say(request, MOTM, { quotedText: "Score saved: Bibs 5, Non Bibs 4. Who was Man of the Match?", quotedFromMatchTime: true });
    expect(out).toMatchObject({ handled: true, outcome: "hq-answered" });
  });
});

// FNF HQ, 2026-10-18 13:32 London: Kemal (a player of the club) asked
// "@Match Time what is squad now including bench?". The router's answer was
// dropped (its id echoed wrong), the message fell back to `unsure`, and HQ
// said "I didn't catch what you'd like me to do". Addressed to MatchTime and
// routed `unsure`, by the model or because the router call failed, it is now
// tried as a question first: the squad and the bench, from the real club.
test.describe("a tagged question routed unsure is answered", () => {
  const SQUAD_Q = "@Match Time what is squad now including bench?";
  const PLAYER = PHONE.player.replace(/^\+/, "");
  const sayAsPlayer = async (request: APIRequestContext, text: string) => {
    const res = await request.post("/api/whatsapp/admin-group", {
      headers: KEY,
      data: { channel: "admin-group", groupId: HQ, messageId: `e2e-agq-u-${++seq}`, text, senderPhone: PLAYER, timestamp: String(Math.floor(Date.now() / 1000)) },
    });
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  };
  const expectSquad = (out: { replyText?: string | null }) => {
    expect(out).toMatchObject({ handled: true, outcome: "hq-answered" });
    expect(out.replyText).toContain("Pat Player");
    expect(out.replyText).toContain("Ben Bench");
  };

  test("the model said unsure: the squad and the bench", async ({ request }) => {
    engineOn({ [SQUAD_Q]: { ...q("squad"), route: "unsure" } });
    expectSquad(await sayAsPlayer(request, SQUAD_Q));
  });

  test("the router call failed: the same answer", async ({ request }) => {
    engineOn({ [SQUAD_Q]: { ...q("squad"), route: "unsure" } });
    setRouterStub({ floor: false, fail: true });
    expectSquad(await sayAsPlayer(request, SQUAD_Q));
  });

  test("an organiser, the router call failed: the squad change owns nothing, then the question answers", async ({ request }) => {
    engineOn({ [SQUAD_Q]: { ...q("squad"), route: "unsure" } });
    setRouterStub({ floor: false, fail: true });
    expectSquad(await say(request, SQUAD_Q));
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
