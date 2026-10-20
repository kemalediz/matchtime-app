/**
 * LIVE dry run for the roster check-in classifier (2026-10-19).
 *
 * The unit tests (`src/lib/__tests__/roster-survey-classifier.test.ts`)
 * prove the wiring with the model injected. Only the real model can show
 * that "Evet bu ay varım" and "yes I'm in this month" are read as `in`,
 * that a break with a way back stays `maybe`, and that "ok" stays
 * `unclear`, so this asks it, through the production function.
 *
 *   REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-roster-survey.ts
 *   SET=month REPEAT=1 node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-roster-survey.ts
 *
 * `SET=month` runs only the time-bounded yes cases (the 2026-10-19 bug);
 * the default runs every case, English and Turkish.
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Touches no
 * database and sends nothing: it imports the DB-free classifier and prints
 * what came back, with a running cost and a hard stop at MAX_USD.
 */
import Anthropic from "@anthropic-ai/sdk";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import {
  classifyRosterReply,
  type RosterClassification,
  type RosterReplyContext,
} from "../src/lib/roster-survey-classifier.ts";
import { costOf, systemBlock } from "../src/lib/pipeline/llm.ts";
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING } from "../src/lib/models.ts";

const REPEAT = Number(process.env.REPEAT ?? "1") || 1;
const MODEL = HAIKU_MODEL;
/** Hard cap for this run, in US dollars. */
const MAX_USD = 0.2;

type Category = RosterClassification["category"];
interface Case {
  text: string;
  want: Category;
  lang: "en" | "tr";
}

const en = (text: string, want: Category): Case => ({ text, want, lang: "en" });
const tr = (text: string, want: Category): Case => ({ text, want, lang: "tr" });

/** A yes for a stated stretch (the 2026-10-19 bug). None of these is an
 *  example in the prompt, so a pass is the rule, not an echo. */
const MONTH: Case[] = [
  tr("Evet bu ay varım", "in"),
  en("yes I'm in this month", "in"),
  en("yes count me in for the month", "in"),
  tr("bu sezon varım", "in"),
  en("in until the summer at least", "in"),
];

const CASES: Case[] = [
  ...MONTH,
  // ── in ──
  en("yes", "in"),
  en("I'm in", "in"),
  en("definitely", "in"),
  en("still keen", "in"),
  en("of course", "in"),
  en("100%", "in"),
  en("always in mate", "in"),
  tr("evet", "in"),
  tr("varım", "in"),
  tr("devam", "in"),
  tr("tabii ki", "in"),
  tr("evet abi her hafta varım", "in"),
  // ── maybe: some weeks, it depends, or a break with a way back ──
  en("depends", "maybe"),
  en("sometimes", "maybe"),
  en("if I'm free", "maybe"),
  en("not every week", "maybe"),
  en("maybe", "maybe"),
  en("when I can", "maybe"),
  en("I'll play if there's room", "maybe"),
  en("not for now", "maybe"),
  en("not for now but maybe later", "maybe"),
  en("may come in the future", "maybe"),
  en("taking a break for a bit", "maybe"),
  en("we'll see how it goes", "maybe"),
  en("not this month, injured", "maybe"),
  en("hi, may be i will come in the near future but not for now", "maybe"),
  tr("belki", "maybe"),
  tr("ara sıra", "maybe"),
  tr("duruma göre", "maybe"),
  tr("şimdilik yok", "maybe"),
  tr("bir süre ara vereceğim", "maybe"),
  tr("sonra bakarız", "maybe"),
  tr("bu ay yokum, sakatım", "maybe"),
  // ── out: a clear stop, no way back ──
  en("I'm done", "out"),
  en("won't be playing anymore", "out"),
  en("I'm out for good", "out"),
  en("moving away", "out"),
  en("no thanks, please take me off", "out"),
  en("stopping football completely", "out"),
  tr("bırakıyorum", "out"),
  tr("artık oynamayacağım", "out"),
  tr("beni çıkarın", "out"),
  tr("taşındım, artık gelemem", "out"),
  // ── unclear: does not answer the check-in ──
  en("what is this?", "unclear"),
  en("who is this?", "unclear"),
  en("🙂", "unclear"),
  en("ok", "unclear"),
  en("thanks for letting me know", "unclear"),
  tr("tamam", "unclear"),
  tr("bu ne?", "unclear"),
  tr("kimsin sen?", "unclear"),
];

async function main() {
  const key = spendDevApiKeyOrExit("scripts/dryrun-roster-survey.ts");
  const anthropic = new Anthropic({ apiKey: key });
  let calls = 0;
  let usd = 0;
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  /** The production call's exact shape, with the usage recorded so the
   *  cap is enforced on real cost. */
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

  const set = process.env.SET === "month" ? MONTH : CASES;
  console.log(`── roster check-in classifier, ${MODEL}, set ${process.env.SET ?? "all"} (${set.length} cases), REPEAT=${REPEAT}, cap $${MAX_USD} ──`);
  let bad = 0;
  for (const c of set) {
    const ctx: RosterReplyContext = { clubName: "Sutton FC", playerName: "Ali" };
    const got: string[] = [];
    for (let i = 0; i < REPEAT; i++) {
      if (usd >= MAX_USD) {
        console.error(`\nSTOPPED: cost cap $${MAX_USD} reached after ${calls} calls.`);
        process.exit(2);
      }
      const r = await classifyRosterReply(c.text, ctx, call);
      got.push(`${r.category}@${r.confidence.toFixed(2)}`);
    }
    const agreed = got.filter((g) => g.startsWith(`${c.want}@`)).length;
    const pass = agreed === REPEAT;
    if (!pass) bad++;
    console.log(`  ${pass ? "✓" : "✗"} ${agreed}/${REPEAT}  ${c.lang} want=${c.want.padEnd(7)} got=[${got.join(", ")}]  ${JSON.stringify(c.text)}`);
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
