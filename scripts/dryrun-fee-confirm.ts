/**
 * LIVE dry run for the fee-confirmation classifier.
 *
 * A stubbed test proves the WIRING. It cannot prove that the real model
 * refuses "great game 👍" — and that refusal is the entire point of the
 * change, so it has to be measured against the real model before shipping
 * and again whenever the prompt or the model changes.
 *
 *   REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-fee-confirm.ts
 *   LANG_UNDER_TEST=tr REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-fee-confirm.ts
 *   SET=s3 REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-fee-confirm.ts
 *
 * `LANG_UNDER_TEST=tr` runs a Turkish club's cases: the Turkish allowlist,
 * Turkish replies, and "harika maç 👍" as the case that must never release
 * anything. `SET=s3` (quoted-reply context, 2026-10-20) runs the
 * swipe-reply and recent-messages cases, both languages: "yes" answers the
 * fee question only when it is the message they replied to, or the newest.
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). It sends nothing
 * to anybody, touches no database and moves no money: it calls
 * `classifyFeeReply` with a metered model and prints what came back, with
 * the cost and a hard stop at MAX_USD.
 *
 * The cases are split by who has to be right. The ANCHORED cases never
 * reach the model at all (the allowlist decides them offline) and are
 * printed to prove exactly that. The MODEL cases are the ones the
 * allowlist abstains on, and the `neither` ones are lifted verbatim from
 * the live group: real messages this collector has written.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anchoredFeeReply, classifyFeeReply, parseFeeReplyIntent, type FeeReply } from "../src/lib/fee-confirm.ts";
import { buildFeeConfirmPrompt, buildPayChaseDm, buildRatingDm } from "../src/lib/dm-copy.ts";
import { contextMatchLabel, pickRecentBotMessages, type ContextMessage, type ReplyContext } from "../src/lib/reply-context.ts";
import { HAIKU_CLASSIFIER_ARM, meter } from "./dm-dryrun-meter.ts";

const REPEAT = Number(process.env.REPEAT ?? "1") || 1;
const MAX_USD = 0.2;

interface Case {
  text: string;
  want: FeeReply;
  lang?: "en" | "tr";
  /** The chat context; absent: the lang's default (the fee question, newest). */
  ctx?: ReplyContext;
  note?: string;
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

/** Decided offline by the allowlist. The model must never see these. */
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

/** The allowlist abstains; the model decides. */
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

/** Turkish club: decided offline by the Turkish allowlist. */
const ANCHORED_TR: Case[] = [
  { text: "evet", want: "yes" },
  { text: "Tamam", want: "yes" },
  { text: "✅", want: "yes" },
  { text: "evet gönder", want: "yes" },
  { text: "👍", want: "yes" },
  { text: "hayır", want: "no" },
  { text: "bekle", want: "no" },
  { text: "şimdi değil", want: "no" },
];

/** Turkish club: the allowlist abstains, the model decides. */
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
 * words plainly answer an earlier one. Every reply here is one the
 * allowlist abstains on, so the model decides.
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
];

const LANG: "en" | "tr" = process.env.LANG_UNDER_TEST === "tr" ? "tr" : "en";
const SETS: Record<string, { anchored: Case[]; model: Case[] }> = {
  main: LANG === "tr" ? { anchored: ANCHORED_TR, model: MODEL_TR } : { anchored: ANCHORED, model: MODEL },
  s3: { anchored: [], model: SLICE_S3 },
};

const ctxOf = (c: Case) => {
  const lang = c.lang ?? LANG;
  return lang === "tr"
    ? { amount: 8, matchName: MATCH_TR, lang: "tr" as const, replyContext: c.ctx ?? DEFAULT_CTX.tr }
    : { amount: 10.3, matchName: MATCH_EN, lang: "en" as const, replyContext: c.ctx ?? DEFAULT_CTX.en };
};

async function main() {
  spendDevApiKeyOrExit("scripts/dryrun-fee-confirm.ts");
  if (process.env.MT_TEST_FEE_REPLY_STUB_FILE) {
    console.error("REFUSING: MT_TEST_FEE_REPLY_STUB_FILE is set, this would measure the stub.");
    process.exit(1);
  }
  const m = meter("scripts/dryrun-fee-confirm.ts", HAIKU_CLASSIFIER_ARM, MAX_USD);
  const setName = process.env.SET && SETS[process.env.SET] ? process.env.SET : "main";
  const { anchored, model } = SETS[setName];
  const only = process.env.ONLY;
  console.log(`── fee-confirm, ${HAIKU_CLASSIFIER_ARM.model}, set ${setName}, language ${setName === "s3" ? "both" : LANG}, REPEAT=${REPEAT}, cap $${MAX_USD} ──`);

  let anchoredBad = 0;
  if (anchored.length) console.log(`── ANCHORED (decided offline, model never called) ──`);
  for (const c of anchored) {
    const got = anchoredFeeReply(c.text, c.lang ?? LANG);
    const pass = got === c.want;
    if (!pass) anchoredBad++;
    console.log(`  ${pass ? "✓" : "✗"} ${JSON.stringify(c.text).padEnd(22)} → ${got ?? "abstain"}  (want ${c.want})`);
  }

  console.log(`\n── MODEL ──`);
  let modelBad = 0;
  const cases = only ? model.filter((c) => c.text === only) : model;
  for (const c of cases) {
    if (anchoredFeeReply(c.text, c.lang ?? LANG) !== null) {
      console.log(`  ! ${JSON.stringify(c.text)} was decided by the allowlist; it should not have been`);
      modelBad++;
      continue;
    }
    const got: string[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < REPEAT; i++) {
      await classifyFeeReply(c.text, ctxOf(c), m.call);
      // The production seam returns the label only; the raw answer gives
      // the confidence and the reasoning, parsed by the production parser.
      const r = parseFeeReplyIntent(m.lastRaw());
      got.push(`${r.intent}@${r.confidence.toFixed(2)}`);
      reasons.push(r.reasoning);
    }
    const agreed = got.filter((g) => g.startsWith(`${c.want}@`)).length;
    const pass = agreed === REPEAT;
    if (!pass) modelBad++;
    console.log(
      `  ${pass ? "✓" : "✗"} ${agreed}/${REPEAT}  ${c.lang ?? LANG} want=${c.want.padEnd(7)} got=[${got.join(", ")}]  ${JSON.stringify(c.text)}${c.note ? ` (${c.note})` : ""}`,
    );
    if (!pass) for (const why of reasons) console.log(`      reasoning: ${JSON.stringify(why)}`);
  }

  console.log(
    `\nanchored: ${anchored.length - anchoredBad}/${anchored.length}   model: ${cases.length - modelBad}/${cases.length} cases fully agreed. ${m.summary()}`,
  );
  process.exit(anchoredBad + modelBad > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
