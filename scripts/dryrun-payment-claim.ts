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
 *   SET=s2 REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-payment-claim.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Touches no
 * database, sends nothing, writes nothing: it imports the DB-free
 * classifier module and prints what came back, with a running cost and
 * a hard stop at MAX_USD.
 *
 *   SET=all REPEAT=1 ...   every set once (the P5 check, 2026-10-30), SET=amount the stated amounts
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
import {
  contextMatchLabel,
  pickRecentBotMessages,
  type ContextMessage,
  type ReplyContext,
} from "../src/lib/reply-context.ts";
import { costOf, systemBlock } from "../src/lib/pipeline/llm.ts";
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING } from "../src/lib/models.ts";

const REPEAT = Number(process.env.REPEAT ?? "3") || 3;
/** The shared Haiku id, so the model-pin guard (`no-sonnet-4-5-pins.test.ts`)
 *  can resolve it; `main` refuses to run if it drifts from production's pin. */
const MODEL = HAIKU_MODEL;
/** Hard cap for this run, in US dollars. */
const MAX_USD = 0.04;


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

// ── The chat context, as `loadDmReplyContext` builds it ──
/** Mon 19 Oct 2026, 18:00 London. */
const NOW = new Date("2026-10-19T17:00:00Z");
const TUE = contextMatchLabel("Tuesday 7-a-side", new Date("2026-10-13T19:00:00Z"));
/** Not a swipe-reply: MatchTime's recent DMs, picked as production picks them. */
const sent = (...msgs: ContextMessage[]): ReplyContext => ({ now: NOW, quoted: null, ...pickRecentBotMessages(msgs, NOW) });
/** A swipe-reply: that message alone. */
const quoting = (m: ContextMessage): ReplyContext => ({ now: NOW, quoted: m, recent: [], earlier: null });
/** The scheduler's pay chase: its words since S0, its topic and match. */
const payChaseMsg: ContextMessage = { at: new Date("2026-10-19T16:00:00Z"), text: PAY_CHASE, topic: "paymentCollection", match: TUE };
/** The rating request, a scheduler DM. */
const ratingMsg = (at: string): ContextMessage => ({ at: new Date(at), text: RATING_DM, topic: "playerRating", match: TUE });

/** The route always names the money collector now (2026-10-18). */
const CTX: PaymentClaimContext = {
  playerName: "Abid Kazmi",
  // The route's owes line carries the match's day and time (review of #336).
  owes: `£8 for ${TUE}`,
  collectorName: "Kemal Ediz",
  replyContext: sent(payChaseMsg),
};

/** Feroz, FNF 2026-10-18: the exact context the route had (his last
 *  BotJob DM, verbatim), plus the collector it now passes. */
const FEROZ_PAY_LINK =
  "💷 Feroz, match fee for *Football 9-a-side* is *£5*.\n\nTap to pay (bank, card, Apple or Google Pay, or pay the organiser directly): https://mt.example/s/pay\n\nYou can also pay for anyone you brought along.";
/** A queued BotJob: its words, no key topic. */
const ferozPayLinkMsg: ContextMessage = { at: new Date("2026-10-18T20:46:00Z"), text: FEROZ_PAY_LINK, topic: null, match: null };
const FEROZ: PaymentClaimContext = {
  playerName: "Feroz",
  owes: `£5 for ${contextMatchLabel("Football 9-a-side", new Date("2026-10-16T20:00:00Z"))}`,
  collectorName: "Raihan",
  replyContext: sent(ferozPayLinkMsg),
};
/** Scheduler DMs from before S0 stored their words: key topic only. */
const PAY_CHASE_ABOUT = sent({ at: new Date("2026-10-19T16:04:00Z"), text: null, topic: "paymentCollection", match: null });
const RATE_ABOUT = sent({ at: new Date("2026-10-19T16:01:00Z"), text: null, topic: "playerRating", match: null });

interface Case {
  text: string;
  want: PaymentClaimIntent;
  ctx?: PaymentClaimContext;
  /** What the context is, for the table. */
  note?: string;
  /** The stated amount the model must return (2026-10-30); null: none
   *  stated. Absent: not checked. */
  amount?: number | null;
}

/** P5 (2026-10-30): the amount a message states, checked against the owed
 *  fee by code. Every case says what amount the model must return. */
const AMOUNT: Case[] = [
  { text: "Paid", want: "paid", amount: null },
  { text: "sent Kemal £8", want: "paid", amount: 8 },
  { text: "sent you 10 quid", want: "paid", amount: 10 },
  { text: "paid £8 by bank transfer", want: "paid", amount: 8 },
  { text: "Kemal'e 8 pound attım", want: "paid", amount: 8 },
  { text: "ödedim", want: "paid", amount: null },
  { text: "will give Kemal £8 cash tonight", want: "will_pay_direct", amount: 8 },
  { text: "how much do I owe, £8?", want: "other", amount: null },
  { text: "I owe £8 right? will pay later", want: "other", amount: null },
];

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
  { text: "done 👍", want: "other", ctx: { ...CTX, replyContext: sent(ratingMsg("2026-10-19T16:30:00Z")) }, note: "after the rating DM" },
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
  { text: "I bank transferred Raihan", want: "paid", ctx: { ...FEROZ, replyContext: PAY_CHASE_ABOUT }, note: "after a pay chase, key only" },
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
  { text: "done 👍", want: "other", ctx: { ...FEROZ, replyContext: RATE_ABOUT }, note: "after the rating DM, key only" },
];

/**
 * SLICE S2 (2026-10-20): the swipe-reply. It shows only the quoted message,
 * so a "paid" or "done" to an OLDER pay link is a claim even when a rating
 * DM came after it, and a "done" to the rating DM is not. Not a reply, a
 * bare "done" answers the newest message. `SET=s2` runs these.
 */
/** Owes two matches (review of #336): the route acts on the one the quote
 *  names and tells the model its date; the older one here. */
const OLDER = contextMatchLabel("Tuesday 7-a-side", new Date("2026-10-06T19:00:00Z"));
const olderChaseMsg: ContextMessage = {
  at: new Date("2026-10-12T17:00:00Z"),
  text: buildPayChaseDm({ playerName: "Abid Kazmi", dayNum: 6, fee: 8, activityName: "Tuesday 7-a-side", url: "https://mt.example/s/pay", methods: ["card", "direct"], collectorName: "Kemal Ediz", lang: "en" }),
  topic: "paymentCollection",
  match: OLDER,
};

const SLICE_S2: Case[] = [
  { text: "paid", want: "paid", ctx: { ...CTX, owes: `£8 for ${OLDER}`, replyContext: quoting(olderChaseMsg) }, note: "owes two, swipe-reply to the OLDER match's chase" },
  { text: "paid", want: "paid", ctx: { ...CTX, replyContext: quoting(payChaseMsg) }, note: "swipe-reply to the pay link, a rating DM came after" },
  { text: "done 👍", want: "paid", ctx: { ...CTX, replyContext: quoting(payChaseMsg) }, note: "swipe-reply to the pay link, a rating DM came after" },
  { text: "tamam", want: "paid", ctx: { ...FEROZ, replyContext: quoting(ferozPayLinkMsg) }, note: "swipe-reply to a queued pay link" },
  { text: "done 👍", want: "other", ctx: { ...CTX, replyContext: quoting(ratingMsg("2026-10-19T16:30:00Z")) }, note: "swipe-reply to the rating DM" },
  {
    text: "done 👍",
    want: "other",
    ctx: { ...CTX, replyContext: sent(payChaseMsg, ratingMsg("2026-10-19T16:30:00Z")) },
    note: "not a reply: pay link, then the rating DM",
  },
  {
    text: "done 👍",
    want: "paid",
    ctx: { ...CTX, replyContext: sent(ratingMsg("2026-10-18T09:00:00Z"), payChaseMsg) },
    note: "not a reply: rating DM, then the pay link",
  },
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
      max_tokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
      ...HAIKU_THINKING,
      system: systemBlock(system),
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
  const sets: Record<string, Case[]> = { main: CASES, heldout: HELD_OUT, feroz: COLLECTOR, s2: SLICE_S2, amount: AMOUNT };
  sets.all = [...CASES, ...HELD_OUT, ...COLLECTOR, ...SLICE_S2, ...AMOUNT];
  const only = process.env.ONLY;
  const setName = process.env.SET && sets[process.env.SET] ? process.env.SET : "main";
  const set = only ? sets[setName].filter((c) => c.text === only) : sets[setName];
  console.log(`set: ${setName} (${set.length} cases)`);
  for (const c of set) {
    const got: string[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < REPEAT; i++) {
      if (usd >= MAX_USD) {
        console.error(`\nSTOPPED: cost cap $${MAX_USD} reached after ${calls} calls.`);
        process.exit(2);
      }
      const r = await classifyPaymentClaimDetailed(c.text, c.ctx ?? CTX, call);
      const amountOk = c.amount === undefined || (r.amount ?? null) === c.amount;
      got.push(`${r.intent}${r.amount != null ? `:${r.amount}` : ""}@${r.confidence.toFixed(2)}${amountOk ? "" : "!amount"}`);
      reasons.push(r.reasoning);
    }
    const agreed = got.filter((g) => g.startsWith(`${c.want}`) && !g.endsWith("!amount") && g.split("@")[0].split(":")[0] === c.want).length;
    const pass = agreed === REPEAT;
    if (!pass) bad++;
    const note = c.note ? ` (${c.note})` : "";
    console.log(
      `  ${pass ? "✓" : "✗"} ${agreed}/${REPEAT}  want=${c.want.padEnd(15)} got=[${got.join(", ")}]  ${JSON.stringify(c.text)}${note}`,
    );
    // A miss shows the model's own reasoning, the raw output to report.
    if (!pass) for (const why of reasons) console.log(`      reasoning: ${JSON.stringify(why)}`);
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
