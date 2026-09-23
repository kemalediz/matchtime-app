/**
 * /api/whatsapp/dm-reply: A PLAYER DMs "Paid" (2026-09-23), END TO END.
 *
 * Drives the real route through the `MT_TEST_PAYMENT_CLAIM_STUB_FILE`
 * seam, which stubs only what the MODEL said. The owed-match gate, the
 * settle-directly write (`markDirectPaymentPending`, the pay page's own
 * implementation), the collector's DM and the player's reply are all the
 * shipped code, against the seeded PAY match (fee £8, links released).
 *
 * The first assertion that matters: after a claim the player is PENDING,
 * never paid. Only the collector's confirmation sets paidAt.
 */
import { test, expect, resetDb } from "../fixtures";
import { U, ORG_ID, PHONE, MATCH } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { setPaymentClaimStub, clearPaymentClaimStub } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test.afterAll(() => {
  clearPaymentClaimStub();
});

let n = 0;
async function postDm(request: APIRequestContext, phone: string, body: string, waMessageId?: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: waMessageId ?? `e2e-paid-${Date.now()}-${++n}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const row = (db: TestDb, userId: string) =>
  db.one<{ paidAt: Date | null; directPendingAt: Date | null; paymentMethod: string | null; paymentAmount: number | null }>(
    `SELECT "paidAt", "directPendingAt", "paymentMethod", "paymentAmount"
       FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.pay, userId],
  );

/** The collector's "says they've paid you directly" notices. */
const collectorClaimDms = (db: TestDb) =>
  db.all<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2 AND text LIKE '%paid you directly%'`,
    [ORG_ID, PHONE.collector.replace(/^\+/, "")],
  );

const dmsTo = (db: TestDb, phone: string) =>
  db.all<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC`,
    [phone.replace(/^\+/, "")],
  );

test("'Paid' from an owing player: PENDING (never paid), collector told once, player thanked", async ({
  request,
  db,
}) => {
  setPaymentClaimStub({ bodies: { Paid: "paid" } });
  const before = (await collectorClaimDms(db)).length;

  const json = await postDm(request, PHONE.player, "Paid");
  expect(json.handled).toBe("paid-claim");

  const r = await row(db, U.player);
  expect(r?.paidAt).toBeNull();
  expect(r?.directPendingAt).not.toBeNull();
  expect(r?.paymentMethod).toBe("direct");
  expect(Number(r?.paymentAmount)).toBe(8);

  const notices = await collectorClaimDms(db);
  expect(notices).toHaveLength(before + 1);
  expect(notices.at(-1)?.text).toContain("*Pat Player* says they've paid you directly");

  const reply = (await dmsTo(db, PHONE.player))[0];
  expect(reply.text).toBe(
    "Thanks Pat, I've told Colin you've paid *£8* for *E2E 5-a-side*. Colin will confirm once it lands 👍",
  );
});

test("a second 'Paid': the collector is NOT told again, the player gets the short reply", async ({
  request,
  db,
}) => {
  setPaymentClaimStub({ bodies: { "paid 👍": "paid" } });
  const before = (await collectorClaimDms(db)).length;
  const json = await postDm(request, PHONE.player, "paid 👍");
  expect(json).toMatchObject({ handled: "paid-claim", alreadyPending: true, collectorNotified: false });
  expect(await collectorClaimDms(db)).toHaveLength(before);
  expect((await dmsTo(db, PHONE.player))[0].text).toMatch(/^Already done Pat: Colin knows about your \*£8\*/);
  expect((await row(db, U.player))?.paidAt).toBeNull();
});

test("a replay of the SAME WhatsApp message is silent", async ({ request, db }) => {
  setPaymentClaimStub({ bodies: { Paid: "paid" } });
  const id = `e2e-paid-replay-${Date.now()}`;
  await postDm(request, PHONE.fresh, "Paid", id);
  const replies = (await dmsTo(db, PHONE.fresh)).length;
  const json = await postDm(request, PHONE.fresh, "Paid", id);
  expect(json.handled).toBe("paid-claim-replay");
  expect(await dmsTo(db, PHONE.fresh)).toHaveLength(replies);
});

test("not a claim ('I'll pay later'): nothing written, falls through", async ({ request, db }) => {
  resetDb();
  setPaymentClaimStub({}); // the model says `other`
  const json = await postDm(request, PHONE.player, "I'll pay later");
  expect(json.handled).not.toBe("paid-claim");
  const r = await row(db, U.player);
  expect(r?.directPendingAt).toBeNull();
  expect(r?.paidAt).toBeNull();
});

test("paying for a mate: nothing written, the pay link is sent back", async ({ request, db }) => {
  setPaymentClaimStub({ bodies: { "paid for me and my mate": "paid_for_others" } });
  const json = await postDm(request, PHONE.player, "paid for me and my mate");
  expect(json.handled).toBe("paid-claim-for-others");
  expect((await row(db, U.player))?.directPendingAt).toBeNull();
  expect((await dmsTo(db, PHONE.player))[0].text).toMatch(/how many people you paid for[\s\S]*http/);
});

test("nothing owed (already paid): the classifier is not consulted and nothing changes", async ({
  request,
  db,
}) => {
  setPaymentClaimStub({ bodies: { Paid: "paid" } });
  const before = await row(db, U.rater);
  const json = await postDm(request, PHONE.rater, "Paid");
  expect(json.handled).not.toBe("paid-claim");
  const after = await row(db, U.rater);
  expect(after?.paidAt).toEqual(before?.paidAt);
  expect(after?.directPendingAt).toBeNull();
});

test("the collector's own 'Paid' is not a claim against themselves", async ({ request, db }) => {
  setPaymentClaimStub({ bodies: { Paid: "paid" } });
  const json = await postDm(request, PHONE.collector, "Paid");
  expect(json.handled).not.toBe("paid-claim");
  expect((await row(db, U.collector))?.directPendingAt).toBeNull();
});
