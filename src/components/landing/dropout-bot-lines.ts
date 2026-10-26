/**
 * MatchTime's own messages in the home page's dropout chat, built from the
 * REAL strings the bot posts (strings.en.ts `bench_offer_group_post` and
 * `bench_claim_replacing`, with the fixture context the scheduler uses
 * before teams are made), so the page cannot drift from the product.
 *
 * The page draws them without the bot's emoji. WhatsApp's *bold* is kept
 * as marked text and turned into <strong> by the section.
 *
 * Server only: the client menu imports landing-content.ts, so the string
 * table is read here, not there.
 */
import { en } from "@/lib/i18n/strings.en";
import { DROPOUT_STORY } from "./landing-content";

/** Drop emoji (and the variation selectors that follow them), then tidy
 *  the spaces they leave behind, line by line. */
export function withoutEmoji(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍]/gu, "")
    .split("\n")
    .map((l) => l.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .trim();
}

export function dropoutBotLines(story = DROPOUT_STORY.chat): Record<"bench-offer" | "bench-claim", string> {
  const context = en.bench_offer_context_fixture({ activityName: story.activityName, day: null });
  return {
    "bench-offer": withoutEmoji(
      en.bench_offer_group_post({ context, tagList: story.bench.map((n) => `@${n}`).join(" "), reactions: false }),
    ),
    "bench-claim": withoutEmoji(
      en.bench_claim_replacing({ claimer: story.claimer, dropped: story.dropped, confirmed: story.squad, maxPlayers: story.squad }),
    ),
  };
}

/** "*IN* here" into [{ text: "IN", bold: true }, { text: " here" }]. */
export function boldSegments(line: string): Array<{ text: string; bold: boolean }> {
  return line
    .split(/(\*[^*]+\*)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("*") && part.endsWith("*") && part.length > 2 ? { text: part.slice(1, -1), bold: true } : { text: part, bold: false }));
}
