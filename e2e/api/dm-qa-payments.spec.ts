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
import { PHONE, NAME, ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import { addDmIntentBodies, clearDmIntentStub, clearExtractorStub, clearPaymentClaimStub, helpOn } from "../helpers/stub";

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  resetDb();
  clearPaymentClaimStub();
});

test.afterAll(() => {
  clearExtractorStub();
  clearDmIntentStub();
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

// Club summary B5, decision K3: the upcoming match has no fee confirmed by
// the collector yet, so the model is told the game's usual fee AND that it is
// not confirmed yet (before B5: "Usual match fee: £8 per player").
test("the upcoming match's fee is the usual one, marked not confirmed yet", async ({ request, db }) => {
  // What the DM reader reads it as (live: a question; the live spec proves it).
  addDmIntentBodies({ "how much is the next game?": "question" });
  const json = await postDm(request, PHONE.player, "how much is the next game?");
  expect(json.handled).toBe("dm-qa");
  const answer = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 AND text LIKE '[scoped-qa-stub]%' ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(PHONE.player)],
  );
  const ctx = answer?.text ?? "";
  expect(ctx).toContain("- Upcoming match's fee: not confirmed yet. The usual fee is £8 per player; the money collector confirms it after the game.");
  expect(ctx).not.toContain("Usual match fee");
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

// "How do I pay?" (2026-11-04). The help reader reads it as help about
// payments (what the live model returned, dm-qa-payments-live), which is
// right for anyone with nothing to pay. A player who OWES is asking about
// his own fee: the help gives way and the DM Q&A answers with his pay
// link. The facts decide (his open fee), never his words.
const HOW = { en: "how do I pay?", tr: "nasıl ödeyebilirim?" } as const;

function readHowAsPaymentsHelp() {
  helpOn({ [HOW.en]: { feature: "payments" }, [HOW.tr]: { feature: "payments" } });
  addDmIntentBodies({ [HOW.en]: "question", [HOW.tr]: "question" });
}

const lastDmTo = (db: TestDb, phone: string) =>
  db.one<{ text: string }>(`SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC LIMIT 1`, [
    digits(phone),
  ]);

for (const lang of ["en", "tr"] as const) {
  test(`a player who owes asking how to pay (${lang}) gets his own fee and pay link, not the fees explainer`, async ({
    request,
    db,
  }) => {
    readHowAsPaymentsHelp();
    if (lang === "tr") await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
    const json = await postDm(request, PHONE.player, HOW[lang]);
    const sent = await lastDmTo(db, PHONE.player);
    expect(json.handled, `reply sent: ${JSON.stringify(sent?.text)}`).toBe("dm-qa");
    expect(sent?.text).toMatch(/^\[scoped-qa-stub\]/);
    expect(sent?.text).toMatch(/: owes £8, not paid yet\. Pay link: https?:\/\/\S+/);
  });
}

test("a player with nothing to pay asking how to pay still gets the fees explainer", async ({ request, db }) => {
  readHowAsPaymentsHelp();
  const json = await postDm(request, PHONE.rater, HOW.en);
  expect(json).toMatchObject({ handled: "dm-help", topic: "payments", audience: "player" });
  expect((await lastDmTo(db, PHONE.rater))?.text).toContain("Match fees: how it works");
});
