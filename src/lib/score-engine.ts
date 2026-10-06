/**
 * §10 STEP 7 PART 2 — THE SCORE APPLY LAYER.
 *
 *   router → score extractor → engine → APPLY → composer
 *
 * `src/lib/pipeline/` decides and composes and is forbidden from
 * writing — `pipeline/__tests__/zero-writes.test.ts` scans every file in
 * that directory on every build. This module is the other side of that
 * line, and it lives OUTSIDE `pipeline/` for exactly that reason, in the
 * same place and for the same reason `attendance-engine.ts` does.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT IT WRITES, AND WHY IT IS TWO WRITES AND NOT ONE
 * ─────────────────────────────────────────────────────────────────────
 * The shipped path (`route.ts:3508-3533`) does two things, in order,
 * with the second wrapped in its own `try`:
 *
 *   1. `Match.redScore` / `yellowScore` / `status = COMPLETED`.
 *   2. the Elo deltas across every `TeamAssignment` on that match.
 *
 * The nesting is deliberate and is reproduced here rather than tidied
 * into one transaction. A score is a FACT the group reported; the Elo
 * update is a DERIVED consequence of it. If the derivation fails — no
 * team assignments, a rating row that moved — the right outcome is a
 * recorded score and a logged error, not a rolled-back score and a group
 * that thinks MatchTime ignored them. Losing the score is the failure
 * mode `route.ts:3462` calls the worse one, and it is the failure mode
 * a single transaction would introduce.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT DECIDES NOTHING
 * ─────────────────────────────────────────────────────────────────────
 * Which match, which numbers, whether the sender may report a result,
 * whether a recorded score may be overwritten: all of that is
 * `engine.ts`'s `handleScore`, and none of it is re-litigated here.
 * Every branch below is a mechanical translation of a field the engine
 * already set.
 *
 * ── A CHANGED SCORE (2026-10-07) ─────────────────────────────────────
 * The engine may now propose a score for a match that already has one
 * (a correction, with `previous` set). The Elo half is therefore no
 * longer "add this result's points": it is `reconcileElo`, which makes
 * the ratings agree with the match's score, taking the old result's
 * points back first and doing nothing when they already agree
 * (`lib/match-elo.ts`). The arithmetic moved there with it, so this
 * file no longer calls `computeEloDeltas` itself.
 *
 * It imports neither `db` nor Prisma; its dependencies are injected,
 * which is what makes the seam unit-testable without a database, and a
 * test asserts the absence by SCANNING this file, because a comment
 * saying so is worth nothing (four seatbelts were found dead on
 * 2026-08-31, all with comments claiming they worked).
 */
import type { ProposedWrite } from "./pipeline/types";

export type EngineScoreWrite = Extract<ProposedWrite, { kind: "score" }>;

/**
 * Prefix on every degradation this layer reports. Mirrors
 * `ENGINE_APPLY_DEGRADED_PREFIX` for step 6.
 *
 * ⚠️ WHAT THE DM ACTUALLY IS, corrected 2026-09-06. §10 step 8 replaced
 * the analyze route's inline partial-response net with
 * `lib/operator-note.ts`, which selects on the TYPED fact "no owner
 * claimed this id" and never reads prose. So this prefix is no longer
 * what triggers the DM — nothing regex-matches it any more, which is
 * exactly what §9 asked for. It is now (a) the audit trail on the
 * `AnalyzedMessage` row and (b) the marker a human scans for in the
 * log. The line AFTER the message id is what an admin reads on their
 * phone, because `composeOperatorNote` prints it verbatim as the "why"
 * beside the lost message. Write those sentences for that reader.
 *
 * On THIS path the sentence carries more than usual: a lost score is
 * invisible in the group (`route.ts:3457-3462` — "losing the score
 * entirely is a worse failure mode"), so the DM is the only notice
 * anybody gets that a match kept no result.
 */
export const SCORE_APPLY_DEGRADED_PREFIX = "score-engine: degraded —";

/** `AnalyzedMessage.handledBy` for a message this path decided. The
 *  AUDIT field, not the wire field — the same split step 5 made for
 *  `router-gate` and step 6 for `attendance-engine`. */
export const SCORE_HANDLED_BY = "score-engine";

export interface ScoreApplyDeps {
  /** `Match.redScore` / `yellowScore` / `status = COMPLETED`, in one
   *  update. The ONE way a score is written on this path.
   *
   *  `previous` is set on a CORRECTION: the result the engine decided
   *  against. The implementation must refuse (throw) if the match no
   *  longer reads that, so two corrections racing cannot both land. */
  recordScore: (args: {
    matchId: string;
    red: number;
    yellow: number;
    previous?: { red: number; yellow: number };
  }) => Promise<void>;
  /** Make the club's ratings agree with the match's score: take back
   *  what the previous result added, add this one's, exactly once.
   *  `moved` 0 is a legitimate answer: a match whose teams were never
   *  generated has no Elo to compute. `left` is set when the ratings
   *  could NOT be brought into line and were left alone (an older match
   *  whose points were never stored); it is a sentence for a person. */
  reconcileElo: (matchId: string) => Promise<{ moved: number; left?: string }>;
  /**
   * Remember that the bot asked which team won `first`-`second` for
   * this match, so a following "Yellow" can complete it
   * (`pipeline/score-ask.ts`). One open question per match: a new one
   * replaces the old. `recordScore` is expected to clear it.
   * Optional so a caller with nowhere to keep it (a harness) still
   * works; the question is then simply not answerable by one word.
   */
  recordScoreAsk?: (args: {
    matchId: string;
    first: number;
    second: number;
    /** Who posted the scoreline, or null when WhatsApp did not say. */
    askerUserId: string | null;
  }) => Promise<void>;
}

export interface ScoreWriteResult {
  write: EngineScoreWrite;
  /** Did the SCORE land? The Elo pass can fail on its own without
   *  making this false — see the header. */
  ok: boolean;
  error?: string;
  /** How many player ratings moved. 0 when the match had no teams. */
  eloApplied: number;
  /** Set when the score landed and the Elo pass did not. Surfaced, never
   *  swallowed: a silent Elo failure is a leaderboard that quietly stops
   *  moving, which nobody notices for a month. */
  eloError?: string;
}

/**
 * Apply the engine's score writes.
 *
 * Sequential rather than `Promise.all`, and that is not caution: two
 * score writes in one batch would be two messages about the SAME match
 * (a result and its correction, since 2026-10-07; the second carries the
 * first as `previous`), and they have to land in the order they were
 * said. Racing two updates to one row is how the wrong one wins by
 * accident.
 */
export async function applyScoreWrites(args: {
  writes: EngineScoreWrite[];
  deps: ScoreApplyDeps;
}): Promise<ScoreWriteResult[]> {
  const { writes, deps } = args;
  const results: ScoreWriteResult[] = [];

  for (const write of writes) {
    try {
      await deps.recordScore({
        matchId: write.matchId,
        red: write.red,
        yellow: write.yellow,
        ...(write.previous ? { previous: write.previous } : {}),
      });
    } catch (err) {
      // The score itself failed. Nothing derived from it should run, and
      // the caller must not compose "recorded" over a write that threw —
      // that is §3.2 S7's "WORDS MUST MATCH ACTION", the 2026-05-15
      // Erdal incident, in a different corner of the system.
      results.push({
        write,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        eloApplied: 0,
      });
      continue;
    }

    // ── The derived half. Its failure never unmakes the score. ───────
    let eloApplied = 0;
    let eloError: string | undefined;
    try {
      const elo = await deps.reconcileElo(write.matchId);
      eloApplied = elo.moved;
      if (elo.left) eloError = elo.left;
    } catch (err) {
      eloError = err instanceof Error ? err.message : String(err);
      console.error("[score-engine] Elo update after a recorded score failed:", err);
    }

    results.push({ write, ok: true, eloApplied, ...(eloError ? { eloError } : {}) });
  }

  return results;
}
