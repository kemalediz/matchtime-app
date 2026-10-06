/**
 * THE HOUSE STYLE FOR TEXT A MODEL WROTE: no em dash, no en dash.
 *
 * Kemal, 2026-10-06: "remove long dashes". The fixed copy carries none
 * (`__tests__/no-long-dashes.test.ts` guards the string tables and the
 * pages), but a model writes them however firmly a prompt asks it not to
 * (measured 2026-09-17: 5 of 25 Turkish chases carried one). So the rule
 * is applied here, in code, to every model-composed message before it is
 * sent, rather than asked for in a prompt and hoped for.
 *
 * PURE: no Prisma, no database, so the pipeline's composer and the
 * Playwright worker can both load it. `message-analyzer.ts` re-exports
 * `applyHouseStyle` for the callers that always imported it from there.
 *
 * WHO CALLS IT (every path where a model's words reach a person):
 *   - the scheduled chase        `message-analyzer.ts` composeChaseFromMatch
 *   - the scoped DM answer       `dm-qa.ts` composeScopedAnswer
 *   - the generic stats answer   `pipeline/stats-generic.ts`
 *   - the onboarding analyser's evidence notes and the rating adjuster's
 *     reasons, which an organiser reads on a web page
 *
 * WHAT A DASH BECOMES, in the order the rules are tried on each line:
 *   1. between two clock times        " to " in English, "-" in Turkish
 *   2. between two digits             "-"   (a score, a range, a season)
 *   3. an en dash inside a word       "-"   (Jean-Pierre, 7-a-side)
 *   4. hugging a WhatsApp marker      removed, so `*bold*` stays bold
 *   5. opening a line                 "- "  (a bullet)
 *   6. after a bold label that opens
 *      a line, in English             ": "
 *   7. standing in for a missing
 *      value, next to a bracket or
 *      after a colon                  "-"
 *   8. after a sentence's full stop,
 *      before punctuation, or ending
 *      a line                         removed
 *   9. anything else                  ", "
 * Links are lifted out first and put back untouched.
 */
import { normaliseLang, type Lang } from "./i18n/lang";

const LONG_DASH = /[—–]/;
const LINK = /(?:https?:\/\/|www\.)\S+/g;
/** Private-use characters that stand in for a link while a line is
 *  rewritten. They never occur in WhatsApp text. */
const HOLD_OPEN = "";
const HOLD_CLOSE = "";
const HELD = /(\d+)/g;

const TIME = String.raw`\d{1,2}[:.]\d{2}`;
const TIME_RANGE = new RegExp(`(${TIME})\\s*[—–]\\s*(${TIME})`, "g");

/** True when the text carries an em or an en dash anywhere. */
export function hasLongDash(text: string): boolean {
  return LONG_DASH.test(text);
}

/**
 * Replace every em and en dash in model-written text. Dash-free text is
 * returned unchanged, byte for byte.
 */
export function stripLongDashes(text: string, lang?: Lang | string | null): string {
  if (!LONG_DASH.test(text)) return text;
  const english = normaliseLang(lang) === "en";
  return text
    .split("\n")
    .map((line) => (LONG_DASH.test(line) ? rewriteLine(line, english) : line))
    .join("\n");
}

function rewriteLine(line: string, english: boolean): string {
  const links: string[] = [];
  const held = line.replace(LINK, (link) => `${HOLD_OPEN}${links.push(link) - 1}${HOLD_CLOSE}`);
  if (!LONG_DASH.test(held)) return line;

  let out = held
    // 1. a time range
    .replace(TIME_RANGE, english ? "$1 to $2" : "$1-$2")
    // 2. a score, a range, a season: digits either side
    .replace(/(\d)[—–](?=\d)/g, "$1-")
    .replace(/(\d)\s+–\s+(?=\d)/g, "$1-")
    // 3. an en dash inside a word is a hyphen (a name, "7-a-side")
    .replace(/(?<=[\p{L}\p{N}])–(?=[\p{L}\p{N}])/gu, "-")
    // 4. a dash hugging a WhatsApp marker would leave a space inside the
    //    marker, and `*Kemal, *` is not bold. Drop the dash instead.
    .replace(/\s*[—–]\s*(?=[*_~](?:[\s.,;:!?)\]]|$))/g, "")
    .replace(/(?<=(?:^|\s)[*_~])[—–]\s*/g, "")
    // 5. a dash that opens the line is a bullet
    .replace(/^(\s*)[—–]+\s*$/, "$1-")
    .replace(/^(\s*)[—–]\s*/, "$1- ");
  // 6. a bold label opening the line: "🗓 *Tuesday 7-a-side* — need 1 more"
  if (english) {
    out = out.replace(/^([^\p{L}\p{N}*_~]*\*[^*]+\*)\s*[—–]\s*(?=\S)/u, "$1: ");
  }
  out = out
    // 7. a lone dash standing in for a missing value
    .replace(/([:(\[]\s*)[—–]/g, "$1-")
    .replace(/[—–](\s*[)\]])/g, "-$1")
    // 8. after a sentence end, before punctuation, or at the end
    .replace(/([.!?…])\s*[—–]\s*/g, "$1 ")
    .replace(/\s*[—–]\s*(?=[,.;:!?]|$)/g, "")
    // 9. everything else joins two clauses
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/\s+$/, "");

  return out.replace(HELD, (_, i: string) => links[Number(i)]);
}

/**
 * The house style for a model-composed message in the club's language.
 *
 * English: the dash rule above and nothing else, so dash-free English is
 * byte for byte what the model wrote. Turkish: the dash rule, plus
 * markdown `**bold**` (which WhatsApp shows with its asterisks) turned
 * into `*bold*`, as it has been since 2026-09-17.
 */
export function applyHouseStyle(text: string, lang?: Lang | string | null): string {
  const l = normaliseLang(lang);
  if (l === "en") return stripLongDashes(text, l);
  return stripLongDashes(
    // Markdown bold is not WhatsApp bold: `**x**` shows its asterisks.
    text.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*"),
    l,
  )
    .replace(/,\s*,/g, ",")
    .replace(/\s+,/g, ",");
}
