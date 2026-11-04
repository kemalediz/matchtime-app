/**
 * A PLAYER'S MONEY QUESTIONS IN A DM, LIVE-LLM, END TO END (Kemal,
 * 2026-10-20).
 *
 * The free spec (`api/dm-qa-payments.spec.ts`) proves what the model is
 * TOLD. This drives the REAL model through the REAL /api/whatsapp/dm-reply
 * route, no stub: the payment-claim classifier reads each question first
 * (it must not take a question for a claim), then the DM Q&A answers it.
 * One path per case type, in English and in Turkish, once each (Kemal's
 * cheap test plan).
 *
 * The seeded pay match: Pat owes £8, Riley has paid by card, Gary is
 * waiting on the collector.
 *   - "how much do I owe?"    Pat: £8 and his pay link
 *   - "did you get my payment?" Riley: recorded, no link
 *   - "how do I pay?"         Pat: his pay link
 *   - "has Riley paid?"       Pat: nothing about Riley's payment
 *   - "how much is the next game?" Pat: the usual £8, not confirmed yet (B5, K3)
 *
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/dm-qa-payments-live.spec.ts
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { othersPayLeak } from "../helpers/payment-privacy";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const digits = (p: string) => p.replace(/^\+/, "");
const URL_RE = /https?:\/\/\S+/;

let n = 0;
async function ask(request: APIRequestContext, db: TestDb, phone: string, body: string): Promise<string> {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body, waMessageId: `live-qapay-${Date.now()}-${++n}`, authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = await res.json();
  expect(json.handled, `"${body}" must reach the DM Q&A, not a payment claim (${JSON.stringify(json)})`).toBe("dm-qa");
  const answer = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(phone)],
  );
  console.log(`[dm-qa-payments-live] ${JSON.stringify(body)} -> ${JSON.stringify(answer?.text)}`);
  return answer?.text ?? "";
}

for (const lang of ["en", "tr"] as const) {
  const Q =
    lang === "en"
      ? { owe: "how much do I owe?", got: "did you get my payment?", how: "how do I pay?", other: "has Riley paid?", next: "how much is the next game?" }
      : { owe: "ne kadar borcum var?", got: "ödememi aldınız mı?", how: "nasıl ödeyebilirim?", other: "Riley ödedi mi?", next: "bir sonraki maç kaç para?" };

  (LIVE ? test.describe : test.describe.skip)(`DM Q&A payments LIVE, ${lang} (real Anthropic model)`, () => {
    test.describe.configure({ mode: "serial" });
    test.beforeEach(async ({ db }) => {
      resetDb();
      if (lang === "tr") await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
    });

    test(`what he owes: "${Q.owe}"`, async ({ request, db }) => {
      test.setTimeout(120_000);
      const a = await ask(request, db, PHONE.player, Q.owe);
      expect(a).toMatch(/£\s?8|8\s?£/);
      expect(othersPayLeak(a, lang, ["Riley", "Gary"])).toBe(false);
    });

    test(`whether his payment is recorded: "${Q.got}"`, async ({ request, db }) => {
      test.setTimeout(120_000);
      const a = await ask(request, db, PHONE.rater, Q.got);
      expect(a).not.toMatch(URL_RE);
      expect(a).toMatch(lang === "en" ? /paid|recorded/i : /ödendi|ödemiş|ödedin|kayıtl|alındı|ödemen/i);
      expect(othersPayLeak(a, lang, ["Pat", "Gary"])).toBe(false);
      // B5, K3: the upcoming match's fee is given when asked, not added here.
      expect(a).not.toMatch(lang === "en" ? /usual fee|not (yet )?confirmed|isn't confirmed/i : /genelde|kesinleşme/i);
    });

    test(`how to pay: "${Q.how}"`, async ({ request, db }) => {
      test.setTimeout(120_000);
      const a = await ask(request, db, PHONE.player, Q.how);
      expect(a).toMatch(URL_RE);
      expect(othersPayLeak(a, lang, ["Riley", "Gary"])).toBe(false);
    });

    // Club summary B5, decision K3: the upcoming match's fee is not
    // confirmed by the collector yet, so the answer gives the usual £8 AND
    // says it is not confirmed yet.
    test(`the next game's fee before the collector confirms it: "${Q.next}"`, async ({ request, db }) => {
      test.setTimeout(120_000);
      const a = await ask(request, db, PHONE.player, Q.next);
      expect(a).toMatch(/£\s?8|8\s?£/);
      expect(a).toMatch(lang === "en" ? /not (yet )?(been )?confirmed|isn't confirmed|unconfirmed|to be confirmed/i : /kesinleşme|kesinleşmedi|onaylanmadı|teyit edilmedi/i);
      expect(othersPayLeak(a, lang, ["Riley", "Gary"])).toBe(false);
    });

    test(`someone else's payment is never told: "${Q.other}"`, async ({ request, db }) => {
      test.setTimeout(120_000);
      const a = await ask(request, db, PHONE.player, Q.other);
      expect(othersPayLeak(a, lang, ["Riley"])).toBe(false);
    });

    // Club summary, slice B7: stats answers off. The players' group answers
    // no stats question, so the DM says they are switched off, and still
    // answers about money.
    test(`stats answers off: "${lang === "en" ? "how are my stats looking?" : "istatistiklerim nasıl?"}"`, async ({ request, db }) => {
      test.setTimeout(120_000);
      await db.run(`UPDATE "Organisation" SET "featureStatsQa" = false WHERE id = $1`, [ORG_ID]);
      const a = await ask(request, db, PHONE.player, lang === "en" ? "how are my stats looking?" : "istatistiklerim nasıl?");
      expect(a).toMatch(lang === "en" ? /switched off|turned off/i : /kapal|kapat/i);
    });
  });
}
