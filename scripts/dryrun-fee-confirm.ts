/**
 * LIVE dry run for the fee reader (`fee-confirm.ts`).
 *
 * Since 2026-10-30 (P5 of the "no string parsing" sweep) the model reads
 * EVERY reply the collector sends to a fee question: a bare ✅ too, and
 * amounts ("£8 each", "toplam 80"). A stubbed test proves the wiring; this
 * measures what the real model reads.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-fee-confirm.ts            (every set, once)
 *   SET=s3 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-fee-confirm.ts     (one set)
 *
 * Sets: en and tr (what used to be the allowlist's yes and no, the
 * fragments it existed to refuse, natural go-aheads and refusals), amount
 * (each and total, with an amount waiting and after "how much?"), s3
 * (which message the reply answers).
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). It sends nothing
 * to anybody, touches no database and moves no money, with a hard stop at
 * MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { classifyFeeReply, parseFeeReplyIntent, type FeeReply } from "../src/lib/fee-confirm.ts";
import { buildFeeAskDm, buildFeeConfirmPrompt, buildPayChaseDm, buildRatingDm } from "../src/lib/dm-copy.ts";
import { contextMatchLabel, pickRecentBotMessages, type ContextMessage, type ReplyContext } from "../src/lib/reply-context.ts";
import { HAIKU_CLASSIFIER_ARM, meter } from "./dm-dryrun-meter.ts";

const REPEAT = Number(process.env.REPEAT ?? "1") || 1;
const MAX_USD = 0.05;

interface Case {
  text: string;
  want: FeeReply;
  lang?: "en" | "tr";
  /** The chat context; absent: the lang's default (the fee question, newest). */
  ctx?: ReplyContext;
  note?: string;
  /** For `amount`: the amount and what it is. */
  amount?: number;
  amountIs?: "each" | "total";
  /** The amount waiting for his yes; absent: the lang's default. null:
   *  nothing waiting, MatchTime asked how much (`ASKED` context). */
  pending?: number | null;
}

// ── The chat context, as `loadDmReplyContext` builds it ──
/** Wed 14 Oct 2026, 22:30 London: the night after the match. */
const NOW = new Date("2026-10-14T21:30:00Z");
const MATCH_EN = contextMatchLabel("Tuesday 5-a-side", new Date("2026-10-13T19:00:00Z"));
const MATCH_TR = contextMatchLabel("Cuma Maçı", new Date("2026-10-09T18:00:00Z"));
const sent = (...msgs: ContextMessage[]): ReplyContext => ({ now: NOW, quoted: null, ...pickRecentBotMessages(msgs, NOW) });
const quoting = (m: ContextMessage): ReplyContext => ({ now: NOW, quoted: m, recent: [], earlier: null });
const at = (iso: string) => new Date(iso);

/** The fee question the collector was just sent: a queued BotJob (its
 *  words, no key topic), in each language, from the real composer. */
const feeAsk = (lang: "en" | "tr", when = "2026-10-14T21:20:00Z"): ContextMessage => ({
  at: at(when),
  text: buildFeeConfirmPrompt({
    perPlayer: lang === "tr" ? 8 : 10.3,
    headcount: 9,
    matchName: lang === "tr" ? "Cuma Maçı" : "Tuesday 5-a-side",
    wasTotal: false,
    lang,
  }),
  topic: null,
  match: null,
});
/** A newer notice to the collector: a player says they paid him directly. */
const NOTICE: ContextMessage = {
  at: at("2026-10-14T21:25:00Z"),
  text: "💸 Riley Rater says they've paid you directly £10.30 for Tuesday 5-a-side. Tap to confirm once it lands.",
  topic: null,
  match: null,
};
/** The rating request the collector got as a player, a scheduler DM. */
const ratingDm = (lang: "en" | "tr", when: string): ContextMessage => ({
  at: at(when),
  text: buildRatingDm({
    activityName: lang === "tr" ? "Cuma Maçı" : "Tuesday 5-a-side",
    dateLabel: lang === "tr" ? "9 Ekim Cuma" : "Tue 13 Oct",
    mvpLabel: lang === "tr" ? "Maçın Adamı" : "Man of the Match",
    rateUrl: "https://mt.example/s/rate",
    statsUrl: "https://mt.example/s/stats",
    lang,
  }),
  topic: "playerRating",
  match: lang === "tr" ? MATCH_TR : MATCH_EN,
});
/** His own pay chase, for the match he played in at another club. */
const PAY_CHASE: ContextMessage = {
  at: at("2026-10-14T18:00:00Z"),
  text: buildPayChaseDm({ playerName: "Colin", dayNum: 1, fee: 6, activityName: "Thursday 6-a-side", url: "https://mt.example/s/pay", methods: ["card"], collectorName: "Sam", lang: "en" }),
  topic: "paymentCollection",
  match: "Thursday 6-a-side, Thu 8 Oct, 19:00",
};

const DEFAULT_CTX = { en: sent(feeAsk("en")), tr: sent(feeAsk("tr")) };

/** "How much per player?": MatchTime's fee ask, nothing waiting yet. */
const howMuch = (lang: "en" | "tr"): ContextMessage => ({
  at: at("2026-10-14T21:20:00Z"),
  text: buildFeeAskDm({ collectorName: "Colin", activityName: lang === "tr" ? "Cuma Maçı" : "Tuesday 5-a-side", headcount: 10, lang }),
  topic: "paymentCollection",
  match: lang === "tr" ? MATCH_TR : MATCH_EN,
});
const ASKED = { en: sent(howMuch("en")), tr: sent(howMuch("tr")) };

/** Amounts: after "how much?" (nothing waiting) and in place of a waiting one. */
const AMOUNTS: Case[] = [
  { text: "£8", want: "amount", amount: 8, amountIs: "each", pending: null, ctx: ASKED.en },
  { text: "8 each", want: "amount", amount: 8, amountIs: "each", pending: null, ctx: ASKED.en },
  { text: "£80 total", want: "amount", amount: 80, amountIs: "total", pending: null, ctx: ASKED.en },
  { text: "pitch was 96, split it between the lads", want: "amount", amount: 96, amountIs: "total", pending: null, ctx: ASKED.en },
  { text: "8.50 a head", want: "amount", amount: 8.5, amountIs: "each", pending: null, ctx: ASKED.en },
  { text: "we had 10 players tonight", want: "neither", pending: null, ctx: ASKED.en },
  { text: "make it £12", want: "amount", amount: 12, amountIs: "each" },
  { text: "✅ actually make it £12", want: "amount", amount: 12, amountIs: "each" },
  { text: "kişi başı 8", want: "amount", amount: 8, amountIs: "each", pending: null, lang: "tr", ctx: ASKED.tr },
  { text: "toplam 80", want: "amount", amount: 80, amountIs: "total", pending: null, lang: "tr", ctx: ASKED.tr },
  { text: "saha 96, bölüşelim", want: "amount", amount: 96, amountIs: "total", pending: null, lang: "tr", ctx: ASKED.tr },
  { text: "hepsi 8", want: "amount", amount: 8, amountIs: "each", pending: null, lang: "tr", ctx: ASKED.tr },
  { text: "10 kişiydik", want: "neither", pending: null, lang: "tr", ctx: ASKED.tr },
  { text: "✅", want: "neither", pending: null, ctx: ASKED.en, note: "a tick to 'how much?' is no amount" },
];

/** What the deleted allowlist used to decide offline: the model now reads them. */
const ANCHORED: Case[] = [
  { text: "👍", want: "yes" },
  { text: "✅", want: "yes" },
  { text: "yes", want: "yes" },
  { text: "yes send them", want: "yes" },
  { text: "confirm", want: "yes" },
  { text: "ok", want: "yes" },
  { text: "yep 👍", want: "yes" },
  { text: "no", want: "no" },
  { text: "not yet", want: "no" },
  { text: "❌", want: "no" },
];

/** The fragments, real messages, and natural answers. */
const MODEL: Case[] = [
  // ⚠️ the bug, and the reason this file exists
  { text: "great game 👍", want: "neither" },
  { text: "cheers lads, great game 👍", want: "neither" },
  { text: "ok so I'll sort it tomorrow", want: "neither" },
  // real messages from the live group (AnalyzedMessage, Sutton FC)
  { text: "yes, Elvin still collects it", want: "neither" },
  { text: "ok i will call goals and switch to 7aside again", want: "neither" },
  { text: "sure will do", want: "neither" },
  { text: "yes pls, can you share the name?", want: "neither" },
  { text: "✅ means that player has been accepted to the main squad", want: "neither" },
  { text: "no worries mate, great game", want: "neither" },
  { text: "did Wasim turn up in the end?", want: "neither" },
  { text: "how many are in for next week?", want: "neither" },
  // natural go-aheads the allowlist cannot cover: the WIDENING
  { text: "yeah go on then, fire them out", want: "yes" },
  { text: "sounds right, send em over", want: "yes" },
  { text: "that's the one, send the links", want: "yes" },
  // natural refusals
  { text: "hold off until I've counted the cash", want: "no" },
  { text: "not yet mate, a couple of them paid me cash", want: "no" },
];

/** Turkish club: what the deleted Turkish allowlist used to decide. */
const ANCHORED_TR: Case[] = ([
  { text: "evet", want: "yes" },
  { text: "Tamam", want: "yes" },
  { text: "✅", want: "yes" },
  { text: "evet gönder", want: "yes" },
  { text: "👍", want: "yes" },
  { text: "hayır", want: "no" },
  { text: "bekle", want: "no" },
  { text: "şimdi değil", want: "no" },
] as Case[]).map((c) => ({ ...c, lang: "tr" as const }));

/** Turkish club: fragments and natural answers. */
const MODEL_TR: Case[] = ([
  // ⚠️ the same bug, in Turkish
  { text: "harika maç 👍", want: "neither" },
  { text: "eline sağlık beyler, harika maçtı 👍", want: "neither" },
  { text: "tamam yarın hallederim", want: "neither" },
  { text: "evet, parayı yine Elvin topluyor", want: "neither" },
  { text: "kaç kişi ödüyor?", want: "neither" },
  { text: "tamam ben sahayı arayıp 7'ye 7'ye geçeriz", want: "neither" },
  { text: "sorun yok kardeşim, güzel maçtı", want: "neither" },
  { text: "Wasim geldi mi sonunda?", want: "neither" },
  // natural go-aheads
  { text: "tamam, yolla gitsin", want: "yes" },
  { text: "doğru, linkleri gönderebilirsin", want: "yes" },
  { text: "evet evet at hepsine", want: "yes" },
  // natural refusals
  { text: "şimdilik bekle, parayı bir sayayım", want: "no" },
  { text: "gönderme daha, iki kişi nakit verdi", want: "no" },
] as Case[]).map((c) => ({ ...c, lang: "tr" as const }));

/**
 * SLICE S3 (quoted-reply context): which message the reply answers. A
 * swipe-reply answers the quoted message; otherwise the newest, unless the
 * words plainly answer an earlier one.
 */
const SLICE_S3: Case[] = [
  { text: "sounds good 👍", want: "yes", ctx: quoting(feeAsk("en")), note: "swipe-reply to the fee question" },
  { text: "yeah go on then, send them", want: "yes", ctx: quoting(feeAsk("en", "2026-10-14T20:00:00Z")), note: "swipe-reply to the fee question, a notice came after" },
  { text: "sounds good 👍", want: "neither", ctx: quoting(ratingDm("en", "2026-10-14T09:00:00Z")), note: "swipe-reply to his own rating request" },
  { text: "sounds good 👍", want: "neither", ctx: quoting(PAY_CHASE), note: "swipe-reply to his own pay chase" },
  {
    text: "sounds good 👍",
    want: "neither",
    ctx: sent(feeAsk("en", "2026-10-14T20:00:00Z"), ratingDm("en", "2026-10-14T21:00:00Z")),
    note: "not a reply: the fee question, then a rating request",
  },
  {
    text: "yeah fire the links out",
    want: "yes",
    ctx: sent(feeAsk("en", "2026-10-14T21:20:00Z"), NOTICE),
    note: "not a reply: the fee question, then a notice; the words answer the question",
  },
  { text: "tamam, yolla gitsin", want: "yes", lang: "tr", ctx: quoting(feeAsk("tr")), note: "swipe-reply to the fee question" },
  { text: "süper 👍", want: "neither", lang: "tr", ctx: quoting(ratingDm("tr", "2026-10-14T09:00:00Z")), note: "swipe-reply to his own rating request" },
  // Review of #339 (H2): a bare ✅ or 👍 swipe-replied to another message.
  { text: "✅", want: "neither", ctx: quoting(ratingDm("en", "2026-10-14T09:00:00Z")), note: "✅ swipe-replied to his own rating request" },
  { text: "👍", want: "neither", ctx: quoting(PAY_CHASE), note: "👍 swipe-replied to his own pay chase" },
  { text: "evet", want: "neither", lang: "tr", ctx: quoting(ratingDm("tr", "2026-10-14T09:00:00Z")), note: "evet swipe-replied to his own rating request" },
];

const SETS: Record<string, Case[]> = {
  en: [...ANCHORED, ...MODEL],
  tr: [...ANCHORED_TR, ...MODEL_TR],
  amount: AMOUNTS,
  s3: SLICE_S3,
};

const ctxOf = (c: Case) => {
  const lang = c.lang ?? "en";
  const pending = c.pending !== undefined ? c.pending : lang === "tr" ? 8 : 10.3;
  return lang === "tr"
    ? { pending, matchName: MATCH_TR, lang: "tr" as const, replyContext: c.ctx ?? DEFAULT_CTX.tr }
    : { pending, matchName: MATCH_EN, lang: "en" as const, replyContext: c.ctx ?? DEFAULT_CTX.en };
};

const matches = (c: Case, r: ReturnType<typeof parseFeeReplyIntent>) =>
  r.intent === c.want && (c.want !== "amount" || (r.amount === c.amount && r.amountIs === c.amountIs));

async function main() {
  spendDevApiKeyOrExit("scripts/dryrun-fee-confirm.ts");
  if (process.env.MT_TEST_FEE_REPLY_STUB_FILE) {
    console.error("REFUSING: MT_TEST_FEE_REPLY_STUB_FILE is set, this would measure the stub.");
    process.exit(1);
  }
  const m = meter("scripts/dryrun-fee-confirm.ts", HAIKU_CLASSIFIER_ARM, MAX_USD);
  const names = process.env.SET && SETS[process.env.SET] ? [process.env.SET] : Object.keys(SETS);
  console.log(`── fee reader, ${HAIKU_CLASSIFIER_ARM.model}, sets ${names.join(", ")}, REPEAT=${REPEAT}, cap $${MAX_USD} ──`);
  let bad = 0;
  let total = 0;
  for (const name of names) {
    console.log(`\n── ${name} ──`);
    for (const c of SETS[name]) {
      total++;
      const got: string[] = [];
      const reasons: string[] = [];
      let agreed = 0;
      for (let i = 0; i < REPEAT; i++) {
        await classifyFeeReply(c.text, ctxOf(c), m.call);
        const r = parseFeeReplyIntent(m.lastRaw());
        if (matches(c, r)) agreed++;
        got.push(`${r.intent}${r.amount != null ? `:${r.amount}/${r.amountIs}` : ""}@${r.confidence.toFixed(2)}`);
        reasons.push(r.reasoning);
      }
      const pass = agreed === REPEAT;
      if (!pass) bad++;
      const want = c.want === "amount" ? `amount:${c.amount}/${c.amountIs}` : c.want;
      console.log(`  ${pass ? "✓" : "✗"} ${agreed}/${REPEAT}  ${c.lang ?? "en"} want=${want} got=[${got.join(", ")}]  ${JSON.stringify(c.text)}${c.note ? ` (${c.note})` : ""}`);
      if (!pass) for (const why of reasons) console.log(`      reasoning: ${JSON.stringify(why)}`);
    }
  }
  console.log(`\n${total - bad}/${total} cases fully agreed. ${m.summary()}`);
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
