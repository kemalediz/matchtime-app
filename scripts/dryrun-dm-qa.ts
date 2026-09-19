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
 *
 * No database, no DM, no BotJob: the CONTEXT is built by the real
 * `formatScopedContext` from fixture rows, and the answers are printed.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import Anthropic from "@anthropic-ai/sdk";
import { composeScopedAnswer, formatScopedContext, type ScopedContextInput } from "../src/lib/dm-qa.ts";

const LANG = process.env.LANG_UNDER_TEST === "en" ? "en" : "tr";
const REPEAT = Number(process.env.REPEAT ?? "5") || 5;

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
  },
};

const CONTEXT_TR = formatScopedContext(FIXTURE, "tr");
const CONTEXT_EN = formatScopedContext(FIXTURE, "en");

interface Q {
  q: string;
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
  const key = spendDevApiKeyOrExit("scripts/dryrun-dm-qa.ts");
  const anthropic = new Anthropic({ apiKey: key });
  const questions = LANG === "tr" ? QUESTIONS_TR : QUESTIONS_EN;
  const context = LANG === "tr" ? CONTEXT_TR : CONTEXT_EN;

  const counts = { calls: 0, turkish: 0, englishTells: 0, dashes: 0, formal: 0, abi: 0, gluedSuffix: 0, pluralYou: 0, fakeMarkup: 0, rawFakeMarkup: 0, capsStatus: 0, wrongDay: 0, englishPhrase: 0, facts: 0, factChecks: 0, leak: 0, apology: 0 };
  console.log(`── DM Q&A dry run, language=${LANG}, REPEAT=${REPEAT} ──`);
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
        call: async (system, user) => {
          const resp = await anthropic.messages.create({
            // MIRRORS `src/lib/dm-qa.ts` EXACTLY, and has to: this
            // harness exists to measure the real call, so a model or
            // a thinking posture that differs from production makes
            // every flag count below a measurement of something the
            // players never see.
            model: "claude-sonnet-5",
            max_tokens: 600,
            thinking: { type: "disabled" },
            system,
            messages: [{ role: "user", content: user }],
          });
          const block = resp.content.find((c) => c.type === "text");
          const text = block && block.type === "text" ? block.text : null;
          // Counted on the RAW model text, before the clean-up strips it.
          if (text && FAKE_MARKUP.test(text)) counts.rawFakeMarkup++;
          return { text, truncated: resp.stop_reason === "max_tokens" };
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
