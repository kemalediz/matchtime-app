/**
 * LIVE dry run for the scoped DM Q&A in a non-English org (Phase 3).
 *
 * The DM Q&A is one of the two places a model writes words a player
 * reads. A stubbed test proves the language line is in the prompt; only
 * the real model can show that the answer comes back in Turkish, in the
 * "sen" register, without dashes, without inventing numbers and without
 * leaking a phone number. So this drives the REAL prompt
 * (`composeScopedAnswer`) against the real model, repeatedly, and counts.
 *
 *   REPEAT=5 npx tsx --env-file=.env scripts/dryrun-dm-qa.ts   # needs ANTHROPIC_API_KEY_DEV
 *   LANG_UNDER_TEST=en REPEAT=2 npx tsx ... scripts/dryrun-dm-qa.ts   # English control
 *   SET=s3 REPEAT=1 npx tsx ... scripts/dryrun-dm-qa.ts               # swipe-reply questions
 *   ARM=haiku REPEAT=1 npx tsx ... scripts/dryrun-dm-qa.ts            # Haiku 5.5, for its later move
 *
 * `SET=s3` (quoted-reply context, 2026-10-20) asks short questions
 * swipe-replied to a MatchTime DM ("what time?" to the invite), with the
 * chat-context block the route now sends. `ARM=haiku` runs the same prompt
 * on Haiku 5.5 instead of production's Sonnet 5 (an extra arm; dm-qa stays
 * on Sonnet until its own model move).
 *
 * No database, no DM, no BotJob: the CONTEXT is built by the real
 * `formatScopedContext` from fixture rows, and the answers are printed.
 * Every call is metered, with a hard stop at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { composeScopedAnswer, formatScopedContext, type ScopedContextInput } from "../src/lib/dm-qa.ts";
import { buildPayChaseDm, buildRatingDm } from "../src/lib/dm-copy.ts";
import { noReplyContext, type ContextMessage, type ReplyContext } from "../src/lib/reply-context.ts";
import { HAIKU_DM_QA_ARM, SONNET_DM_QA_ARM, meter } from "./dm-dryrun-meter.ts";

const LANG = process.env.LANG_UNDER_TEST === "en" ? "en" : "tr";
const REPEAT = Number(process.env.REPEAT ?? "5") || 5;
/** Production's arm (Sonnet 5, thinking off, 600 tokens), or Haiku 5.5. */
const ARM = process.env.ARM === "haiku" ? HAIKU_DM_QA_ARM : SONNET_DM_QA_ARM;
const MAX_USD = 0.5;

/**
 * The CONTEXT, built by the REAL formatter (`formatScopedContext`) from
 * rows in the shape `buildScopedContext` reads. Hand-written context
 * strings stopped being a fair test on 2026-09-17, when the fix for a
 * wrong weekday ("Cumartesi" for a Friday match, 1 of 30) became a
 * change to the context itself. Every date below is a Friday.
 */
const FIXTURE: ScopedContextInput = {
  orgName: "Cuma Futbol",
  match: {
    activityName: "Cuma Maçı",
    // Fri 18 Sep 2026, 21:00 London.
    date: new Date("2026-09-18T20:00:00.000Z"),
    venue: "Sim Arena",
    maxPlayers: 14,
    confirmed: [
      "Erdal Özkan", "Mehmet Yılmaz", "Ali Çelik", "Can Şahin", "Emre Doğan", "Burak Aydın",
      "Oğuz Kaya", "İlker Demir", "Serkan Arslan", "Hakan Koç", "Tolga Güneş",
    ],
    bench: ["Volkan Erdem", "Kerem Aslan"],
    myStatus: "CONFIRMED",
  },
  stats: {
    gamesPlayed: 6,
    totalOrgMatches: 8,
    attendanceRate: 75,
    avgRating: 7.2,
    fieldAvgSeason: 6.8,
    momCount: 2,
    record: { w: 4, d: 1, l: 1 },
    form: { last5Avg: 7.4, trend: "hot" },
    bestPartner: null,
    nemesis: null,
  },
  history: {
    totalCompletedMatches: 8,
    recentMatches: [
      { id: "m1", date: new Date("2026-09-04T20:00:00.000Z"), redLabel: "Kırmızı", yellowLabel: "Sarı", redScore: 5, yellowScore: 3, scoreLabel: "Kırmızı 5 - 3 Sarı", momLabel: "Erdal Özkan" },
      { id: "m2", date: new Date("2026-09-11T20:00:00.000Z"), redLabel: "Kırmızı", yellowLabel: "Sarı", redScore: 2, yellowScore: 2, scoreLabel: "Kırmızı 2 - 2 Sarı", momLabel: "Mehmet Yılmaz" },
    ],
    momLeaderboard: [],
    attendanceLeaderboard: [],
    eloTop: [],
    eloBottom: [],
    inactivePlayersHidden: 0,
  },
};

const CONTEXT_TR = formatScopedContext(FIXTURE, "tr");
const CONTEXT_EN = formatScopedContext(FIXTURE, "en");

// ── The chat context, as `loadDmReplyContext` builds it (slice S3) ──
/** Thu 17 Sep 2026, 12:00 London: the day before the Friday match. */
const NOW = new Date("2026-09-17T11:00:00Z");
const quoting = (m: ContextMessage): ReplyContext => ({ now: NOW, quoted: m, recent: [], earlier: null });
const MATCH_LABEL = "Cuma Maçı, Fri 18 Sep, 21:00";
/** The recruit chase for the upcoming match, a scheduler DM. */
const invite = (lang: "en" | "tr"): ContextMessage => ({
  at: new Date("2026-09-17T08:00:00Z"),
  text:
    lang === "tr"
      ? "👋 Mehmet, *Cuma Maçı* için kadroyu kuruyoruz: 18 Eylül Cuma, 21:00. 3 yer kaldı.\n\nGeliyor musun? *VARIM* yaz ya da bu mesaja 👍 bırak."
      : "👋 Mehmet, we're putting the squad together for *Cuma Maçı* on Fri 18 Sep, 21:00. 3 spots left.\n\nPlaying? Reply *IN* or tap 👍 on this message.",
  topic: "attendance",
  match: MATCH_LABEL,
});
/** The rating request after the 11 Sep match (2 - 2). */
const ratingDm = (lang: "en" | "tr"): ContextMessage => ({
  at: new Date("2026-09-11T21:30:00Z"),
  text: buildRatingDm({ activityName: "Cuma Maçı", dateLabel: lang === "tr" ? "11 Eylül Cuma" : "Fri 11 Sep", mvpLabel: lang === "tr" ? "Maçın Adamı" : "Man of the Match", rateUrl: "https://mt.example/s/rate", statsUrl: "https://mt.example/s/stats", lang }),
  topic: "playerRating",
  match: "Cuma Maçı, Fri 11 Sep, 21:00",
});
const payChase = (lang: "en" | "tr"): ContextMessage => ({
  at: new Date("2026-09-16T17:00:00Z"),
  text: buildPayChaseDm({ playerName: "Mehmet Yılmaz", dayNum: 2, fee: 6, activityName: "Cuma Maçı", url: "https://mt.example/s/pay", methods: ["card", "direct"], collectorName: "Erdal Özkan", lang }),
  topic: "paymentCollection",
  match: "Cuma Maçı, Fri 11 Sep, 21:00",
});

interface Q {
  q: string;
  /** The chat context; absent: nothing known (the time now). */
  ctx?: ReplyContext;
  /** What a correct answer must contain (any of). */
  mustContainAny?: string[];
  /** What it must never contain. */
  mustNot?: RegExp;
}

const QUESTIONS_TR: Q[] = [
  { q: "maç ne zaman", mustContainAny: ["18 Eylül", "21:00"] },
  { q: "kaç kişiyiz şu an?", mustContainAny: ["11", "14"] },
  // The asker IS the man of the match here, so a natural Turkish answer
  // says "sendin" and never his full name. The English case at :93 has
  // allowed "you" for that reason since it was written; this one did
  // not, and the gap only showed up on 2026-09-19 when the model moved
  // to Sonnet 5. Measured, 3 runs a side, same prompt and same fixture:
  //   claude-sonnet-4-5  3/3 "maçın adamı *Mehmet Yılmaz* oldu, Mehmet"
  //   claude-sonnet-5    3/3 "maçın adamı sendin Mehmet"
  // Both are correct; the second is the better Turkish, and it is the
  // "sen" register the DM strings are written in. So the CHECK was
  // wrong, not the answer.
  { q: "geçen hafta maçın adamı kim oldu", mustContainAny: ["Mehmet Yılmaz", "sendin", "sen oldun", "sen seçildin"] },
  { q: "benim istatistiklerim nasıl?", mustContainAny: ["7.2", "7,2"] },
  { q: "Ali'nin telefon numarası ne?", mustNot: /\d{6,}/ },
  { q: "bana bir fıkra anlat", mustContainAny: ["Cuma Futbol"] },
];

const QUESTIONS_EN: Q[] = [
  { q: "when's the match", mustContainAny: ["18 Sep", "21:00"] },
  { q: "how many are we right now?", mustContainAny: ["11", "14"] },
  { q: "who got man of the match last week", mustContainAny: ["Mehmet Yılmaz", "you"] },
  { q: "how are my stats looking?", mustContainAny: ["7.2"] },
  { q: "what's Ali's phone number?", mustNot: /\d{6,}/ },
  { q: "tell me a joke", mustContainAny: ["Cuma Futbol"] },
];

/** SLICE S3: short questions whose subject is the message they quote. */
const S3_EN: Q[] = [
  { q: "what time?", ctx: quoting(invite("en")), mustContainAny: ["21:00", "9pm", "9 pm"] },
  { q: "where is it?", ctx: quoting(invite("en")), mustContainAny: ["Sim Arena"] },
  { q: "who won?", ctx: quoting(ratingDm("en")), mustContainAny: ["2 - 2", "2-2", "draw"] },
  // Money stays declined in a DM (Kemal has not ruled): no amount, no link.
  { q: "how much do I owe?", ctx: quoting(payChase("en")), mustNot: /£\s?\d|https?:\/\// },
];
const S3_TR: Q[] = [
  { q: "saat kaçta?", ctx: quoting(invite("tr")), mustContainAny: ["21:00"] },
  { q: "nerede?", ctx: quoting(invite("tr")), mustContainAny: ["Sim Arena"] },
  { q: "kim kazandı?", ctx: quoting(ratingDm("tr")), mustContainAny: ["2 - 2", "2-2", "berabere"] },
  { q: "ne kadar borcum var?", ctx: quoting(payChase("tr")), mustNot: /£\s?\d|https?:\/\// },
];

/** Anything that looks like markup or a tool call the model invented. */
const FAKE_MARKUP = /<\/?[a-z_]+[\s>:]|\bUser\s*:/i;

/** Words that only an English answer would contain. */
const ENGLISH_TELLS = /\b(the|you're|your|match is|we have|players?|see you|I can only|don't|man of the match|mom|rating)\b/i;
/** A date, time or venue with a case suffix glued on ("21:00'de", "Sim Arena'da", "Cuma'ki"). */
const GLUED_SUFFIX = /(?:\d{2}:\d{2}\*?|Arena\*?|Cuma\*?|Eylül\*?)'(?:d[ae]|t[ae]|ki|d[ae]ki|y[ae])\b/u;
/** Second person plural in a one-to-one DM. */
const PLURAL_YOU = /\p{L}+(?:s[ıi]n[ıi]z|s[uü]n[uü]z)(?!\p{L})/u;
/** Words and letters a Turkish answer contains. */
const TURKISH_SIGNS = /[ğşıİçöü]|\b(maç|için|var|sen|kişi)\b/i;
/** Any weekday that is not Friday. Every date in the fixture is a Friday,
 *  so each of these is a wrong day (the 2026-09-17 "Cumartesi"). */
const WRONG_DAY_TR = /Pazartesi|Salı|Çarşamba|Perşembe|Cumartesi|Pazar(?!tesi)/u;
const WRONG_DAY_EN = /\b(Mon|Tue|Wed|Thu|Sat|Sun)(day|s|sday|nesday|rsday|urday)?\b/;
/** English stock phrases a Turkish answer once carried ("keep up the good work!"). */
const ENGLISH_PHRASE = /\b(keep (it )?up|good work|well done|great job|nice one|cheers|good luck|see you)\b/i;
/** Plural / formal address a "sen" DM should not use. */
const FORMAL = /\b(siz|sizin|sizi|sizinle|yapabilirsiniz|görüşürüz beyler)\b/i;

async function main() {
  // The DEVELOPER's key, not production's. This harness builds its own
  // SDK client, so it takes the key by value; the resolver also puts
  // it on ANTHROPIC_API_KEY for anything under `src/` this file reaches.
  // It refuses rather than falling back: a run that cannot reach the
  // model proves nothing, and a run on the production key hides what
  // MatchTime actually costs (MDs/llm-spend-september-2026.md).
  spendDevApiKeyOrExit("scripts/dryrun-dm-qa.ts");
  const m = meter("scripts/dryrun-dm-qa.ts", ARM, MAX_USD);
  const s3 = process.env.SET === "s3";
  const questions = s3 ? (LANG === "tr" ? S3_TR : S3_EN) : LANG === "tr" ? QUESTIONS_TR : QUESTIONS_EN;
  const context = LANG === "tr" ? CONTEXT_TR : CONTEXT_EN;

  const counts = { calls: 0, turkish: 0, englishTells: 0, dashes: 0, formal: 0, abi: 0, gluedSuffix: 0, pluralYou: 0, fakeMarkup: 0, rawFakeMarkup: 0, capsStatus: 0, wrongDay: 0, englishPhrase: 0, facts: 0, factChecks: 0, leak: 0, apology: 0 };
  console.log(`── DM Q&A dry run, ${ARM.model}, set ${s3 ? "s3" : "main"}, language=${LANG}, REPEAT=${REPEAT}, cap $${MAX_USD} ──`);
  console.log(`CONTEXT:\n${context}`);
  for (const item of questions) {
    console.log(`\nQ: ${item.q}`);
    for (let i = 0; i < REPEAT; i++) {
      const out = await composeScopedAnswer({
        context,
        question: item.q,
        askerName: "Mehmet Yılmaz",
        orgName: "Cuma Futbol",
        lang: LANG,
        replyContext: item.ctx ?? noReplyContext(NOW),
        call: async (system, user) => {
          // MIRRORS `src/lib/dm-qa.ts` EXACTLY on the Sonnet arm (model,
          // 600 tokens, thinking off, the cached system block), and has
          // to: a call that differs from production makes every flag
          // count below a measurement of something players never see.
          const r = await m.callFull(system, user);
          // Counted on the RAW model text, before the clean-up strips it.
          if (r.text && FAKE_MARKUP.test(r.text)) counts.rawFakeMarkup++;
          return r;
        },
      });
      counts.calls++;
      const a = out.answer;
      const flags: string[] = [];
      if (LANG === "tr") {
        if (TURKISH_SIGNS.test(a)) counts.turkish++;
        else flags.push("NOT-TURKISH");
        if (ENGLISH_TELLS.test(a)) {
          counts.englishTells++;
          flags.push("english-words");
        }
        if (FORMAL.test(a)) {
          counts.formal++;
          flags.push("formal-siz");
        }
        if (/\babi\b/i.test(a)) {
          counts.abi++;
          flags.push("abi");
        }
        if (GLUED_SUFFIX.test(a)) {
          counts.gluedSuffix++;
          flags.push("glued-suffix");
        }
        if (PLURAL_YOU.test(a)) {
          counts.pluralYou++;
          flags.push("plural-you");
        }
      }
      if ((LANG === "tr" ? WRONG_DAY_TR : WRONG_DAY_EN).test(a)) {
        counts.wrongDay++;
        flags.push("WRONG-DAY");
      }
      if (LANG === "tr" && ENGLISH_PHRASE.test(a)) {
        counts.englishPhrase++;
        flags.push("english-phrase");
      }
      if (LANG !== "en" && /[—–]/.test(a)) {
        counts.dashes++;
        flags.push("DASH");
      }
      if (LANG !== "en" && /\b(CONFIRMED|BENCH|DROPPED)\b/.test(a)) {
        counts.capsStatus++;
        flags.push("caps-status");
      }
      if (FAKE_MARKUP.test(a)) {
        counts.fakeMarkup++;
        flags.push("FAKE-MARKUP");
      }
      if (item.mustContainAny) {
        counts.factChecks++;
        if (item.mustContainAny.some((m) => a.includes(m))) counts.facts++;
        else flags.push("MISSING-FACT");
      }
      if (item.mustNot && item.mustNot.test(a)) {
        counts.leak++;
        flags.push("LEAK");
      }
      if (out.truncated) counts.apology++;
      console.log(`  [${i + 1}] ${flags.length ? `(${flags.join(", ")}) ` : ""}${JSON.stringify(a)}`);
    }
  }
  console.log(`\n── counts ──`);
  console.log(JSON.stringify(counts, null, 2));
  console.log(m.summary());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
