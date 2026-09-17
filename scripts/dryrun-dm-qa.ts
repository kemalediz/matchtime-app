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
 *   REPEAT=5 npx tsx --env-file=<file with ANTHROPIC_API_KEY> scripts/dryrun-dm-qa.ts
 *   LANG_UNDER_TEST=en REPEAT=2 npx tsx ... scripts/dryrun-dm-qa.ts   # English control
 *
 * No database, no DM, no BotJob: the CONTEXT is a fixture in the exact
 * shape `buildScopedContext` produces, and the answers are printed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { composeScopedAnswer } from "../src/lib/dm-qa.ts";

const LANG = process.env.LANG_UNDER_TEST === "en" ? "en" : "tr";
const REPEAT = Number(process.env.REPEAT ?? "5") || 5;

const CONTEXT_TR = [
  "GROUP: Cuma Futbol",
  "",
  "UPCOMING MATCH:",
  "- Cuma Maçı on 18 Eylül Cuma 21:00 (UK time)",
  "- Venue: Sim Arena",
  "- Squad: 11/14 confirmed, 2 on the bench",
  "- You are currently: CONFIRMED",
  "- Confirmed players: Erdal Özkan, Mehmet Yılmaz, Ali Çelik, Can Şahin, Emre Doğan, Burak Aydın, Oğuz Kaya, İlker Demir, Serkan Arslan, Hakan Koç, Tolga Güneş",
  "- Bench: Volkan Erdem, Kerem Aslan",
  "",
  "YOUR STATS:",
  "- Games played: 6/8 (75% attendance)",
  "- Average rating: 7.2 (squad avg 6.8)",
  "- Man of the Match: 2",
  "- Record: 4W 1D 1L",
  "- Form (last 5): 7.4 (up)",
  "",
  "## Recent History",
  "Completed matches: 8 total.",
  "",
  "Completed matches (oldest first):",
  "  - 04 Sept 2026: Kırmızı 5 - 3 Sarı | MoM: Erdal Özkan",
  "  - 11 Sept 2026: Kırmızı 2 - 2 Sarı | MoM: Mehmet Yılmaz",
].join("\n");

const CONTEXT_EN = CONTEXT_TR.replace("18 Eylül Cuma 21:00", "Fri 18 Sep at 21:00");

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
  { q: "geçen hafta maçın adamı kim oldu", mustContainAny: ["Mehmet Yılmaz"] },
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
/** Plural / formal address a "sen" DM should not use. */
const FORMAL = /\b(siz|sizin|sizi|sizinle|yapabilirsiniz|görüşürüz beyler)\b/i;

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("REFUSING: no ANTHROPIC_API_KEY — a run that cannot reach the model proves nothing.");
    process.exit(1);
  }
  const anthropic = new Anthropic({ apiKey: key });
  const questions = LANG === "tr" ? QUESTIONS_TR : QUESTIONS_EN;
  const context = LANG === "tr" ? CONTEXT_TR : CONTEXT_EN;

  const counts = { calls: 0, turkish: 0, englishTells: 0, dashes: 0, formal: 0, abi: 0, gluedSuffix: 0, pluralYou: 0, fakeMarkup: 0, rawFakeMarkup: 0, capsStatus: 0, facts: 0, factChecks: 0, leak: 0, apology: 0 };
  console.log(`── DM Q&A dry run, language=${LANG}, REPEAT=${REPEAT} ──`);
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
            model: "claude-sonnet-4-5",
            max_tokens: 600,
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
