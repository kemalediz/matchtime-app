/**
 * CANCELLING A MATCH FROM THE ADMIN GROUP, AND PUTTING IT BACK ON
 * (2026-10-22, FNF HQ: "Cancel the session" got "I can't do that from this
 * group"), against a real Postgres and the real routes. The shared router
 * and the admin extractor are STUBBED (admin_ops, then cancel_match or
 * restore_match); everything after is the shipped code: who may, which
 * match, the status, the players' group announcement and HQ's reply. Also
 * the help noise: "I can't do that from this group" is said once, short.
 *
 * Alex is the OWNER; Pat is a player. The fixture's upcoming match is the
 * next one still to come; the others are in the past.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000061@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");

const CANCEL = "Cancel the session";
const CANCEL_TR = "maçı iptal et";
const BACK_ON = "it's back on, uncancel it";
const KIT = "@Match Time change the kit colour";

const admin = (action: string) => ({
  route: "admin_ops",
  facts: { action, payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", phrase: "", note: "", lookbackMatches: 0, partnerClubs: false, clubRef: "" },
});

let seq = 0;
async function say(request: APIRequestContext, text: string, senderPhone = ADMIN) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: `e2e-cancel-${++seq}`, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const status = async (db: TestDb) => (await db.one<{ status: string }>(`SELECT status FROM "Match" WHERE id = $1`, [MATCH.upcoming]))!.status;
const groupPosts = (db: TestDb) => db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'group' AND "orgId" = $1 ORDER BY "createdAt"`, [ORG_ID]);

test.beforeEach(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  // Exactly one match still to come: the upcoming one, in three days.
  await db.run(`UPDATE "Match" SET date = now() + interval '3 days', status = 'UPCOMING' WHERE id = $1`, [MATCH.upcoming]);
  await db.run(`DELETE FROM "BotJob"`);
  engineOn({
    [CANCEL]: admin("cancel_match"),
    [CANCEL_TR]: admin("cancel_match"),
    [BACK_ON]: admin("restore_match"),
    [KIT]: admin("other"),
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("an organiser's 'Cancel the session': the next match is cancelled, the players' group told, HQ answered", async ({ request, db }) => {
  const out = await say(request, CANCEL);
  expect(out).toMatchObject({ handled: true, outcome: "hq-match-cancelled", react: "✅" });
  expect(out.replyText).toMatch(/^Done: .+, \w{3} \d{1,2} \w{3} at \d{2}:\d{2} is cancelled\. I've told the players' group\.$/);
  expect(await status(db)).toBe("CANCELLED");
  expect((await groupPosts(db)).map((p) => p.text)).toEqual([expect.stringMatching(/^❌ \*Match cancelled\*/)]);

  // Undo: back on, and the players' group told.
  const back = await say(request, BACK_ON);
  expect(back).toMatchObject({ outcome: "hq-match-restored", react: "✅" });
  expect(back.replyText).toMatch(/is back on\. I've told the players' group\.$/);
  expect(await status(db)).toBe("UPCOMING");
  expect((await groupPosts(db)).map((p) => p.text)[1]).toMatch(/^✅ \*Match back on\*/);
});

test("Turkish club: cancelled and answered in Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const out = await say(request, CANCEL_TR);
  expect(out.replyText).toMatch(/iptal edildi\. Oyuncu grubuna haber verdim\.$/);
  expect(await status(db)).toBe("CANCELLED");
});

test("a player in HQ: nothing cancelled, the line naming who can", async ({ request, db }) => {
  const out = await say(request, CANCEL, PLAYER);
  expect(out).toMatchObject({ handled: true, outcome: "hq-only-organisers", react: null });
  expect(await status(db)).toBe("UPCOMING");
  expect(await groupPosts(db)).toHaveLength(0);
});

test("a monthly club: nothing cancelled; use the website", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly' WHERE id = $1`, [ORG_ID]);
  const out = await say(request, CANCEL);
  expect(out).toMatchObject({ outcome: "hq-cancel-monthly", react: null });
  expect(out.replyText).toBe("Cancelling a match from here isn't available for monthly squads yet. Please use the website.");
  expect(await status(db)).toBe("UPCOMING");
});

test("'I can't do that from this group': short, and not said twice in a row", async ({ request }) => {
  const first = await say(request, KIT);
  expect(first).toMatchObject({ outcome: "hq-not-here", replyText: "I can't do that from this group." });
  const second = await say(request, KIT);
  expect(second).toMatchObject({ outcome: "hq-not-here", replyText: null });
});
