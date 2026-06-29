/**
 * Recurring-SLOT identity for matches, and the dedupe predicate the weekly
 * match generator uses.
 *
 * A "slot" is the recurring fixture an Activity represents, keyed on
 * (orgId, venue, dayOfWeek) PLUS the match INSTANT (the real UTC timestamp
 * the match kicks off). Two matches share ONE slot when org/venue/weekday
 * are equal AND their instants are within {@link SLOT_TIME_TOLERANCE_MS} of
 * each other.
 *
 * Why this exists: `switchMatchFormat` re-points a Match's `activityId` to
 * the new-format Activity but leaves the old Activity `isActive: true`.
 * The generator must therefore dedupe on the slot, not on `activityId` —
 * otherwise it regenerates an empty "ghost" match for the old format's
 * still-active Activity.
 *
 * Why proximity, not exact time: the two formats of the SAME recurring
 * fixture can have DIFFERENT configured kickoff times (Sutton FC prod:
 * `tuesday-7aside` = "21:30", `tuesday-5aside` = "21:15"). The first fix
 * keyed the slot on exact activity-`time` equality and so treated the two
 * formats as different slots — the ghost came back. `switchMatchFormat`
 * keeps the original Match.date, so the real match INSTANT is the reliable
 * key; we compare it (immune to activity-`time` config drift) against the
 * generator's computed `matchDate` with a tolerance. ±90 min absorbs a
 * format-driven time tweak (and the historical ±1h BST mis-stamp) while
 * still separating genuinely distinct same-day sessions ≥ ~2h apart.
 *
 * Pure functions so the generator can load candidate matches in the
 * window and delegate the decision here (and so it's unit-testable).
 */

/** ±90 minutes: format time tweaks count as the same slot; ≥~2h apart does not. */
export const SLOT_TIME_TOLERANCE_MS = 90 * 60 * 1000;

export interface MatchSlot {
  orgId: string;
  venue: string;
  dayOfWeek: number; // 0=Sun..6=Sat
  instant: Date; // the match's real UTC kickoff timestamp (Match.date / computed matchDate)
}

/**
 * Two slots are the same recurring fixture when org, venue and weekday match
 * AND their instants are within `toleranceMs` of each other.
 */
export function isSameSlot(
  a: MatchSlot,
  b: MatchSlot,
  toleranceMs: number = SLOT_TIME_TOLERANCE_MS,
): boolean {
  return (
    a.orgId === b.orgId &&
    a.venue === b.venue &&
    a.dayOfWeek === b.dayOfWeek &&
    Math.abs(a.instant.getTime() - b.instant.getTime()) <= toleranceMs
  );
}

/**
 * Does any existing match in the generation window already cover this slot?
 *
 * @param slot           The slot being generated (the activity's slot at its
 *                       computed matchDate).
 * @param existingSlots  Slots of matches already present in the date window
 *                       (each match's instant + its Activity's org/venue/day).
 * @param toleranceMs    Instant-proximity tolerance (defaults to ±90 min).
 */
export function hasMatchForSlot(
  slot: MatchSlot,
  existingSlots: MatchSlot[],
  toleranceMs: number = SLOT_TIME_TOLERANCE_MS,
): boolean {
  return existingSlots.some((s) => isSameSlot(slot, s, toleranceMs));
}
