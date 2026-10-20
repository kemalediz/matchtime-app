/**
 * IS THIS MATCH AT RISK OF BEING CALLED OFF? — pure, no DB, no LLM.
 *
 * Kemal, 2026-09-06: "if the match is close and there are many missing
 * players, the 5pm update should be more encouraging for people to
 * attend and kind of a warning that match will be cancelled if we can't
 * find enough players."
 *
 * WHY THIS IS ARITHMETIC AND NOT A PROMPT
 * ---------------------------------------
 * "Close" and "many missing" are exactly the kind of judgement call that
 * this repo has spent a week taking away from the model. Left to the
 * prompt, the same squad state produces a cancellation warning on one
 * run and not on the next — and a warning that appears in three runs out
 * of six is worse than one that never appears at all, because nobody in
 * the group can tell what it means. Worse in the other direction: a
 * spurious "we might have to call this off" on a healthy fixture is
 * alarming in a real customer's WhatsApp group.
 *
 * Same shape as `format-switch.ts`, and for the same reason (the
 * 2026-08-30 incident, where the model did the subtraction itself and
 * named three real people as benched who weren't): the server computes
 * the answer, the prompt is handed the answer, and the prompt is told in
 * as many words never to do the counting itself.
 *
 * THE THRESHOLDS (approved by Kemal, 2026-09-06)
 * ----------------------------------------------
 *   atRisk = hoursToKickoff <= 48 && need >= 4
 *
 * `need` is the shortfall to `Match.maxPlayers` — the TOTAL across both
 * teams, the "places open" the chase's facts state (chase-lead.ts).
 * Never players-per-team. (`format-switch.ts` has the full note on why
 * that distinction has bitten us in production.)
 *
 * Applies to the 17:00 `daily-in-list` chase only. The pre-kickoff kinds
 * already carry their own urgency; doubling it up would read as panic.
 */

/** Kickoff is this close, in hours, before "at risk" is even possible. */
export const AT_RISK_HOURS_TO_KICKOFF = 48;

/** This many players short, at least, before "at risk" is possible. */
export const AT_RISK_MIN_NEEDED = 4;

export interface ChaseRiskInput {
  /** Kickoff instant. */
  kickoff: Date;
  /** How many are CONFIRMED right now. */
  confirmedCount: number;
  /** `Match.maxPlayers` — the total across BOTH teams. */
  maxPlayers: number;
  /** Defaults to the wall clock. Injectable so tests need no fake timers. */
  now?: Date;
}

export interface ChaseRisk {
  /** Hours until kickoff. Negative once kickoff has passed. */
  hoursToKickoff: number;
  /** Shortfall to a full squad. Never negative. */
  need: number;
  /** The whole point: the server's verdict, handed to the prompt as-is. */
  atRisk: boolean;
}

export function computeChaseRisk(args: ChaseRiskInput): ChaseRisk {
  const now = args.now ?? new Date();
  const hoursToKickoff = (args.kickoff.getTime() - now.getTime()) / 3_600_000;
  // Defensive: a bad capacity must under-report the shortfall (and so
  // stay quiet), never over-report it into a false alarm.
  const maxPlayers = Number.isFinite(args.maxPlayers) ? Math.max(0, args.maxPlayers) : 0;
  const confirmed = Number.isFinite(args.confirmedCount) ? Math.max(0, args.confirmedCount) : 0;
  const need = Math.max(0, maxPlayers - confirmed);
  const atRisk =
    Number.isFinite(hoursToKickoff) &&
    hoursToKickoff <= AT_RISK_HOURS_TO_KICKOFF &&
    need >= AT_RISK_MIN_NEEDED;
  return { hoursToKickoff, need, atRisk };
}
