/**
 * LIVE dry run for a month payment read by a model (2026-10-29): the
 * player's "paid" (the payment DM step, `payment-claim-classifier.ts`, told
 * what he owes for the month) and the collector's answer to the paid-claims
 * list (`month-digest-reply.ts`). Each case ONCE. Spends
 * ANTHROPIC_API_KEY_DEV only; no database.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-month-payment-words.ts
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { classifyPaymentClaimDetailed } from "../src/lib/payment-claim-classifier.ts";
import { readDigestReply } from "../src/lib/month-digest-reply.ts";
import { HAIKU_CALL } from "../src/lib/pipeline/llm.ts";

const MAX_USD = 0.1;
async function main() {
  const inner = anthropicModel({ apiKey: spendDevApiKeyOrExit("dryrun-month-payment-words") });
  let calls = 0;
  let usd = 0;
  const model: PipelineModel = {
    name: "metered",
    complete: async (req) => {
      if (usd >= MAX_USD) throw new Error("cost cap");
      const r = await inner.complete(req);
      calls++;
      usd += r.costUsd ?? 0.01;
      return r;
    },
  };
  // The payment-claim classifier takes a (system, user) call.
  const call = async (system: string, user: string) =>
    (await model.complete({ ...HAIKU_CALL, system, user, maxTokens: 1024, label: "payment-claim" })).text;
  let pass = 0;
  let total = 0;
  const owes = { playerName: "Bilal Aydin", owes: "£37.50 for November (the month's games)", collectorName: "Davide De Souza", replyContext: null };
  for (const [text, want] of [
    ["paid", "paid"],
    ["Paid 👍", "paid"],
    ["sent Davide the £37.50", "paid"],
    ["ödedim", "paid"],
    ["have I paid?", "other"],
    ["will pay Friday", "other"],
  ] as const) {
    total++;
    const r = await classifyPaymentClaimDetailed(text, owes, call);
    const ok = r.intent === want;
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"} paid ${JSON.stringify(text)} got ${r.intent} (want ${want})`);
  }
  const lists = [{ month: 11, monthName: "November", lines: [{ slot: 1, name: "Alex" }, { slot: 3, name: "Steff" }, { slot: 4, name: "Ben" }] }];
  for (const [text, want] of [
    ["PAID ALL", "all"],
    ["all in, cheers", "all"],
    ["1 and 3 are in", "numbers:1,3"],
    ["Steff and Ben paid", "numbers:3,4"],
    ["ÖDENDİ HİÇBİRİ", "none"],
    ["nothing yet", "none"],
    ["paid £30", "other"],
    ["4", "other"],
    ["what time is kick off?", "other"],
  ] as const) {
    total++;
    const r = await readDigestReply(lists, text, { model });
    const got = r ? (r.kind === "numbers" ? `numbers:${[...r.numbers].sort().join(",")}` : r.kind) : "other";
    const ok = got === want;
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"} collector ${JSON.stringify(text)} got ${got} (want ${want})`);
  }
  console.log(`\n${pass}/${total} as expected. ${calls} live calls, cost ≈ $${usd.toFixed(4)}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
