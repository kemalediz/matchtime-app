/**
 * Writes the unified answer's prompt to MDs/ as an OLD vs NEW review file
 * (no model call, $0), with each size.
 *
 * 2026-11-18 (the cleanup PR): the unified answer's system prompt was
 * rewritten whole. The OLD side is the prompt live on main before it, saved
 * in MDs/prompt-unified-answer-2026-11-17.txt; the NEW side is the prompt in
 * the code now. The question extractor's prompt did not change (it became
 * the only one, `EXTRACTOR_PROMPTS.question`).
 *
 *   ./node_modules/.bin/tsx scripts/dump-unified-prompts.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { UNIFIED_ANSWER_SYSTEM } from "../src/lib/pipeline/unified-answer.ts";

const tokens = (s: string) => Math.round(s.length / 2.6);

const files: Array<{ out: string; old: string; title: string; now: string; meaning: string[] }> = [
  {
    out: "MDs/prompt-unified-answer-2026-11-18.txt",
    old: "MDs/prompt-unified-answer-2026-11-17.txt",
    title: "THE UNIFIED ANSWER, system prompt (src/lib/pipeline/unified-answer.ts, UNIFIED_ANSWER_SYSTEM)",
    now: UNIFIED_ANSWER_SYSTEM,
    meaning: [
      "What you are given names two new parts of the turn, each said once: ALREADY DONE (other parts of MatchTime acted on THE MESSAGE itself, and what they said) and NOT DONE with its Why and whether the asker is an organiser. The records now open with how many players are registered with the club.",
      "What THE MESSAGE asks defines two words once: the bench is the players waiting for a place, whatever the message calls it; the members are everyone registered with the club, whether or not they play this week, while the squad, the bench and the teams are this week's. A correction is now said to be a new question: a message that corrects MatchTime, or corrects or narrows what was asked before it, is answered for what it names now, from the records, never the earlier question again.",
      "The reply's 'changes nothing' rule now says, in the same place: what ALREADY DONE says is done, so answer only what is left and never say it was not done or cannot be done; with NOT DONE, say what went wrong from its Why before what can be done instead, and never tell an organiser to ask an organiser.",
      "Examples: the bench example asks about 'the reserves'; a new correction example, 'I meant the registered players, not the teams', answered with the registered count; two new request examples, 'switch the match to 7 a side and tell us the list' with ALREADY DONE, and 'swap Sam with Alex' with NOT DONE and its Why. Every other example is kept.",
      "Unchanged: where the facts come from, the reply's other rules, the Turkish rules.",
    ],
  },
];

for (const f of files) {
  const old = readFileSync(f.old, "utf8").trimEnd();
  const body = [
    f.title,
    "",
    `OLD (live on main, ${f.old}): ${old.length} characters, about ${tokens(old)} tokens at 2.6 a token`,
    `NEW (2026-11-18): ${f.now.length} characters, about ${tokens(f.now)} tokens at 2.6 a token`,
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
