/**
 * A GAME THAT DID NOT HAPPEN (2026-10-28, Kemal: Sutton FC's Tuesday
 * 5-a-side never happened; MatchTime DM'd every player a rating link and
 * asked the players' group for the score).
 *
 * Against a real Postgres and the real routes. The router and the admin
 * extractor are STUBBED (admin_ops, then cancel_match or restore_match with
 * pastGame); everything after is the shipped code (`match-cancel.ts`): the
 * past match picked, CANCELLED, the reply to the organiser, the one
 * "rating links closed" line, and the scheduler sending nothing after the
 * game. The rating page itself is `e2e/web/not-played.spec.ts`.
 *
 * The fixture's rate match is the game: yesterday 20:00 London, COMPLETED,
 * no score here, five confirmed. Alex is the OWNER.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, NAME, ORG_ID, PHONE, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000062@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");

const GONE = "@Match Time last night's game didn't happen";
const GONE_TR = "@Match Time dünkü maç oynanmadı";
const HAPPENED = "@Match Time it did happen after all, put it back";

const admin = (action: string, matchDay = "", pastGame = true) => ({
  route: "admin_ops",
  facts: { action, payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay, pastGame, phrase: "", note: "", lookbackMatches: 0, playersFrom: "", clubRef: "" },
});
/** Yesterday's weekday in London, as an organiser would name it ("Tuesday"). */
const YESTERDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "Europe/London" }).format(new Date(Date.now() - 24 * 3600_000));
const BARE_DAY = `@Match Time cancel ${YESTERDAY}, we didn't play`;

let seq = 0;
async function sayHq(request: APIRequestContext, text: string) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-notplayed-${++seq}`, text, botMentioned: text.includes("@Match Time"), senderPhone: ADMIN, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function sayGroup(request: APIRequestContext, body: string) {
  const waMessageId = `e2e-notplayed-pg-${Date.now()}-${++seq}`;
  const res = await postAnalyze(request, [{ waMessageId, body, authorPhone: PHONE.admin, authorName: NAME.admin, botMentioned: true }]);
  const mine = res.results.filter((r: { waMessageId: string }) => r.waMessageId === waMessageId);
  expect(mine, JSON.stringify(res.results)).toHaveLength(1);
  return mine[0] as { reply: string | null; react: string | null; intent: string };
}

const status = async (db: TestDb) => (await db.one<{ status: string }>(`SELECT status FROM "Match" WHERE id = $1`, [MATCH.rate]))!.status;
const groupPosts = async (db: TestDb) =>
  (await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'group' AND "orgId" = $1 ORDER BY "createdAt"`, [ORG_ID])).map((p) => p.text);

/** What the scheduler would post about the game at a pinned moment (nothing claimed). */
async function afterGamePosts(request: APIRequestContext, at: Date): Promise<string[]> {
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-no-claim": "1", "x-test-now": at.toISOString(), "x-mt-pi-caps": "admin-group" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()).instructions as Array<{ key: string }>).map((i) => i.key).filter((k) => k.startsWith(`${MATCH.rate}:`));
}

test.beforeEach(async ({ db }) => {
  resetDb();
  // The rate match is the game: no score reported. The pay match moves out
  // of the 7-day window, so "the last game" is this one.
  await db.run(`UPDATE "Match" SET "redScore" = NULL, "yellowScore" = NULL, "eloApplied" = NULL, status = 'COMPLETED' WHERE id = $1`, [MATCH.rate]);
  await db.run(`UPDATE "Match" SET date = now() - interval '10 days' WHERE id = $1`, [MATCH.pay]);
  await db.run(`DELETE FROM "BotJob"`);
  engineOn({
    [GONE]: admin("cancel_match"),
    [GONE_TR]: admin("cancel_match"),
    [HAPPENED]: admin("restore_match"),
    // The extractor missed the past: a bare weekday, pastGame false.
    [BARE_DAY]: admin("cancel_match", YESTERDAY, false),
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("HQ: 'last night's game didn't happen' marks it as not played; one reply, one line to the players; nothing after the game", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  // A rating link had gone out for it.
  await db.run(`INSERT INTO "SentNotification" (id, key, kind, "matchId", "targetUser") SELECT 'e2e-np-sn', $1 || ':rate-dm:' || "userId", 'dm', $1, "userId" FROM "Attendance" WHERE "matchId" = $1 LIMIT 1`, [MATCH.rate]);

  // Control: before, the scheduler would still ask for the score.
  const kickoff = (await db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [MATCH.rate]))!.date;
  const scoreAskAt = new Date(new Date(kickoff).getTime() + 2.5 * 3600_000);
  expect(await afterGamePosts(request, scoreAskAt)).toContain(`${MATCH.rate}:ask-score`);

  const out = await sayHq(request, GONE);
  expect(out).toMatchObject({ handled: true, outcome: "hq-match-not-played", react: "✅" });
  expect(out.replyText).toMatch(/^Done\. \w+'s E2E 5-a-side on \d{1,2} \w{3} is marked as not played: no score, ratings or Man of the Match for it\.$/);
  expect(await status(db)).toBe("CANCELLED");
  // Not the "Match cancelled" announcement: only the ratings line.
  const posts = await groupPosts(db);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatch(/^\w+'s game on \d{1,2} \w{3} didn't happen, so its rating links are closed\.$/);
  // No DM to anyone.
  expect(await db.all(`SELECT id FROM "BotJob" WHERE kind = 'dm'`)).toHaveLength(0);

  // After: no score ask, no rating DM, no MoM post, no payment poll.
  expect(await afterGamePosts(request, scoreAskAt)).toEqual([]);
  expect(await afterGamePosts(request, londonAt(0, 9, 0))).toEqual([]);
  expect(await afterGamePosts(request, londonAt(1, 18, 30))).toEqual([]);

  // "It did happen after all": back as played, COMPLETED, and nothing posted.
  const back = await sayHq(request, HAPPENED);
  expect(back).toMatchObject({ outcome: "hq-match-played-restored", react: "✅" });
  expect(back.replyText).toMatch(/is back on the record as played\.$/);
  expect(await status(db)).toBe("COMPLETED");
  expect(await groupPosts(db)).toHaveLength(1);
});

test("HQ, Turkish club: answered in Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', language = 'tr' WHERE id = $1`, [ORG_ID, HQ]);
  const out = await sayHq(request, GONE_TR);
  expect(out.replyText).toMatch(/^Tamam\. E2E 5-a-side \(\d{1,2} \S+ \S+\) oynanmadı olarak işaretlendi: skor, puanlama ya da maçın adamı yok\.$/);
  expect(await status(db)).toBe("CANCELLED");
  // No rating link had gone out: nothing said to the players.
  expect(await groupPosts(db)).toHaveLength(0);
});

test("the players' group (no HQ): the organiser's reply carries the ratings line; one message, a tick; no score ask afterwards", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = NULL WHERE id = $1`, [ORG_ID]);
  await db.run(`INSERT INTO "SentNotification" (id, key, kind, "matchId") VALUES ('e2e-np-promo', $1 || ':rate-promo', 'group-message', $1)`, [MATCH.rate]);
  const out = await sayGroup(request, GONE);
  expect(out).toMatchObject({ react: "✅", intent: "match_not_played" });
  expect(out.reply).toMatch(/^Done\. .+ is marked as not played: no score, ratings or Man of the Match for it\.\n\w+'s game on \d{1,2} \w{3} didn't happen, so its rating links are closed\.$/);
  expect(await status(db)).toBe("CANCELLED");
  expect(await groupPosts(db)).toHaveLength(0);
  expect(await afterGamePosts(request, londonAt(0, 9, 0))).toEqual([]);
});

test("review of #437: said twice, the second says 'already' and the game before is untouched; a bare weekday asks which game", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  // Two past games in the window: the pay match two days before the rate match.
  await db.run(`UPDATE "Match" SET date = now() - interval '3 days', "redScore" = NULL, "yellowScore" = NULL WHERE id = $1`, [MATCH.pay]);

  // The bare weekday first, while yesterday's game is still unscored: a question, nothing done.
  const ask = await sayHq(request, BARE_DAY);
  expect(ask).toMatchObject({ outcome: "hq-cancel-none", react: null });
  expect(ask.replyText).toMatch(new RegExp(`last ${YESTERDAY}`));
  expect(await status(db)).toBe("COMPLETED");

  expect((await sayHq(request, GONE)).outcome).toBe("hq-match-not-played");
  const again = await sayHq(request, GONE);
  expect(again).toMatchObject({ outcome: "hq-cancel-none", react: null });
  expect(again.replyText).toMatch(/is already marked as not played\.$/);
  const pay = await db.one<{ status: string }>(`SELECT status::text AS status FROM "Match" WHERE id = $1`, [MATCH.pay]);
  expect(pay!.status).toBe("COMPLETED");
});

test("a game with a score was played: left alone, one line, no tick", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  await db.run(`UPDATE "Match" SET "redScore" = 3, "yellowScore" = 2 WHERE id = $1`, [MATCH.rate]);
  const out = await sayHq(request, GONE);
  expect(out).toMatchObject({ outcome: "hq-cancel-none", react: null });
  expect(out.replyText).toMatch(/has a score recorded, so I've left it as played\.$/);
  expect(await status(db)).toBe("COMPLETED");
});
