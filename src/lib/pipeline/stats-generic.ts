/**
 * THE GENERIC STATS ANSWER: one grounded prompt for every stats
 * question no known table answers (2026-09-23).
 *
 * Kemal asked whether the group could answer ANY question drawn from
 * his stats page by giving a model the data. The answer he chose is a
 * hybrid: the known tables are rendered exactly by code
 * (`stats-answer.ts`), and only what is left comes here. Three things
 * keep this path honest, in order of strength:
 *
 *   1. WHAT IT IS GIVEN. `buildGenericStatsContext` writes the same
 *      `StatsSnapshot` the known tables are rendered from, already
 *      visibility-filtered: the top of each list only, never the bottom,
 *      and another player's nemesis never. What the model is not told it
 *      cannot leak. The same pattern as `dm-qa.ts`'s scoped context.
 *   2. WHAT IT MAY SAY. Every name and number in the reply must appear
 *      in that context (`stats-grounding.ts`). The allowed sets are
 *      computed from the context TEXT, so the check and the prompt
 *      cannot drift apart.
 *   3. WHAT HAPPENS WHEN IT FAILS. The caller says the safe line. A
 *      failed check is MatchTime's error and the group is never asked
 *      about it.
 *
 * The model call goes through the pipeline's `PipelineModel`, on the
 * extractor model with thinking off (see `ModelRequest.thinking` for why
 * that matters on Sonnet 5), so tests drive it with a stub and the cost
 * lands in the batch's cost line.
 */
import { EXTRACTOR_MODEL, extractJson, type PipelineModel } from "./llm";
import { ELO_TOP_MIN_MATCHES_SHOWN, GROUP_LIST_CAP, GROUP_RATINGS_MIN_GAMES, TEAM_OF_SEASON_MIN_GAMES } from "./stats-answer";
import { groundingCheck, type GroundingContext } from "./stats-grounding";
import { MR_RELIABLE_MIN_AVG, MR_RELIABLE_MIN_GAMES } from "../mr-reliable";
import type { Lang } from "../i18n/lang";
import type { Member, StatsSnapshot } from "./types";

export const STATS_GENERIC_SYSTEM = `You answer ONE question about a football club's stats, asked in the club's WhatsApp group. You are given TABLES that have already been computed. They are everything you know.

Rules:
- Use only the TABLES. Copy every player name exactly as the TABLES spell it, and every number exactly as the TABLES print it.
- Write every number in digits, never as a word.
- Never calculate a new number: no sums, differences, averages, ratios or percentages that the TABLES do not print.
- Never call anyone the worst, the lowest or the bottom of anything. The TABLES only hold the top of each list.
- If the TABLES do not answer the question, reply with exactly: NO_ANSWER
- At most 4 short lines, WhatsApp style. No greeting. Never write an em dash or an en dash.

Return JSON: {"answer": "<your reply>"}.`;

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
} as const;

const LANGUAGE_TR = [
  "LANGUAGE:",
  "This group speaks TURKISH. Write the whole answer in Turkish, whatever language the question is in.",
  "Speak to the group in the plural, never as \"sen\". No \"abi\", no \"beyler\", no greeting.",
  "Put a name or a number where Turkish needs no suffix on it: after a colon or in brackets. Never glue a suffix onto a number.",
  "Say \"maçın adamı\" (never \"Man of the Match\" or \"MoM\") and \"puan\" (never \"rating\"). A decimal is written with a comma: 7,8.",
].join("\n");

/** One decimal, as the tables print it (the context is in English, so
 *  always "."; the check accepts "," too). */
const d = (x: number) => x.toFixed(1);

/**
 * PURE. The TABLES block, and the grounding sets derived from exactly
 * that text. `personUserId` is the player a question named, resolved by
 * `planStatsQuestion`; `self` means the asker asked about themselves.
 */
export function buildGenericStatsContext(args: {
  snapshot: StatsSnapshot;
  lang: Lang;
  personUserId: string | null;
  self: boolean;
  roster: Member[];
}): { text: string; grounding: GroundingContext } {
  const s = args.snapshot;
  const L: string[] = [];
  const top = s.ratings.slice(0, GROUP_LIST_CAP);
  L.push(`CLUB RATINGS (top ${GROUP_LIST_CAP}, players with ${GROUP_RATINGS_MIN_GAMES}+ rated matches; the average of the ratings team-mates gave them):`);
  for (const r of top) {
    const move = r.delta === null ? "new since the last match" : r.delta > 0 ? `up ${r.delta} since the last match` : r.delta < 0 ? "down since the last match" : "no change since the last match";
    L.push(`${r.rank}. ${r.name}: ${d(r.avg)} from ${r.games} rated matches (${move})`);
  }
  if (s.mom.length) {
    L.push("", `MAN OF THE MATCH WINS (top ${GROUP_LIST_CAP}):`);
    s.mom.slice(0, GROUP_LIST_CAP).forEach((r, i) => L.push(`${i + 1}. ${r.name}: ${r.wins}`));
  }
  if (s.elo.length) {
    L.push("", `ELO (top ${GROUP_LIST_CAP}, ${ELO_TOP_MIN_MATCHES_SHOWN}+ matches played):`);
    s.elo.slice(0, GROUP_LIST_CAP).forEach((r, i) => L.push(`${i + 1}. ${r.name}: ${r.rating} from ${r.matches} matches`));
  }
  if (s.teamOfSeason && s.teamOfSeason.slots.length) {
    L.push("", `TEAM OF THE SEASON (${s.teamOfSeason.sportName}, best average rating per position, ${TEAM_OF_SEASON_MIN_GAMES}+ rated matches):`);
    s.teamOfSeason.slots.forEach((x) =>
      L.push(`- ${x.name}${x.position && x.position !== "ANY" ? ` (${x.position})` : ""}: ${d(x.avg)} from ${x.games} rated matches`),
    );
  }
  if (s.mrReliable.length) {
    L.push("", `MR RELIABLE BADGE HOLDERS (average ${d(MR_RELIABLE_MIN_AVG)}+, little variation, ${MR_RELIABLE_MIN_GAMES}+ rated matches; most consistent first):`);
    s.mrReliable.slice(0, GROUP_LIST_CAP).forEach((r, i) => L.push(`${i + 1}. ${r.name}: ${d(r.avg)} average from ${r.games} rated matches`));
  }

  if (args.personUserId) {
    const member = args.roster.find((m) => m.userId === args.personUserId);
    const name = member?.name ?? s.chemistry[args.personUserId]?.name ?? null;
    if (name) {
      L.push("", `THE PLAYER THE QUESTION IS ABOUT: ${name}`);
      const r = top.find((x) => x.userId === args.personUserId);
      // Top of the table only, for a named player as for a list: a rating
      // outside the top ten is not said in the group (it is on the site).
      L.push(r ? `- club rating: ${d(r.avg)} from ${r.games} rated matches, no. ${r.rank}` : "- club rating: not in the top of the table, so not shared here");
      const mom = s.mom.find((x) => x.userId === args.personUserId);
      if (mom) L.push(`- Man of the Match wins: ${mom.wins}`);
      const c = s.chemistry[args.personUserId];
      if (c?.bestByWinRate) {
        const b = c.bestByWinRate;
        L.push(`- best team-mate by win rate: ${b.name}, ${b.wins} wins in ${b.gamesTogether} matches together (${Math.round(b.winRate * 100)}%)`);
      }
      if (c?.bestByRating) L.push(`- best team-mate by rating: ${c.bestByRating.name}, ${d(c.bestByRating.myAvgWith)} average alongside them`);
      if (c?.nemesis && args.self) {
        L.push(`- nemesis: ${c.nemesis.name}, won ${c.nemesis.wins} of ${c.nemesis.gamesAgainst} against them`);
      }
    }
  }

  const text = L.join("\n");
  const numbers = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const names = args.roster.map((m) => m.name).filter((n) => n.trim() && text.includes(n));
  // A name in the tables that is not on the active roster (a player who
  // has since left) is still a name the tables gave.
  for (const extra of [
    ...s.ratings.map((r) => r.name),
    ...s.mom.map((r) => r.name),
    ...s.elo.map((r) => r.name),
    ...s.mrReliable.map((r) => r.name),
    ...(s.teamOfSeason?.slots.map((x) => x.name) ?? []),
  ]) {
    if (text.includes(extra) && !names.includes(extra)) names.push(extra);
  }
  return { text, grounding: { names, numbers } };
}

/** The result `answer-batch.ts` stores in `StatsSnapshot.generic`. */
export type GenericStatsResult = { text: string } | { rejected: string };

/**
 * One grounded answer. NEVER THROWS: a failed call, an unparseable body
 * and an ungrounded reply are all `rejected`, with the reason, and the
 * composer says the safe line for each.
 */
export async function answerGenericStats(args: {
  model: PipelineModel;
  snapshot: StatsSnapshot;
  lang: Lang;
  question: string;
  personUserId: string | null;
  self: boolean;
  roster: Member[];
}): Promise<{ result: GenericStatsResult; costUsd: number; ms: number; called: boolean }> {
  const ctx = buildGenericStatsContext(args);
  const user = [
    "TABLES (everything you may use; nothing else exists for you):",
    ctx.text,
    "",
    ...(args.lang === "tr" ? [LANGUAGE_TR, ""] : []),
    `QUESTION: ${args.question.trim()}`,
  ].join("\n");
  let text: string;
  let costUsd = 0;
  let ms = 0;
  try {
    const resp = await args.model.complete({
      model: EXTRACTOR_MODEL,
      system: STATS_GENERIC_SYSTEM,
      user,
      maxTokens: 400,
      schema: SCHEMA as unknown as Record<string, unknown>,
      thinking: "off",
      label: "stats-generic",
    });
    costUsd = resp.costUsd ?? 0;
    ms = resp.ms;
    const raw = extractJson(resp.text) as { answer?: unknown };
    text = typeof raw?.answer === "string" ? raw.answer : "";
  } catch (err) {
    return { result: { rejected: `the generic call failed (${(err as Error).message})` }, costUsd, ms, called: true };
  }
  // House style, applied rather than hoped for: no dashes as punctuation.
  const tidy = text.replace(/\s*[—–]\s*/g, ", ").trim();
  const check = groundingCheck({ reply: tidy, question: args.question, grounding: ctx.grounding, roster: args.roster });
  return {
    result: check.ok ? { text: tidy } : { rejected: `grounding check failed: ${check.why}` },
    costUsd,
    ms,
    called: true,
  };
}
