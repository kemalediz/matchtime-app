/**
 * CANCELLING A MATCH FROM THE PLAYERS' GROUP, AND PUTTING IT BACK ON
 * (2026-10-23). Friday MT Community: "@Match Time cancel the match" from an
 * owner routed admin_ops, extracted cancel_match, and got "I can't change
 * that by message, but you can do it on the admin page...". Kemal: a club
 * with NO admin group cancels here, by its owners and admins; a club WITH
 * one is pointed there.
 *
 * Against a real Postgres and the real analyze route. The router and the
 * admin extractor are STUBBED (admin_ops, then cancel_match or
 * restore_match); everything after is the shipped code, the same core HQ
 * and the web page use (`match-cancel.ts`).
 *
 * Alex is the OWNER; Pat is a player.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, NAME, ORG_ID, PHONE } from "../helpers/constants";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const CANCEL = "@Match Time cancel the match";
const BACK_ON = "@Match Time the match is back on";
const UNTAGGED = "no game this week lads, pitch is flooded";

const admin = (action: string) => ({
  route: "admin_ops",
  facts: { action, payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", phrase: "", note: "", lookbackMatches: 0, playersFrom: "", clubRef: "" },
});

let seq = 0;
async function say(request: APIRequestContext, body: string, who: "admin" | "player" = "admin", tagged = true) {
  const waMessageId = `e2e-pcancel-${Date.now()}-${++seq}`;
  const res = await postAnalyze(request, [
    { waMessageId, body, authorPhone: PHONE[who], authorName: NAME[who], botMentioned: tagged },
  ]);
  const mine = res.results.filter((r: { waMessageId: string }) => r.waMessageId === waMessageId);
  expect(mine, JSON.stringify(res.results)).toHaveLength(1);
  return mine[0] as { reply: string | null; react: string | null; intent: string };
}

const status = async (db: TestDb) => (await db.one<{ status: string }>(`SELECT status FROM "Match" WHERE id = $1`, [MATCH.upcoming]))!.status;
const groupPosts = async (db: TestDb) =>
  (await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'group' AND "orgId" = $1 ORDER BY "createdAt"`, [ORG_ID])).map((p) => p.text);

test.beforeEach(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = NULL WHERE id = $1`, [ORG_ID]);
  await db.run(`UPDATE "Match" SET date = now() + interval '3 days', status = 'UPCOMING' WHERE id = $1`, [MATCH.upcoming]);
  await db.run(`DELETE FROM "BotJob"`);
  engineOn({ [CANCEL]: admin("cancel_match"), [BACK_ON]: admin("restore_match"), [UNTAGGED]: admin("cancel_match") });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("no admin group: the owner cancels, the cancel post is the one announcement; then undoes it", async ({ request, db }) => {
  const out = await say(request, CANCEL);
  expect(out).toMatchObject({ reply: null, react: "✅", intent: "match_cancelled" });
  expect(await status(db)).toBe("CANCELLED");
  expect(await groupPosts(db)).toEqual([expect.stringMatching(/^❌ \*Match cancelled\*/)]);

  const back = await say(request, BACK_ON);
  expect(back).toMatchObject({ reply: null, react: "✅", intent: "match_restored" });
  expect(await status(db)).toBe("UPCOMING");
  const posts = await groupPosts(db);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toMatch(/^✅ \*Match back on\*/);
});

test("untagged: nothing cancelled, nothing posted, nothing said", async ({ request, db }) => {
  const out = await say(request, UNTAGGED, "admin", false);
  expect(out.reply ?? null).toBeNull();
  expect(await status(db)).toBe("UPCOMING");
  expect(await groupPosts(db)).toHaveLength(0);
});

test("a player: refused with the line naming who can, nothing cancelled", async ({ request, db }) => {
  const out = await say(request, CANCEL, "player");
  expect(out.reply).toMatch(/^Only .+ can change that\.$/);
  expect(out.react).toBeNull();
  expect(await status(db)).toBe("UPCOMING");
  expect(await groupPosts(db)).toHaveLength(0);
});

test("a monthly club: nothing cancelled; use the website", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly' WHERE id = $1`, [ORG_ID]);
  const out = await say(request, CANCEL);
  expect(out.reply).toBe("Cancelling a match from here isn't available for monthly squads yet. Please use the website.");
  expect(await status(db)).toBe("UPCOMING");
  expect(await groupPosts(db)).toHaveLength(0);
});

test("a club WITH an admin group: pointed there, nothing cancelled (EN and TR)", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = '120363777000000062@g.us' WHERE id = $1`, [ORG_ID]);
  const out = await say(request, CANCEL);
  expect(out.reply).toBe("Cancelling a match or putting it back on is done in your admin group. Tag me there and I'll do it.");
  expect(out.react).toBeNull();
  expect(await status(db)).toBe("UPCOMING");
  expect(await groupPosts(db)).toHaveLength(0);

  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const tr = await say(request, CANCEL);
  expect(tr.reply).toBe("Maçı iptal etmek ya da yeniden açmak yönetici grubunuzdan yapılıyor. Orada beni etiketleyin, ben yaparım.");
  expect(await status(db)).toBe("UPCOMING");
});
