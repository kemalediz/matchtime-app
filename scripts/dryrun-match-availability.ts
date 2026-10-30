/**
 * LIVE dry run for the DM match-availability classifier (2026-10-18).
 *
 * A stubbed test proves the WIRING: an "in" registers, an "out" drops, an
 * "unclear" writes nothing. It cannot prove the real model reads "go on
 * then" and "varım" as IN, "sorry mate, away" as OUT, and refuses "maybe",
 * "Kieran is in" and a bare "yes" that answers a rating DM. Only the real
 * model can, so this asks it.
 *
 *   REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-match-availability.ts
 *   SET=heldout REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-match-availability.ts
 *   SET=s2 REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-match-availability.ts
 *
 * PROMPT=old measures a previous prompt for a before/after table: point
 * OLD_PROMPT_MODULE at a module exporting { SYSTEM_PROMPT, userTurn(text,
 * {playerName, clubName, matchName, matchWhen, wasAskedToPlay}), parse }.
 * Each case's context says whether the old code would have passed
 * `wasAskedToPlay` (an invite or the tentative follow-up was the last DM).
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Touches no
 * database, sends nothing, writes nothing: it imports the DB-free
 * classifier module and prints what came back, with a running cost and a
 * hard stop at MAX_USD.
 *
 * Kemal's 2026-10-18 rule: every LLM change runs real paid tests on the
 * dev key (old prompt once as the baseline, new once, held-out once).
 */
import Anthropic from "@anthropic-ai/sdk";
import { pathToFileURL } from "node:url";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import {
  MATCH_AVAILABILITY_MODEL,
  classifyMatchAvailability,
  type MatchAvailability,
  type MatchAvailabilityContext,
} from "../src/lib/match-availability-classifier.ts";
import {
  contextMatchLabel,
  pickRecentBotMessages,
  type ContextMessage,
  type ReplyContext,
} from "../src/lib/reply-context.ts";
import { buildRatingDm, buildTentativeFollowupDm } from "../src/lib/dm-copy.ts";
import { t } from "../src/lib/i18n/t.ts";
import { costOf, systemBlock } from "../src/lib/pipeline/llm.ts";
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING } from "../src/lib/models.ts";

const REPEAT = Number(process.env.REPEAT ?? "1") || 1;
/** The shared Haiku id, so the model-pin guard can resolve it; `main`
 *  refuses to run if it drifts from production's pin. */
const MODEL = HAIKU_MODEL;
/** Hard cap for this run, in US dollars. */
const MAX_USD = 0.3;

// ── What the player was last sent: the real composers, the words players get ──
const invite = (lang: "en" | "tr", matchWhen: string) =>
  t(lang).dm_recruit_invite({
    firstName: lang === "en" ? "Ian" : "Emre",
    matchName: lang === "en" ? "Tuesday 7-a-side" : "Salı Halısaha",
    matchWhen,
    spotsLeft: 2,
    link: "https://mt.example/s/m",
    reactions: true,
  });

interface Ctx extends MatchAvailabilityContext {
  /** What the OLD code passed as `wasAskedToPlay` for this situation. */
  oldAsked: boolean;
  label: string;
}

// ── The chat context, as `loadDmReplyContext` builds it ──
/** Mon 19 Oct 2026, 18:00 London: the evening before the match. */
const NOW = new Date("2026-10-19T17:00:00Z");
const EN_MATCH = { clubName: "Sutton FC", playerName: "Ian Innes", matchName: "Tuesday 7-a-side", matchWhen: "Tue 20 Oct, 20:00" };
const TR_MATCH = { clubName: "Erdal FC", playerName: "Emre Yılmaz", matchName: "Salı Halısaha", matchWhen: "20 Eki Sal, 20:00" };
const TUE = contextMatchLabel("Tuesday 7-a-side", new Date("2026-10-20T19:00:00Z"));
const SALI = contextMatchLabel("Salı Halısaha", new Date("2026-10-20T19:00:00Z"));

/** Not a swipe-reply: MatchTime's recent DMs, picked as production picks them. */
const sent = (...msgs: ContextMessage[]): ReplyContext => ({ now: NOW, quoted: null, ...pickRecentBotMessages(msgs, NOW) });
/** A swipe-reply: that message alone. */
const quoting = (m: ContextMessage, now: Date = NOW): ReplyContext => ({ now, quoted: m, recent: [], earlier: null });

/** The recruit invite, a queued BotJob: its words, no key topic. */
const inviteMsg = (lang: "en" | "tr"): ContextMessage => ({
  at: new Date("2026-10-19T16:30:00Z"),
  text: invite(lang, lang === "en" ? EN_MATCH.matchWhen : TR_MATCH.matchWhen),
  topic: null,
  match: null,
});
/** The tentative follow-up, a scheduler DM: its words since S0, its topic and match. */
const tentMsg = (lang: "en" | "tr"): ContextMessage => ({
  at: new Date("2026-10-19T16:00:00Z"),
  text:
    lang === "en"
      ? buildTentativeFollowupDm({ playerName: "Ian Innes", activityName: "Tuesday 7-a-side", whenLabel: "Tue 20 Oct at 20:00", lang: "en" })
      : buildTentativeFollowupDm({ playerName: "Emre Yılmaz", activityName: "Salı Halısaha", whenLabel: "20 Eki Sal 20:00", lang: "tr" }),
  topic: "tentativeFollowup",
  match: lang === "en" ? TUE : SALI,
});
/** The rating request after last week's match, a scheduler DM. */
const ratingMsg = (at = "2026-10-18T09:00:00Z"): ContextMessage => ({
  at: new Date(at),
  text: buildRatingDm({
    activityName: "Tuesday 7-a-side",
    dateLabel: "Tue 13 Oct",
    mvpLabel: "Man of the Match",
    rateUrl: "https://mt.example/s/rate",
    statsUrl: "https://mt.example/s/stats",
    lang: "en",
  }),
  topic: "playerRating",
  match: contextMatchLabel("Tuesday 7-a-side", new Date("2026-10-13T19:00:00Z")),
});

/** The recruit invite for this match, nothing since. */
const INVITE_EN: Ctx = { ...EN_MATCH, currentStatus: "not signed up", replyContext: sent(inviteMsg("en")), oldAsked: true, label: "invite" };
const INVITE_TR: Ctx = { ...TR_MATCH, currentStatus: "not signed up", replyContext: sent(inviteMsg("tr")), oldAsked: true, label: "invite" };
/** The tentative follow-up ("you were a maybe: in or out?"). */
const TENT_EN: Ctx = { ...EN_MATCH, currentStatus: "said maybe, not signed up", replyContext: sent(tentMsg("en")), oldAsked: true, label: "tentative follow-up" };
const TENT_TR: Ctx = { ...TR_MATCH, currentStatus: "said maybe, not signed up", replyContext: sent(tentMsg("tr")), oldAsked: true, label: "tentative follow-up" };
/** A cold DM: the last thing MatchTime sent was the rating request. */
const RATED_EN: Ctx = { ...EN_MATCH, currentStatus: "not signed up", replyContext: sent(ratingMsg()), oldAsked: false, label: "after the rating DM" };
/** A cold DM with nothing known. */
const COLD_TR: Ctx = { ...TR_MATCH, currentStatus: "not signed up", replyContext: sent(), oldAsked: false, label: "cold, nothing known" };
/** Already in the squad, the scheduler's squad update was last (key only, no words). */
const IN_SQUAD_EN: Ctx = {
  ...EN_MATCH,
  currentStatus: "in the squad",
  replyContext: sent({ at: new Date("2026-10-19T08:00:00Z"), text: null, topic: "attendance", match: TUE }),
  oldAsked: false,
  label: "in the squad",
};

interface Case {
  text: string;
  want: MatchAvailability;
  ctx: Ctx;
}

/**
 * Every behaviour the OLD prompt handled, English and Turkish:
 * natural IN; natural OUT; hedges; questions (and accept-plus-question);
 * third parties; past and hypothetical; bare acknowledgements (an answer
 * only after a question about playing); banter.
 */
const CASES: Case[] = [
  // ── IN: any clear acceptance, the word "in" not required ──
  { text: "yeah sure count me in", want: "in", ctx: INVITE_EN },
  { text: "why not, coming", want: "in", ctx: INVITE_EN },
  { text: "go on then", want: "in", ctx: INVITE_EN },
  { text: "I'll be there mate", want: "in", ctx: INVITE_EN },
  { text: "aye", want: "in", ctx: INVITE_EN },
  { text: "see you there", want: "in", ctx: INVITE_EN },
  { text: "put me down", want: "in", ctx: INVITE_EN },
  { text: "sounds good see you tuesday", want: "in", ctx: INVITE_EN },
  { text: "go on then, what time?", want: "in", ctx: INVITE_EN },
  { text: "varım", want: "in", ctx: INVITE_TR },
  { text: "geliyorum", want: "in", ctx: INVITE_TR },
  { text: "sayın beni", want: "in", ctx: INVITE_TR },
  { text: "tamam gelirim, saat kaçta?", want: "in", ctx: INVITE_TR },
  // bare affirmatives right after a question about playing
  { text: "yes", want: "in", ctx: INVITE_EN },
  { text: "👍", want: "in", ctx: INVITE_EN },
  { text: "ok", want: "in", ctx: TENT_EN },
  { text: "evet", want: "in", ctx: TENT_TR },
  { text: "tamam", want: "in", ctx: INVITE_TR },
  // ── OUT: a clear decline for that match ──
  { text: "can't tomorrow sorry", want: "out", ctx: INVITE_EN },
  { text: "not this week", want: "out", ctx: INVITE_EN },
  { text: "sorry mate, away", want: "out", ctx: INVITE_EN },
  { text: "im working", want: "out", ctx: INVITE_EN },
  { text: "on holiday", want: "out", ctx: TENT_EN },
  { text: "no chance im injured", want: "out", ctx: INVITE_EN },
  { text: "gotta miss this week", want: "out", ctx: IN_SQUAD_EN },
  { text: "gelemiyorum", want: "out", ctx: INVITE_TR },
  { text: "bu hafta yokum", want: "out", ctx: INVITE_TR },
  { text: "işteyim abi", want: "out", ctx: TENT_TR },
  // bare negatives right after a question about playing
  { text: "no", want: "out", ctx: INVITE_EN },
  { text: "nah", want: "out", ctx: TENT_EN },
  { text: "👎", want: "out", ctx: INVITE_EN },
  { text: "hayır", want: "out", ctx: INVITE_TR },
  // ── UNCLEAR: hedges ──
  { text: "maybe, I'll let you know", want: "unclear", ctx: INVITE_EN },
  { text: "I'll try", want: "unclear", ctx: INVITE_EN },
  { text: "probably", want: "unclear", ctx: TENT_EN },
  { text: "if I can", want: "unclear", ctx: INVITE_EN },
  { text: "depends on work", want: "unclear", ctx: INVITE_EN },
  { text: "hopefully", want: "unclear", ctx: INVITE_EN },
  { text: "belki", want: "unclear", ctx: INVITE_TR },
  { text: "bakarız", want: "unclear", ctx: INVITE_TR },
  { text: "kesin değil", want: "unclear", ctx: TENT_TR },
  { text: "bakacağım", want: "unclear", ctx: INVITE_TR },
  // ── UNCLEAR: questions ──
  { text: "what time is it again?", want: "unclear", ctx: INVITE_EN },
  { text: "who else is playing?", want: "unclear", ctx: INVITE_EN },
  { text: "where are we playing?", want: "unclear", ctx: INVITE_EN },
  { text: "am I in?", want: "unclear", ctx: IN_SQUAD_EN },
  { text: "is there space?", want: "unclear", ctx: INVITE_EN },
  { text: "saat kaçta?", want: "unclear", ctx: INVITE_TR },
  { text: "kimler var?", want: "unclear", ctx: INVITE_TR },
  // ── UNCLEAR: somebody else ──
  { text: "Kieran is in", want: "unclear", ctx: INVITE_EN },
  { text: "my mate wants a game", want: "unclear", ctx: INVITE_EN },
  { text: "is Rashad playing", want: "unclear", ctx: INVITE_EN },
  { text: "Ahmet geliyor", want: "unclear", ctx: INVITE_TR },
  // ── UNCLEAR: past or hypothetical ──
  { text: "I was in last week", want: "unclear", ctx: INVITE_EN },
  { text: "if I was fit I'd play", want: "unclear", ctx: INVITE_EN },
  { text: "geçen hafta vardım", want: "unclear", ctx: INVITE_TR },
  // ── UNCLEAR: a bare reply that does not answer a question about playing ──
  { text: "yes", want: "unclear", ctx: RATED_EN },
  { text: "👍", want: "unclear", ctx: RATED_EN },
  { text: "ok", want: "unclear", ctx: RATED_EN },
  { text: "cheers", want: "unclear", ctx: INVITE_EN },
  { text: "🙏", want: "unclear", ctx: RATED_EN },
  { text: "done 👍", want: "unclear", ctx: RATED_EN },
  { text: "evet", want: "unclear", ctx: COLD_TR },
  { text: "no", want: "unclear", ctx: RATED_EN },
  // ── UNCLEAR: banter and off-topic ──
  { text: "haha what a goal last night", want: "unclear", ctx: RATED_EN },
  { text: "eline sağlık abi", want: "unclear", ctx: COLD_TR },
];

/** HELD OUT: phrasings in neither prompt, so a pass is generalising. */
/** The bench offer, a queued BotJob: a place has opened, reply YES. */
const benchMsg = (lang: "en" | "tr"): ContextMessage => ({
  at: new Date("2026-10-19T16:45:00Z"),
  text: t(lang).dm_bench_offer({
    firstName: lang === "en" ? "Ian" : "Emre",
    context: lang === "en" ? "in Tuesday 7-a-side (Tue 20 Oct, 20:00)" : "Salı Halısaha (20 Eki Sal, 20:00)",
    reactions: false,
  }),
  topic: null,
  match: lang === "en" ? TUE : SALI,
});
const BENCH_EN: Ctx = { ...EN_MATCH, currentStatus: "on the bench", replyContext: sent(benchMsg("en")), oldAsked: true, label: "bench offer" };
const BENCH_TR: Ctx = { ...TR_MATCH, currentStatus: "on the bench", replyContext: sent(benchMsg("tr")), oldAsked: true, label: "bench offer" };
/** The coded partner ask: no context at all (`handleCodedPartnerAskDm`). */
/** The coded partner ask: his DM is read against the ask as posted (`loadAskForDm`). */
const ASK_POST: ContextMessage = {
  at: new Date("2026-10-19T15:00:00Z"),
  text: t("en").xask_post({ asker: "Riverside FC", places: 1, day: "Tue 20 Oct, 20:00", venue: "Goals Sutton", format: "7-a-side", fee: null, link: "https://wa.me/447700900555?text=IN%20(ref%20K7Q2)", prefill: "IN (ref K7Q2)" }),
  topic: null,
  match: null,
};
const CODED_EN: Ctx = { clubName: "Riverside FC", matchName: "Riverside FC", matchWhen: "Tue 20 Oct, 20:00", replyContext: quoting(ASK_POST), oldAsked: false, label: "coded partner ask, read against the ask" };

/**
 * 2026-10-30, the no-string-parsing sweep: what the deleted word lists
 * used to decide WITHOUT the model (the bench offer's yes or no, the
 * tentative follow-up's fast path, the cold DM IN and OUT, the
 * hypothetical seatbelt), now the model's.
 */
const NO_REGEX: Case[] = [
  { text: "yes", want: "in", ctx: BENCH_EN },
  { text: "YES", want: "in", ctx: BENCH_EN },
  { text: "👍", want: "in", ctx: BENCH_EN },
  { text: "I'll take it", want: "in", ctx: BENCH_EN },
  { text: "no", want: "out", ctx: BENCH_EN },
  { text: "can't make it", want: "out", ctx: BENCH_EN },
  { text: "maybe", want: "unclear", ctx: BENCH_EN },
  { text: "EVET", want: "in", ctx: BENCH_TR },
  { text: "tamam abi", want: "in", ctx: BENCH_TR },
  { text: "hayır", want: "out", ctx: BENCH_TR },
  { text: "in", want: "in", ctx: TENT_EN },
  { text: "VARIM", want: "in", ctx: TENT_TR },
  { text: "YOKUM", want: "out", ctx: TENT_TR },
  { text: "evet", want: "in", ctx: TENT_TR },
  { text: "belki", want: "unclear", ctx: TENT_TR },
  { text: "IN", want: "in", ctx: INVITE_EN },
  { text: "count me out", want: "out", ctx: INVITE_EN },
  { text: "varım", want: "in", ctx: COLD_TR },
  { text: "gelemiyorum", want: "out", ctx: COLD_TR },
  { text: "I was in last week", want: "unclear", ctx: INVITE_EN },
  { text: "if I was in I would have scored", want: "unclear", ctx: INVITE_EN },
  { text: "IN", want: "in", ctx: CODED_EN },
  { text: "VARIM", want: "in", ctx: { ...CODED_EN, label: "coded partner ask, Turkish prefill" } },
];

const HELD_OUT: Case[] = [
  { text: "deffo, see you then", want: "in", ctx: INVITE_EN },
  { text: "wouldn't miss it", want: "in", ctx: INVITE_EN },
  { text: "yep", want: "in", ctx: TENT_EN },
  { text: "olur, gelirim", want: "in", ctx: INVITE_TR },
  { text: "ben de varım bu hafta", want: "in", ctx: TENT_TR },
  { text: "count me out this time", want: "out", ctx: INVITE_EN },
  { text: "can't, kid's birthday", want: "out", ctx: TENT_EN },
  { text: "nope", want: "out", ctx: INVITE_EN },
  { text: "maalesef gelemem", want: "out", ctx: INVITE_TR },
  { text: "işim var bu hafta", want: "out", ctx: TENT_TR },
  { text: "might do", want: "unclear", ctx: INVITE_EN },
  { text: "duruma göre", want: "unclear", ctx: INVITE_TR },
  { text: "is it 7 or 8 a side?", want: "unclear", ctx: INVITE_EN },
  { text: "my brother's coming", want: "unclear", ctx: INVITE_EN },
  { text: "Mehmet de gelsin mi?", want: "unclear", ctx: INVITE_TR },
  { text: "sure", want: "unclear", ctx: RATED_EN },
];

/**
 * SLICE S2 (2026-10-20): the time now, and the swipe-reply. "can't
 * tomorrow sorry" the evening before the match came back unclear because
 * the model did not know today's date. A swipe-reply shows only the quoted
 * message, so a "yes" to an OLDER invite is an answer even when a rating DM
 * came after it, and a "yes" to the rating DM is not.
 */
const SLICE_S2: Case[] = [
  { text: "can't tomorrow sorry", want: "out", ctx: INVITE_EN },
  {
    text: "can't tomorrow sorry",
    want: "unclear",
    ctx: {
      ...INVITE_EN,
      // Sat 17 Oct: "tomorrow" is Sunday, not the Tuesday match.
      replyContext: { ...sent(), now: new Date("2026-10-17T10:00:00Z"), recent: [{ ...inviteMsg("en"), at: new Date("2026-10-17T09:00:00Z") }] },
      label: "invite, sent on Saturday",
    },
  },
  { text: "yes", want: "in", ctx: { ...INVITE_EN, replyContext: quoting(inviteMsg("en")), label: "swipe-reply to the invite, a rating DM came after" } },
  { text: "evet", want: "in", ctx: { ...TENT_TR, replyContext: quoting(tentMsg("tr")), label: "swipe-reply to the follow-up" } },
  { text: "yes", want: "unclear", ctx: { ...INVITE_EN, replyContext: quoting(ratingMsg("2026-10-19T16:45:00Z")), label: "swipe-reply to the rating DM" } },
  {
    text: "yes",
    want: "unclear",
    ctx: { ...INVITE_EN, replyContext: sent(inviteMsg("en"), ratingMsg("2026-10-19T16:45:00Z")), label: "not a reply: invite, then the rating DM" },
  },
  {
    text: "yes",
    want: "in",
    ctx: { ...INVITE_EN, replyContext: sent(ratingMsg(), inviteMsg("en")), label: "not a reply: rating DM, then the invite" },
  },
];

interface OldModule {
  SYSTEM_PROMPT: string;
  userTurn: (text: string, ctx: Record<string, unknown>) => string;
  parse: (raw: string) => { decision: string; confidence: number; reasoning: string };
}

async function main() {
  const key = spendDevApiKeyOrExit("scripts/dryrun-match-availability.ts");
  if (MODEL !== MATCH_AVAILABILITY_MODEL) {
    console.error(`REFUSING: this harness pins ${MODEL} but production classifies with ${MATCH_AVAILABILITY_MODEL}.`);
    process.exit(1);
  }
  const which = process.env.PROMPT === "old" ? "old" : "new";
  let old: OldModule | null = null;
  if (which === "old") {
    const p = process.env.OLD_PROMPT_MODULE;
    if (!p) {
      console.error("REFUSING: PROMPT=old needs OLD_PROMPT_MODULE.");
      process.exit(1);
    }
    old = (await import(pathToFileURL(p).href)) as OldModule;
  }

  const anthropic = new Anthropic({ apiKey: key });
  let calls = 0;
  let usd = 0;
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  /** The production call's exact shape, with usage recorded so the cap is
   *  enforced on real cost. */
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

  const classify = async (c: Case) => {
    if (old) {
      const { oldAsked, ...ctx } = c.ctx;
      return old.parse(await call(old.SYSTEM_PROMPT, old.userTurn(c.text, { ...ctx, wasAskedToPlay: oldAsked })));
    }
    const { oldAsked: _a, label: _l, ...ctx } = c.ctx;
    return classifyMatchAvailability(c.text, ctx, call);
  };

  // The verdict log is the production line; the table below is the read.
  console.info = () => {};
  const sets: Record<string, Case[]> = { main: CASES, heldout: HELD_OUT, s2: SLICE_S2, noregex: NO_REGEX };
  const setName = process.env.SET && sets[process.env.SET] ? process.env.SET : "main";
  const set = process.env.ONLY ? sets[setName].filter((c) => c.text === process.env.ONLY && (!process.env.ONLY_LABEL || c.ctx.label.startsWith(process.env.ONLY_LABEL))) : sets[setName];
  console.log(`── match-availability, ${which} prompt, ${MODEL}, set ${setName} (${set.length}), REPEAT=${REPEAT}, cap $${MAX_USD} ──`);
  let bad = 0;
  for (const c of set) {
    const got: string[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < REPEAT; i++) {
      if (usd >= MAX_USD) {
        console.error(`\nSTOPPED: cost cap $${MAX_USD} reached after ${calls} calls.`);
        process.exit(2);
      }
      const r = await classify(c);
      got.push(`${r.decision}@${r.confidence.toFixed(2)}`);
      reasons.push(r.reasoning);
    }
    const agreed = got.filter((g) => g.startsWith(`${c.want}@`)).length;
    const pass = agreed === REPEAT;
    if (!pass) bad++;
    console.log(
      `  ${pass ? "✓" : "✗"} ${agreed}/${REPEAT}  want=${c.want.padEnd(7)} got=[${got.join(", ")}]  ${JSON.stringify(c.text)} (${c.ctx.label})`,
    );
    // A miss shows the model's own reasoning, the raw output to report.
    if (!pass) for (const why of reasons) console.log(`      reasoning: ${JSON.stringify(why)}`);
  }
  console.log(
    `\n${set.length - bad}/${set.length} cases agreed. ${calls} live calls. ` +
      `tokens: in ${tokens.input}, out ${tokens.output}, cache write ${tokens.cacheWrite}, cache read ${tokens.cacheRead}. ` +
      `cost ≈ $${usd.toFixed(4)}`,
  );
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
