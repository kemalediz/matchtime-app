/**
 * THE SCORE BATCH'S USE OF THE CLUB'S NAMES FOR ITS SIDES (2026-11-17).
 *
 * `score-engine-batch.ts` calls these four steps around the engine, which
 * itself is unchanged (`pipeline/score-sides.ts` has the why):
 *
 *   1. `gameLinesFor`: THE GAME block the score extractor reads;
 *   2. `normaliseOwnedFacts`: a team reference THIS game's own names or a
 *      player's line-up place becomes MatchTime's own name for that side,
 *      and an answer to "Which team was bibs?" gets the winner it means;
 *   3. `nameTheQuestions`: a "which team won?" the engine asks about a
 *      scoreline whose winning side's name means no side yet asks about
 *      that name instead, with an earlier game's side as a hint, and is
 *      remembered with it;
 *   4. `rememberSideNames`: the recorded result teaches this game's names
 *      (never a player's team), named in the reply; a corrected result
 *      rewrites or deletes them (review of #620).
 *
 * No database here: the reads come with the state (`load-state.ts`), the
 * one write goes through the apply deps (`recordSideNames`).
 */
import {
  gameContextLines,
  hintSide,
  learnedSideNames,
  mergeSideNames,
  normaliseScoreFacts,
  sideNamesAfterCorrection,
  sideQuestion,
  type AskedNames,
  type Lineups,
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

/** The played match's line-ups by display name, exactly as THE GAME shows
 *  them, so a player the extractor names is checked against the same list. */
export function lineupsFor(state: SquadState): Lineups {
  const played = state.completedMatch;
  const nameOf = (userId: string) => {
    const m = state.roster.find((r) => r.userId === userId);
    return m?.name || state.rowNames?.[userId] || null;
  };
  const playersOn = (team: "RED" | "YELLOW") =>
    (played?.teams ?? [])
      .filter((t) => t.team === team)
      .map((t) => nameOf(t.userId))
      .filter((n): n is string => !!n);
  return { red: playersOn("RED"), yellow: playersOn("YELLOW") };
}

function ctxFor(state: SquadState, played: Played, userId: string | null): SideContext {
  return {
    labels: labelsOf(state),
    // THIS match's own names only (review of #620).
    names: played.sideNames ?? null,
    senderTeam: senderTeam(played, userId),
    lineups: lineupsFor(state),
  };
}

/** THE GAME for the score extractor, or undefined with no played match.
 *  Its names are this game's own only. */
export function gameLinesFor(state: SquadState): string[] | undefined {
  const played = state.completedMatch;
  if (!played) return undefined;
  return gameContextLines({
    when: played.kickoffLabel,
    labels: labelsOf(state),
    names: played.sideNames ?? null,
    players: lineupsFor(state),
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
  const asked = pending?.name
    ? { name: pending.name, ...(pending.other ? { other: pending.other } : {}), ...(pending.noStore ? { noStore: pending.noStore } : {}) }
    : null;
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
 * the reply asks "Which team was bibs?", and, when an earlier game placed
 * that name, the side it was then as a hint ("Last time it was Red"); the
 * returned map is what the question is remembered with.
 */
export function nameTheQuestions(args: {
  state: SquadState;
  factsById: Map<string, Facts>;
  askWrites: Array<{ sourceMessageId: string; askerUserId: string | null }>;
  result: EngineResult;
}): Map<string, AskedNames> {
  const out = new Map<string, AskedNames>();
  const played = args.state.completedMatch;
  if (!played) return out;
  for (const a of args.askWrites) {
    const f = args.factsById.get(a.sourceMessageId);
    if (!f || f.kind !== "score") continue;
    const q = sideQuestion(f, ctxFor(args.state, played, a.askerUserId));
    if (!q) continue;
    out.set(a.sourceMessageId, q);
    // A player's team is never hinted: its side is whoever the player was
    // with this time.
    const hint = q.noStore?.includes(q.name) ? null : hintSide(q.name, played.earlierSideNames ?? null);
    for (const sp of args.result.speech) {
      if (sp.kind === "score_ask_team" && sp.messageId === a.sourceMessageId) {
        sp.name = q.name;
        if (hint) sp.hint = hint;
      }
    }
  }
  return out;
}

/**
 * Step 4. THIS game's names after its result landed:
 *
 *   - a result for the scoreline MatchTime asked a name about teaches that
 *     name (and the other side's), never a player's team, merged into this
 *     game's own names, stored against this match and put on the next
 *     state so the acknowledgement names them;
 *   - a CORRECTED result (review of #620) rewrites them the other way round
 *     or deletes them (`sideNamesAfterCorrection`).
 *
 * A failed write is reported and changes nothing else: the score is
 * already recorded.
 */
export async function rememberSideNames(args: {
  state: SquadState;
  applied: ScoreWriteResult[];
  result: EngineResult;
  deps: ScoreApplyDeps;
  degradations: string[];
  prefix: string;
}): Promise<void> {
  const played = args.state.completedMatch;
  if (!played) return;
  const pending = played.pendingScore;
  const setNext = (names: { red: string[]; yellow: string[] } | undefined) => {
    const next = args.result.nextState.completedMatch;
    if (next?.id !== played.id) return;
    const { sideNames: _old, ...rest } = next;
    void _old;
    args.result.nextState.completedMatch = names ? { ...rest, sideNames: names } : rest;
  };
  const fail = (a: ScoreWriteResult, what: string, err: unknown) =>
    args.degradations.push(
      `${args.prefix} ${a.write.sourceMessageId}: ${what} (${err instanceof Error ? err.message : String(err)})`,
    );
  for (const a of args.applied) {
    if (!a.ok || a.write.matchId !== played.id) continue;
    if (a.write.previous) {
      const after = sideNamesAfterCorrection(played.sideNames ?? null, a.write.previous, a.write);
      if (after.kind === "rewrite") {
        setNext(after.names);
        try {
          await args.deps.recordSideNames?.({ matchId: played.id, names: after.names });
        } catch (err) {
          fail(a, "the game's names could not be swapped after the correction", err);
        }
      } else if (after.kind === "delete") {
        setNext(undefined);
        try {
          await args.deps.clearSideNames?.(played.id);
        } catch (err) {
          fail(a, "the game's names could not be deleted after the correction", err);
        }
      }
      return;
    }
    if (!pending?.name) return;
    const learned = learnedSideNames(pending, a.write);
    if (!learned) return;
    const names = mergeSideNames(played.sideNames ?? null, learned);
    setNext(names);
    try {
      await args.deps.recordSideNames?.({ matchId: played.id, names });
    } catch (err) {
      fail(a, `the game's names (${JSON.stringify(names)}) could not be remembered; the next report asks again`, err);
    }
    return;
  }
}
