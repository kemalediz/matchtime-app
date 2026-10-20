/**
 * /api/whatsapp/dm-reply: A PLAYER'S MONEY QUESTION IS ANSWERED FROM HIS
 * OWN PAYMENTS, AND NOBODY ELSE'S (Kemal, 2026-10-20).
 *
 * Drives the real route with the DM Q&A stub on, which returns the
 * CONTEXT the model would have been shown, so the privacy is asserted
 * STRUCTURALLY: on the seeded pay match Pat owes £8, Riley has paid by
 * card and Gary is waiting on the collector, and Pat's context carries
 * Pat's line only. The payment-claim stub reads every body as `other`, so
 * a question falls through to the Q&A as it does live.
 *
 * Free: no model is called.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { PHONE, NAME } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { clearPaymentClaimStub } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  resetDb();
  clearPaymentClaimStub();
});

let n = 0;
async function postDm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `e2e-qapay-${Date.now()}-${++n}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const digits = (p: string) => p.replace(/^\+/, "");

test("a player asking what he owes is shown his own unpaid fee, his pay link and how to pay", async ({ request, db }) => {
  const json = await postDm(request, PHONE.player, "how much do I owe?");
  expect(json.handled).toBe("dm-qa");
  const answer = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 AND text LIKE '[scoped-qa-stub]%' ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(PHONE.player)],
  );
  const ctx = answer?.text ?? "";
  expect(ctx).toContain("YOUR PAYMENTS");
  expect(ctx).toMatch(/: owes £8, not paid yet\. Pay link: https?:\/\/\S+/);
  expect(ctx).toContain(`- Money collector: ${NAME.collector}`);
  expect(ctx).toContain(`- Ways to pay: pay by bank, card, pay ${NAME.collector} directly`);
  // Nobody else's payment: Riley paid, Gary is pending. Neither state,
  // and no count of payers, is in his context.
  expect(ctx).not.toContain("settling with");
  expect(ctx.match(/owes £|paid: payment received/g) ?? []).toHaveLength(1);
});

test("the collector is told he has nothing to pay", async ({ request, db }) => {
  const json = await postDm(request, PHONE.collector, "how much do I owe?");
  expect(json.handled).toBe("dm-qa");
  const answer = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 AND text LIKE '[scoped-qa-stub]%' ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(PHONE.collector)],
  );
  expect(answer?.text).toContain("You collect this club's match fees, so you have nothing to pay.");
  expect(answer?.text).not.toContain("Pay link");
});

test("a player who paid sees it recorded, with no pay link", async ({ request, db }) => {
  const json = await postDm(request, PHONE.rater, "did you get my payment?");
  expect(json.handled).toBe("dm-qa");
  const answer = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 AND text LIKE '[scoped-qa-stub]%' ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(PHONE.rater)],
  );
  expect(answer?.text).toContain("paid: payment received and recorded. Nothing to pay.");
  expect(answer?.text).not.toContain("Pay link");
});
