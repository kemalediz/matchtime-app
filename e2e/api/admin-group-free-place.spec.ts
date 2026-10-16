/**
 * A FREE PLACE, GIVEN IN THE ADMIN GROUP (2026-10-16), against a real
 * Postgres and the real routes. The shared router and the shared admin
 * extractor are STUBBED (what the model would have said: admin_ops, then
 * action fee_waiver and who); everything after is the shipped code: the
 * match it means, the name against that squad, the write and its money
 * guards, the ✅ tick, and the daily chase and the pay page afterwards.
 *
 * The fixture's PAY match kicked off three hours ago, its links are out:
 * Pat Player and Ian Innes unpaid, Riley Rater paid by card, Gary Guest
 * paying the collector directly. Alex is the OWNER; Pat is a player.
 */
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000052@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");

const FREE = "Ian washed the bibs, he's free this week";
const FREE_TR = "Ian bu hafta ödemesin";
const FREE_PAID = "@Match Time Riley is free this week";
const FREE_ASK = "@Match Time Ian is free this week";

const waiver = (coveredRefs: string[]) => ({
  route: "admin_ops",
  facts: { action: "fee_waiver", payerRef: "", count: 0, coveredRefs, phrase: "", note: "", lookbackMatches: 0 },
});

let seq = 0;
async function say(request: APIRequestContext, text: string, senderPhone = ADMIN, messageId = `e2e-free-${++seq}`) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.beforeEach(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  engineOn({
    [FREE]: waiver(["Ian"]),
    [FREE_TR]: waiver(["Ian"]),
    [FREE_PAID]: waiver(["Riley"]),
    [FREE_ASK]: waiver(["Ian"]),
  });
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

const waived = async (db: import("../helpers/test-db").TestDb, userId: string) =>
  (await db.one<{ at: Date | null; reason: string | null; by: string | null }>(
    `SELECT "feeWaivedAt" AS at, "feeWaivedReason" AS reason, "feeWaivedByUserId" AS by FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.pay, userId],
  ))!;

test("an organiser's own words: the free place is given on the game just played, ticked, and HQ hears who", async ({ request, db }) => {
  const out = await say(request, FREE);
  expect(out).toMatchObject({ handled: true, outcome: "fee-free", react: "✅" });
  expect(out.replyText).toMatch(/^Free place for \w{3} \d{1,2} \w{3}: Ian Innes\. No pay link and no reminders to pay\.$/);
  const row = await waived(db, U.fresh);
  expect(row.at).not.toBeNull();
  expect(row).toMatchObject({ reason: "organiser", by: U.admin });
  // Nobody else touched, and no message to anybody.
  expect((await waived(db, U.player)).at).toBeNull();
  expect(await db.all(`SELECT id FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm'`, [ORG_ID])).toHaveLength(0);
});

test("the same message again (a Pi retry with a new id): already free, nothing rewritten", async ({ request, db }) => {
  await say(request, FREE);
  const first = (await waived(db, U.fresh)).at;
  const again = await say(request, FREE);
  expect(again).toMatchObject({ outcome: "fee-free", react: "✅" });
  expect(again.replyText).toMatch(/^Already a free place for .+: Ian Innes\.$/);
  expect((await waived(db, U.fresh)).at).toEqual(first);
});

test("Turkish club: the reply in Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const out = await say(request, FREE_TR);
  expect(out.outcome).toBe("fee-free");
  expect(out.replyText).toMatch(/için ücretsiz yer: Ian Innes\. Ödeme linki ve ödeme hatırlatması gitmeyecek\.$/);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("already paid by card: left as paid, no tick, the collector is pointed at a refund", async ({ request, db }) => {
  const out = await say(request, FREE_PAID);
  expect(out).toMatchObject({ handled: true, outcome: "hq-fee-free-none", react: null });
  expect(out.replyText).toMatch(/^Riley Rater has already paid for .+, so I've left it as paid\. The money collector can refund it if they should play free\.$/);
  const r = await db.one<{ paidAt: Date | null; feeWaivedAt: Date | null }>(
    `SELECT "paidAt", "feeWaivedAt" FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.pay, U.rater],
  );
  expect(r?.paidAt).not.toBeNull();
  expect(r?.feeWaivedAt).toBeNull();
});

test("someone in HQ who is not an organiser: the #297 line, nothing waived", async ({ request, db }) => {
  const out = await say(request, FREE_ASK, PLAYER);
  expect(out).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null });
  expect((await waived(db, U.fresh)).at).toBeNull();
});

test("after the free place: the daily chase skips him and still chases the unpaid", async ({ request }) => {
  await say(request, FREE);
  const now = londonAt(0, 18, 30);
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`, {
    headers: { ...KEY, "x-test-now": now.toISOString(), "x-no-claim": "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const keys = ((await res.json()).instructions as Array<{ key?: string }>).map((i) => i.key ?? "");
  expect(keys.some((k) => k.startsWith(`${MATCH.pay}:pay-chase:${U.fresh}:`))).toBe(false);
  // Pat, still unpaid, is chased as before.
  expect(keys.some((k) => k.startsWith(`${MATCH.pay}:pay-chase:${U.player}:`))).toBe(true);
});
