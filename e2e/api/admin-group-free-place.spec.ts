/**
 * A FREE PLACE, ASKED FOR IN THE ADMIN GROUP AND GIVEN ON YES (2026-10-16,
 * review of #301), against a real Postgres and the real routes. The shared
 * router and the shared admin extractor are STUBBED (what the model would
 * have said: admin_ops then action fee_waiver and who; approve for a YES);
 * everything after is the shipped code: the game it means, the names
 * against that squad, the question, the safe-YES rule, the write and its
 * money guards, the DM to a player whose pay link was out, the ✅ tick,
 * and the daily chase afterwards.
 *
 * The fixture's PAY match has its links out: Pat Player and Ian Innes
 * unpaid, Riley Rater paid by card, Gary Guest paying the collector
 * directly. It is moved to kick off NOW so it is "today's game" whatever
 * the hour the suite runs. Alex is the OWNER; Colin Collector is the money
 * collector and a PLAYER, not an admin; Pat is a player.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000052@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");
const COLLECTOR = PHONE.collector.replace(/^\+/, "");
const IAN = PHONE.fresh.replace(/^\+/, "");

const FREE = "Ian washed the bibs, he's free this week";
const FREE_TR = "Ian bu hafta ödemesin";
const FREE_PAID = "@Match Time Riley is free this week";
const FREE_ASK = "@Match Time Ian is free this week";
const UNDO = "Ian isn't free after all, he pays";
const CHAT = "who's bringing the balls?";

const waiver = (coveredRefs: string[], undo = false) => ({
  route: "admin_ops",
  facts: { action: "fee_waiver", payerRef: "", count: 0, coveredRefs, undo, matchDay: "", phrase: "", note: "", lookbackMatches: 0 },
});

// The clock is pinned (`x-test-now`): today's game at 19:00 London, each
// message a second after the one before. It was `now()` in SQL, and the
// e2e Postgres runs in Europe/London, so the timezone-less column stored
// London wall time that Prisma reads as UTC: an hour ahead, and from 23:00
// to midnight "today's game" was tomorrow's (failed nightly).
const GAME = londonAt(0, 19, 0);
let seq = 0;
async function say(request: APIRequestContext, text: string, senderPhone = ADMIN) {
  const at = new Date(GAME.getTime() + ++seq * 1000);
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: { ...KEY, "x-test-now": at.toISOString() },
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId: `e2e-free-${seq}`, text, senderPhone, timestamp: String(Math.floor(at.getTime() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const waived = async (db: TestDb, userId: string) =>
  (await db.one<{ at: Date | null; reason: string | null; by: string | null }>(
    `SELECT "feeWaivedAt" AS at, "feeWaivedReason" AS reason, "feeWaivedByUserId" AS by FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.pay, userId],
  ))!;
const dmsTo = (db: TestDb, phone: string) => db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1`, [phone]);

test.beforeEach(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  await db.run(`UPDATE "Match" SET date = $2 WHERE id = $1`, [MATCH.pay, GAME]);
  engineOn({
    [FREE]: waiver(["Ian"]),
    [FREE_TR]: waiver(["Ian"]),
    [FREE_PAID]: waiver(["Riley"]),
    [FREE_ASK]: waiver(["Ian"]),
    [UNDO]: waiver(["Ian"], true),
    yes: { route: "approve" },
    evet: { route: "approve" },
    [CHAT]: { route: "none" },
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("an organiser's own words: MatchTime ASKS, naming today's game; nothing written until YES", async ({ request, db }) => {
  const out = await say(request, FREE);
  expect(out).toMatchObject({ handled: true, outcome: "fee-free-asked", react: "✅" });
  expect(out.replyText).toMatch(/^Make Ian Innes free for \w{3} \d{1,2} \w{3}\? Say \*@Match Time YES\*\.$/);
  expect((await waived(db, U.fresh)).at).toBeNull();
  expect(await dmsTo(db, IAN)).toHaveLength(0);

  const yes = await say(request, "yes");
  expect(yes).toMatchObject({ handled: true, outcome: "fee-free", react: "✅" });
  expect(yes.replyText).toMatch(/^Free place for \w{3} \d{1,2} \w{3}: Ian Innes\. No pay link and no reminders to pay\.$/);
  expect(await waived(db, U.fresh)).toMatchObject({ reason: "organiser", by: U.admin });
  // His pay link was out (Kemal, decision a): one short DM.
  expect((await dmsTo(db, IAN)).map((d) => d.text)).toEqual([expect.stringMatching(/^You're on a free place for .+, no need to pay\.$/)]);
  // A second YES finds nothing waiting.
  expect((await say(request, "yes")).outcome).not.toBe("fee-free");
  expect(await dmsTo(db, IAN)).toHaveLength(1);
});

test("a YES after other chat: asked once whether it is for the free place, nothing given", async ({ request, db }) => {
  await say(request, FREE);
  await say(request, CHAT);
  const out = await say(request, "yes");
  expect(out).toMatchObject({ outcome: "hq-confirm-asked" });
  expect(out.replyText).toMatch(/^Is that YES to the free place for Ian Innes on .+\?$/);
  expect((await waived(db, U.fresh)).at).toBeNull();
});

test("Turkish club: asked and answered in Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const out = await say(request, FREE_TR);
  expect(out.replyText).toMatch(/için Ian Innes ücretsiz olsun mu\? Onaylamak için \*@Match Time EVET\* yazın\.$/);
  const yes = await say(request, "evet");
  expect(yes.replyText).toMatch(/için ücretsiz yer: Ian Innes\. Ödeme linki ve ödeme hatırlatması gitmeyecek\.$/);
  expect((await dmsTo(db, IAN)).map((d) => d.text)).toEqual([expect.stringMatching(/maçı için ücretsiz yerdesin, ödeme yapman gerekmiyor\.$/)]);
});

test("already paid by card: left as paid, no question, no tick", async ({ request, db }) => {
  const out = await say(request, FREE_PAID);
  expect(out).toMatchObject({ handled: true, outcome: "hq-fee-free-none", react: null });
  expect(out.replyText).toMatch(/^Riley Rater has already paid for .+, so I've left it as paid\. The money collector can refund it if they should play free\.$/);
  expect(await db.one(`SELECT count(*)::int AS n FROM "AdminFeeProposal"`)).toEqual({ n: 0 });
});

test("someone in HQ who is neither an organiser nor the collector: the #297 line, nothing asked", async ({ request, db }) => {
  const out = await say(request, FREE_ASK, PLAYER);
  expect(out).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null });
  expect(await db.one(`SELECT count(*)::int AS n FROM "AdminFeeProposal"`)).toEqual({ n: 0 });
});

test("the money collector, not an admin: may ask, and his YES gives it (item 8)", async ({ request, db }) => {
  expect(await say(request, FREE, COLLECTOR)).toMatchObject({ outcome: "fee-free-asked" });
  expect(await say(request, "yes", COLLECTOR)).toMatchObject({ outcome: "fee-free" });
  expect(await waived(db, U.fresh)).toMatchObject({ by: U.collector });
});

test("taken back: 'Ian isn't free after all' asks, YES takes the free place away", async ({ request, db }) => {
  await say(request, FREE);
  await say(request, "yes");
  const out = await say(request, UNDO);
  expect(out.replyText).toMatch(/^Take the free place away from Ian Innes for .+\? They'll be asked to pay\. Say \*@Match Time YES\*\.$/);
  expect((await waived(db, U.fresh)).at).not.toBeNull();
  const yes = await say(request, "yes");
  expect(yes.replyText).toMatch(/^No longer free for .+: Ian Innes\. They'll get the usual reminders to pay\.$/);
  expect((await waived(db, U.fresh)).at).toBeNull();
});

test("after the free place: the daily chase skips him and still chases the unpaid", async ({ request, db }) => {
  await say(request, FREE);
  await say(request, "yes");
  // Back to the fixture's kickoff, three hours before the chase window.
  await db.run(`UPDATE "Match" SET date = $2 WHERE id = $1`, [MATCH.pay, new Date(londonAt(0, 18, 30).getTime() - 3 * 60 * 60 * 1000)]);
  const now = londonAt(0, 18, 30);
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-test-now": now.toISOString(), "x-no-claim": "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const keys = ((await res.json()).instructions as Array<{ key?: string }>).map((i) => i.key ?? "");
  expect(keys.some((k) => k.startsWith(`${MATCH.pay}:pay-chase:${U.fresh}:`))).toBe(false);
  expect(keys.some((k) => k.startsWith(`${MATCH.pay}:pay-chase:${U.player}:`))).toBe(true);
});
