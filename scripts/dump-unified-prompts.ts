/**
 * Writes the UNIFIED_ANSWERS prompts to MDs/ as OLD vs NEW review files (no
 * model call, $0): the unified answer's system prompt and the question
 * extractor's prompt with the flag on. Prints each size.
 *
 * Round 3 (2026-11-12): both were rewritten whole again. The OLD side is the
 * round 2 text saved in MDs/prompt-*-2026-11-11.txt; the NEW side is the
 * prompt in the code now. Each file says what changed in meaning, then the
 * two texts one after the other.
 *
 *   ./node_modules/.bin/tsx scripts/dump-unified-prompts.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { UNIFIED_QUESTION_PROMPT } from "../src/lib/pipeline/unified-question.ts";
import { UNIFIED_ANSWER_SYSTEM } from "../src/lib/pipeline/unified-answer.ts";

const tokens = (s: string) => Math.round(s.length / 2.6);

const files: Array<{ out: string; old: string; title: string; now: string; meaning: string[] }> = [
  {
    out: "MDs/prompt-unified-answer-2026-11-12.txt",
    old: "MDs/prompt-unified-answer-2026-11-11.txt",
    title: "THE UNIFIED ANSWER, system prompt (src/lib/pipeline/unified-answer.ts, UNIFIED_ANSWER_SYSTEM)",
    now: UNIFIED_ANSWER_SYSTEM,
    meaning: [
      "A new part, \"What THE MESSAGE asks\", says how to read the message before answering: \"the list\" is the squad list (moved here from its own line); a correction is answered for what it now names, never the earlier question again; a message with no subject of its own follows on from the chat just before it, most often MatchTime's own latest reply, while a tag with nothing after it is answered by asking what they would like to know; \"what happens if\" at the club is answered from how the club is run, this club's own rules first, even when the question takes something else for granted.",
      "\"Where the facts come from\" is now its own part, and adds two things: each stats table says its span, and the whole record starts at the first game MatchTime recorded, so a longer span (the last year, all time) is answered from the whole record, saying once where it starts; and when the records hold only part of what is asked (the top 10 when 50 are asked for), that part is given with where the rest is.",
      "What you are given: the members are \"the players registered with the club\", how the club is run includes what MatchTime does while places are open, and the stats tables are each headed with their span. The chat includes MatchTime's own messages.",
      "The reply rules are unchanged.",
      "Examples: a new group \"Corrections and follow-ups\" (\"no, I meant the bench, not the squad\"; \"why?\" after MatchTime said there is no ratings table), and new examples for \"what happens if someone drops out on the day?\", \"what happens if not enough confirm?\" at a club with a monthly squad, \"who has played most in the last year?\" and \"top 20 ratings\" in the players' group. Every round 2 example is kept.",
    ],
  },
  {
    out: "MDs/prompt-question-unified-2026-11-12.txt",
    old: "MDs/prompt-question-unified-2026-11-11.txt",
    title: "THE QUESTION EXTRACTOR with UNIFIED_ANSWERS on (src/lib/pipeline/unified-question.ts, UNIFIED_QUESTION_PROMPT)",
    now: UNIFIED_QUESTION_PROMPT,
    meaning: [
      "The opening says what the four kinds are for: the first three are fixed posts sent as they are (the list, a help text, the asker's stats link); everything else is answered from the club's own records, including how this club is run.",
      "help is now how to USE MatchTime (what to type, how to bring a friend, how to pay, a setting, a badge), and never a question about what happens or will happen at this club (the squad not filling, a place opening, someone dropping out, a game in doubt). FNF HQ \"what happens if 14 don't confirm?\" was read as help and got the squad help text.",
      "other now names \"what happens at this club if something does or does not happen\" and \"a follow-up or a correction to MatchTime's last reply\".",
      "One example added under Everything else: \"what happens if we don't fill the squad?\" | \"kadro dolmazsa ne olur?\" -> other.",
    ],
  },
];

for (const f of files) {
  const old = readFileSync(f.old, "utf8").trimEnd();
  const body = [
    f.title,
    "",
    `OLD (round 2, ${f.old}): ${old.length} characters, about ${tokens(old)} tokens at 2.6 a token`,
    `NEW (round 3, 2026-11-12): ${f.now.length} characters, about ${tokens(f.now)} tokens at 2.6 a token`,
    "Both are well above Haiku 5.5's 512-token cache floor.",
    "",
    "WHAT CHANGED IN MEANING",
    ...f.meaning.map((m) => `- ${m}`),
    "",
    "════════════════════════════════ OLD ════════════════════════════════",
    "",
    old,
    "",
    "════════════════════════════════ NEW ════════════════════════════════",
    "",
    f.now,
    "",
  ].join("\n");
  writeFileSync(f.out, body);
  console.log(`${f.out}: OLD ${old.length} -> NEW ${f.now.length} characters (about ${tokens(old)} -> ${tokens(f.now)} tokens)`);
}
