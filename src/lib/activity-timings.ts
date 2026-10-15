/**
 * THE WEEKLY GAME'S MATCH LENGTH AND SIGN-UP CUT-OFF, on the edit form of
 * /admin/activities (2026-10-15). Pure and client-safe.
 *
 * Both fields were only on the create form, so an organiser could not
 * change an existing game's length (FNF plays 20:30 to 22:00 and was
 * stuck on 60 minutes).
 *
 * A field is SENT only when the organiser changed it, the same rule as
 * the fee: a value stored outside today's bounds (Sutton's cut-off of 0
 * hours, from before the 1 hour minimum) then never blocks, or gets
 * rewritten by, an edit of the venue. A changed value is checked against
 * the same bounds as creating a game (`activitySchema`, validations.ts)
 * and the server's own edit check (`activityUpdateData`), which still has
 * the last word.
 *
 * What each one decides, traced:
 *   - matchDurationMins: when a game counts as finished (kick-off plus
 *     this). Read at run time from the activity, so a change applies to
 *     every game of it, already created or not.
 *   - deadlineHours: copied into `Match.attendanceDeadline` when a match
 *     is created (cron generate-matches, Generate match, block bookings,
 *     monthly squads, format switch). A change applies to matches created
 *     afterwards only.
 */

export const MATCH_DURATION_MIN = 20;
export const MATCH_DURATION_MAX = 180;
export const DEADLINE_HOURS_MIN = 1;
export const DEADLINE_HOURS_MAX = 48;

export interface ActivityTimings {
  matchDurationMins: number;
  deadlineHours: number;
}

export type ActivityTimingsPatch =
  | { ok: true; patch: Partial<ActivityTimings> }
  | { ok: false; field: keyof ActivityTimings };

/** A whole number as typed ("90", " 90 "), or null for anything else. */
function wholeNumber(raw: string): number | null {
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

const BOUNDS: Array<[keyof ActivityTimings, number, number]> = [
  ["matchDurationMins", MATCH_DURATION_MIN, MATCH_DURATION_MAX],
  ["deadlineHours", DEADLINE_HOURS_MIN, DEADLINE_HOURS_MAX],
];

/** From the two boxes as typed and the stored values: what to send, or which box is wrong. */
export function activityTimingsPatch(
  typed: { matchDurationMins: string; deadlineHours: string },
  stored: ActivityTimings,
): ActivityTimingsPatch {
  const patch: Partial<ActivityTimings> = {};
  for (const [field, min, max] of BOUNDS) {
    const n = wholeNumber(typed[field]);
    if (n !== null && n === stored[field]) continue;
    if (n === null || n < min || n > max) return { ok: false, field };
    patch[field] = n;
  }
  return { ok: true, patch };
}
