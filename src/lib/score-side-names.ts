/**
 * THE SCORE BATCH'S USE OF THE CLUB'S NAMES FOR ITS SIDES (2026-11-17).
 *
 * `score-engine-batch.ts` calls these four steps around the engine, which
 * itself is unchanged (`pipeline/score-sides.ts` has the why):
 *
 *   1. `gameLinesFor`: THE GAME block the score extractor reads;
 *   2. `normaliseOwnedFacts`: a team reference the club's names or THE
 *      GAME place becomes MatchTime's own name for that side, and an
 *      answer to "Which team was bibs?" gets the winner it means;
 *   3. `nameTheQuestions`: a "which team won?" the engine asks about a
 *      scoreline whose winning side's name means no side yet asks about
 *      that name instead, and is remembered with it;
 *   4. `learnFromResults`: the recorded result teaches the names asked
 *      about, which are stored for the club and named in the reply.
 *
 * No database here: the reads come with the state (`load-state.ts`), the
 * one write goes through the apply deps (`recordSideNames`).
 */
import {
  gameContextLines,
  learnedSideNames,
  mergeSideNames,
  normaliseScoreFacts,
  sideQuestion,
  type SideContext,
} from "./pipeline/score-sides";
import type { EngineResult, Facts, SquadState } from "./pipeline/types";
import type { ScoreApplyDeps, ScoreWriteResult } from "./score-engine";

type Played = NonNullable<SquadState["completedMatch"]>;

function labelsOf(state: SquadState): readonly [string, string] {
  return state.completedMatch?.teamLabels ?? state.teamLabels;
}

function senderTeam(played: Played, userId: string | null): "RED" | "YELLOW" | null {
  if (!userId) return null;
  return played.teams?.find((t) => t.userId === userId)?.team ?? null;
}

function ctxFor(state: SquadState, played: Played, userId: string | null): SideContext {
  return { labels: labelsOf(state), names: played.sideNames ?? null, senderTeam: senderTeam(played, userId) };
}

/** THE GAME for the score extractor, or undefined with no played match. */
export function gameLinesFor(state: SquadState): string[] | undefined {
  const played = state.completedMatch;
  if (!played) return undefined;
  const nameOf = (userId: string) => {
    const m = state.roster.find((r) => r.userId === userId);
    return m?.name || state.rowNames?.[userId] || null;
  };
  const playersOn = (team: "RED" | "YELLOW") =>
    (played.teams ?? [])
      .filter((t) => t.team === team)
      .map((t) => nameOf(t.userId))
      .filter((n): n is string => !!n);
  return gameContextLines({
    when: played.kickoffLabel,
    labels: labelsOf(state),
    names: played.sideNames ?? null,
    players: { red: playersOn("RED"), yellow: playersOn("YELLOW") },
    awaiting: played.redScore === null || played.yellowScore === null,
  });
}

/**
 * Rewrites the owned messages' score facts in place (step 2). Returns, per
 * message, what was placed and why, for its `reasoning`.
 */
export function normaliseOwnedFacts(args: {
  state: SquadState;
  factsById: Map<string, Facts>;
  ids: string[];
  senderOf: (id: string) => string | null;
}): Map<string, string[]> {
  const notes = new Map<string, string[]>();
  const played = args.state.completedMatch;
  if (!played) return notes;
  const pending = played.pendingScore;
  const asked = pending?.name ? { name: pending.name, ...(pending.other ? { other: pending.other } : {}) } : null;
  for (const id of args.ids) {
    const f = args.factsById.get(id);
    if (!f || f.kind !== "score") continue;
    const { facts, mapped } = normaliseScoreFacts(f, { ...ctxFor(args.state, played, args.senderOf(id)), asked });
    args.factsById.set(id, facts);
    if (mapped.length > 0) notes.set(id, mapped);
  }
  return notes;
}

/**
 * Step 3. For each "which team won?" the engine is asking, the name to
 * ask about instead, when the scoreline's winning side has a name that
 * means no side yet. The engine's speech for it is given the name, so
 * the reply asks "Which team was bibs?"; the returned map is what the
 * question is remembered with.
 */
export function nameTheQuestions(args: {
  state: SquadState;
  factsById: Map<string, Facts>;
  askWrites: Array<{ sourceMessageId: string; askerUserId: string | null }>;
  result: EngineResult;
}): Map<string, { name: string; other?: string }> {
  const out = new Map<string, { name: string; other?: string }>();
  const played = args.state.completedMatch;
  if (!played) return out;
  for (const a of args.askWrites) {
    const f = args.factsById.get(a.sourceMessageId);
    if (!f || f.kind !== "score") continue;
    const q = sideQuestion(f, ctxFor(args.state, played, a.askerUserId));
    if (!q) continue;
    out.set(a.sourceMessageId, q);
    for (const sp of args.result.speech) {
      if (sp.kind === "score_ask_team" && sp.messageId === a.sourceMessageId) sp.name = q.name;
    }
  }
  return out;
}

/**
 * Step 4. A result that landed for the scoreline MatchTime asked a name
 * about teaches that name (and the other side's), merged into the names
 * the club already uses, stored against this match, and put on the next
 * state so the acknowledgement names them. A failed write is reported and
 * changes nothing else: the score is already recorded.
 */
export async function learnFromResults(args: {
  state: SquadState;
  applied: ScoreWriteResult[];
  result: EngineResult;
  deps: ScoreApplyDeps;
  degradations: string[];
  prefix: string;
}): Promise<void> {
  const played = args.state.completedMatch;
  const pending = played?.pendingScore;
  if (!played || !pending?.name) return;
  for (const a of args.applied) {
    if (!a.ok || a.write.matchId !== played.id) continue;
    const learned = learnedSideNames(pending, a.write);
    if (!learned) continue;
    const names = mergeSideNames(played.sideNames ?? null, learned);
    if (args.result.nextState.completedMatch?.id === played.id) {
      args.result.nextState.completedMatch = { ...args.result.nextState.completedMatch, sideNames: names };
    }
    if (!args.deps.recordSideNames) continue;
    try {
      await args.deps.recordSideNames({ matchId: played.id, names });
    } catch (err) {
      args.degradations.push(
        `${args.prefix} ${a.write.sourceMessageId}: the club's names for its sides (${JSON.stringify(names)}) ` +
          `could not be remembered (${err instanceof Error ? err.message : String(err)}); the next game asks again`,
      );
    }
    return;
  }
}
