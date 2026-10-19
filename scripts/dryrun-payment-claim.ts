/**
 * LIVE dry run for the player payment-claim classifier (2026-09-23).
 *
 * A stubbed test proves the WIRING: a "paid" verdict marks the player
 * pending and tells the collector, an "other" writes nothing. It cannot
 * prove that the real model reads "Paid", "done 👍" and "gönderdim abi"
 * as claims while refusing "I'll pay later" and "did you get my
 * payment?". Only the real model can, so this asks it, repeatedly.
 *
 *   REPEAT=3 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-payment-claim.ts
 *   SET=heldout REPEAT=3 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-payment-claim.ts
 *   SET=feroz REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-payment-claim.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Touches no
 * database, sends nothing, writes nothing: it imports the DB-free
 * classifier module and prints what came back, with a running cost and
 * a hard stop at MAX_USD.
 *
 * Approved by Kemal on 2026-09-23 for this change, capped at $0.30.
 * Approved again on 2026-10-18 for the collector rewrite (Feroz, FNF):
 * SET=feroz once, plus one pass of SET=main and SET=heldout.
 */
import Anthropic from "@anthropic-ai/sdk";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import {
  PAYMENT_CLAIM_MODEL,
  PAYMENT_CLAIM_STUB_FILE_ENV,
  classifyPaymentClaimDetailed,
  type PaymentClaimContext,
  type PaymentClaimIntent,
} from "../src/lib/payment-claim-classifier.ts";
import { buildPayChaseDm, buildRatingDm } from "../src/lib/dm-copy.ts";
import { costOf } from "../src/lib/pipeline/llm.ts";
import { HAIKU_MODEL } from "../src/lib/models.ts";

const REPEAT = Number(process.env.REPEAT ?? "3") || 3;
/** The shared Haiku id, so the model-pin guard (`no-sonnet-4-5-pins.test.ts`)
 *  can resolve it; `main` refuses to run if it drifts from production's pin. */
const MODEL = HAIKU_MODEL;
/** Hard cap for this run, in US dollars. */
const MAX_USD = 0.3;


/** What the player was last sent, the context the route supplies: the
 *  real composers, so the model sees the words players actually get. */
const PAY_CHASE = buildPayChaseDm({
  playerName: "Abid Kazmi",
  dayNum: 1,
  fee: 8,
  activityName: "Tuesday 7-a-side",
  url: "https://mt.example/s/pay",
  methods: ["card", "direct"],
  collectorName: "Kemal Ediz",
  lang: "en",
});
const RATING_DM = buildRatingDm({
  activityName: "Tuesday 7-a-side",
  dateLabel: "Tue 22 Sep",
  mvpLabel: "Man of the Match",
  rateUrl: "https://mt.example/s/rate",
  statsUrl: "https://mt.example/s/stats",
  lang: "en",
});

/** The route always names the money collector now (2026-10-18). */
const CTX: PaymentClaimContext = {
  playerName: "Abid Kazmi",
  owes: "£8 for Tuesday 7-a-side",
  collectorName: "Kemal Ediz",
  lastBotDm: PAY_CHASE,
};

/** Feroz, FNF 2026-10-18: the exact context the route had (his last
 *  BotJob DM, verbatim), plus the collector it now passes. */
const FEROZ_PAY_LINK =
  "💷 Feroz, match fee for *Football 9-a-side* is *£5*.\n\nTap to pay (bank, card, Apple or Google Pay, or pay the organiser directly): https://mt.example/s/pay\n\nYou can also pay for anyone you brought along.";
const FEROZ: PaymentClaimContext = {
  playerName: "Feroz",
  owes: "£5 for Football 9-a-side",
  collectorName: "Raihan",
  lastBotDm: FEROZ_PAY_LINK,
};
/** The descriptions `pickLastBotDm` gives a scheduler DM (key only). */
const PAY_CHASE_ABOUT = "(a reminder to pay the match fee they owe, with their pay link)";
const RATE_ABOUT = "(a request to rate their teammates from the last match)";

interface Case {
  text: string;
  want: PaymentClaimIntent;
  ctx?: PaymentClaimContext;
}

const CASES: Case[] = [
  // ── positives: a completed payment, stated by the sender ──
  { text: "Paid", want: "paid" },
  { text: "sent it", want: "paid" },
  { text: "done 👍", want: "paid" },
  { text: "transferred", want: "paid" },
  { text: "just paid you", want: "paid" },
  { text: "ödedim", want: "paid" },
  { text: "gönderdim abi", want: "paid" },
  { text: "yolladım", want: "paid" },
  { text: "tamam ödedim", want: "paid" },
  // ── paying for someone else: its own intent, nothing is written ──
  { text: "paid for me and my mate", want: "paid_for_others" },
  // ── negatives: payment words, not a claim ──
  { text: "I'll pay later", want: "other" },
  { text: "haven't paid yet", want: "other" },
  { text: "how much do I owe?", want: "other" },
  { text: "did you get my payment?", want: "other" },
  { text: "paid last week", want: "other" },
  { text: "can I pay by bank transfer?", want: "other" },
  { text: "sonra öderim", want: "other" },
  { text: "daha ödemedim", want: "other" },
  { text: "ne kadar borcum var?", want: "other" },
  { text: "parayı aldın mı?", want: "other" },
  // a bare "done" that answers the RATING DM, not the pay chase
  { text: "done 👍", want: "other", ctx: { ...CTX, lastBotDm: RATING_DM } },
];

/**
 * HELD OUT: phrasings that appear nowhere in the prompt, so a pass here
 * is the model generalising rather than matching an example it was
 * shown. `SET=heldout` runs these instead of CASES.
 */
const HELD_OUT: Case[] = [
  { text: "all sent mate", want: "paid" },
  { text: "money's in your account", want: "paid" },
  { text: "paid the 8 quid", want: "paid" },
  { text: "hallettim parayı", want: "paid" },
  { text: "parayı gönderdim kardeşim", want: "paid" },
  { text: "paying tonight", want: "other" },
  { text: "is it 8 or 10 this week?", want: "other" },
  { text: "yarın gönderirim", want: "other" },
  { text: "maç kaça geldi?", want: "other" },
  { text: "why do I owe for a game I didn't play?", want: "other" },
];

/**
 * THE COLLECTOR (Feroz, FNF 2026-10-18). Paying the named collector is a
 * claim; a plan, a question, or paying somebody else is not. The prompt's
 * examples use "Sam", so these Raihan cases are held out too.
 * `SET=feroz` runs these.
 */
const COLLECTOR: Case[] = [
  { text: "I bank transferred Raihan", want: "paid", ctx: FEROZ },
  { text: "I bank transferred Raihan", want: "paid", ctx: { ...FEROZ, lastBotDm: PAY_CHASE_ABOUT } },
  { text: "sent it to Raihan", want: "paid", ctx: FEROZ },
  { text: "paid Raihan cash", want: "paid", ctx: FEROZ },
  { text: "Raihan'a havale yaptım", want: "paid", ctx: FEROZ },
  { text: "Raihan'a gönderdim", want: "paid", ctx: FEROZ },
  // A plan to pay the collector directly is the settle-directly button
  // said in words (Kemal, 2026-10-18).
  { text: "will send Raihan tonight", want: "will_pay_direct", ctx: FEROZ },
  { text: "I'll transfer Raihan later", want: "will_pay_direct", ctx: FEROZ },
  { text: "I'll give Raihan cash on Friday", want: "will_pay_direct", ctx: FEROZ },
  { text: "Raihan'a akşam gönderirim", want: "will_pay_direct", ctx: FEROZ },
  { text: "Raihan'a cuma günü elden veririm", want: "will_pay_direct", ctx: FEROZ },
  // ...but a plan that does not choose the collector is still the pay link.
  { text: "will pay tomorrow", want: "other", ctx: FEROZ },
  { text: "yarın öderim", want: "other", ctx: FEROZ },
  { text: "can I pay Raihan directly?", want: "other", ctx: FEROZ },
  { text: "will give it to Ali", want: "other", ctx: FEROZ },
  { text: "did Raihan get it?", want: "other", ctx: FEROZ },
  { text: "Raihan'a ulaştı mı?", want: "other", ctx: FEROZ },
  { text: "paid Ali", want: "other", ctx: FEROZ },
  { text: "Ali'ye verdim", want: "other", ctx: FEROZ },
  { text: "done 👍", want: "other", ctx: { ...FEROZ, lastBotDm: RATE_ABOUT } },
];

async function main() {
  const key = spendDevApiKeyOrExit("scripts/dryrun-payment-claim.ts");
  if (process.env[PAYMENT_CLAIM_STUB_FILE_ENV]) {
    console.error(`REFUSING: ${PAYMENT_CLAIM_STUB_FILE_ENV} is set, this would measure the stub.`);
    process.exit(1);
  }

  if (MODEL !== PAYMENT_CLAIM_MODEL) {
    console.error(`REFUSING: this harness pins ${MODEL} but production classifies with ${PAYMENT_CLAIM_MODEL}.`);
    process.exit(1);
  }
  const anthropic = new Anthropic({ apiKey: key });
  let calls = 0;
  let usd = 0;
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  /** The production call's exact shape (model, max_tokens, cached system
   *  block), with the usage recorded so the cap is enforced on real cost. */
  const call = async (system: string, user: string): Promise<string> => {
    if (usd >= MAX_USD) throw new Error(`cost cap $${MAX_USD} reached`);
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: user }],
    });
    calls++;
    const u = r.usage;
    tokens.input += u.input_tokens;
    tokens.output += u.output_tokens;
    tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    // The production rate table, so the cap follows the model. Every
    // write here is a 1-hour one (the system block above asks for it).
    usd =
      costOf(MODEL, {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        cacheWrite1hTokens: tokens.cacheWrite,
      }) ?? Infinity;
    const block = r.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  };

  console.log(`── payment-claim classifier, ${PAYMENT_CLAIM_MODEL}, REPEAT=${REPEAT}, cap $${MAX_USD} ──`);
  let bad = 0;
  const sets: Record<string, Case[]> = { main: CASES, heldout: HELD_OUT, feroz: COLLECTOR };
  const setName = process.env.SET && sets[process.env.SET] ? process.env.SET : "main";
  const set = sets[setName];
  console.log(`set: ${setName} (${set.length} cases)`);
  for (const c of set) {
    const got: string[] = [];
    for (let i = 0; i < REPEAT; i++) {
      if (usd >= MAX_USD) {
        console.error(`\nSTOPPED: cost cap $${MAX_USD} reached after ${calls} calls.`);
        process.exit(2);
      }
      const r = await classifyPaymentClaimDetailed(c.text, c.ctx ?? CTX, call);
      got.push(`${r.intent}@${r.confidence.toFixed(2)}`);
    }
    const agreed = got.filter((g) => g.startsWith(`${c.want}@`)).length;
    const pass = agreed === REPEAT;
    if (!pass) bad++;
    const note =
      c.ctx?.lastBotDm === RATING_DM || c.ctx?.lastBotDm === RATE_ABOUT
        ? " (after the rating DM)"
        : c.ctx?.lastBotDm === PAY_CHASE_ABOUT
          ? " (after a pay chase, key only)"
          : "";
    console.log(
      `  ${pass ? "✓" : "✗"} ${agreed}/${REPEAT}  want=${c.want.padEnd(15)} got=[${got.join(", ")}]  ${JSON.stringify(c.text)}${note}`,
    );
  }

  console.log(
    `\n${set.length - bad}/${set.length} cases fully agreed. ${calls} live calls. ` +
      `tokens: in ${tokens.input}, out ${tokens.output}, cache write ${tokens.cacheWrite}, cache read ${tokens.cacheRead}. ` +
      `cost ≈ $${usd.toFixed(4)}`,
  );
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
