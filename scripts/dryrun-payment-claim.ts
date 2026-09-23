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
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Touches no
 * database, sends nothing, writes nothing: it imports the DB-free
 * classifier module and prints what came back, with a running cost and
 * a hard stop at MAX_USD.
 *
 * Approved by Kemal on 2026-09-23 for this change, capped at $0.30.
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

const REPEAT = Number(process.env.REPEAT ?? "3") || 3;
/** A literal, so the model-pin guard (`no-sonnet-4-5-pins.test.ts`) can
 *  read it; `main` refuses to run if it drifts from production's pin. */
const MODEL = "claude-haiku-4-5";
/** Hard cap for this run, in US dollars. */
const MAX_USD = 0.3;

/** Haiku 4.5, USD per million tokens. The 1h cache write is 2x input. */
const PRICE = { input: 1, output: 5, cacheWrite1h: 2, cacheRead: 0.1 };

/** What the player was last sent, the context the route supplies: the
 *  real composers, so the model sees the words players actually get. */
const PAY_CHASE = buildPayChaseDm({
  playerName: "Abid Kazmi",
  dayNum: 1,
  fee: 8,
  activityName: "Tuesday 7-a-side",
  url: "https://mt.example/s/pay",
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

const CTX: PaymentClaimContext = { playerName: "Abid Kazmi", owes: "£8 for Tuesday 7-a-side", lastBotDm: PAY_CHASE };

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
    usd =
      (tokens.input * PRICE.input +
        tokens.output * PRICE.output +
        tokens.cacheWrite * PRICE.cacheWrite1h +
        tokens.cacheRead * PRICE.cacheRead) /
      1_000_000;
    const block = r.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  };

  console.log(`── payment-claim classifier, ${PAYMENT_CLAIM_MODEL}, REPEAT=${REPEAT}, cap $${MAX_USD} ──`);
  let bad = 0;
  const set = process.env.SET === "heldout" ? HELD_OUT : CASES;
  console.log(`set: ${process.env.SET === "heldout" ? "held out" : "main"} (${set.length} cases)`);
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
    const note = c.ctx?.lastBotDm === RATING_DM ? " (after the rating DM)" : "";
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
