/**
 * Recurring-SLOT identity for matches, and the dedupe predicate the weekly
 * match generator uses.
 *
 * A "slot" is the recurring fixture an Activity represents:
 * (orgId, venue, dayOfWeek, time). Two activities for the same org that
 * differ only in format (e.g. Tuesday 7-a-side vs Tuesday 5-a-side at the
 * same venue/time) share ONE slot.
 *
 * Why this exists: `switchMatchFormat` re-points a Match's `activityId` to
 * the new-format Activity but leaves the old Activity `isActive: true`.
 * The generator must therefore dedupe on the slot, not on `activityId` —
 * otherwise it regenerates an empty "ghost" match for the old format's
 * still-active Activity. Requiring equality on `time` (and `dayOfWeek`)
 * preserves genuinely different games at the same venue/day at different
 * times: those are different slots and still generate.
 *
 * Pure functions so the generator can load candidate matches in the
 * window and delegate the decision here (and so it's unit-testable).
 */

export interface ActivitySlot {
  orgId: string;
  venue: string;
  dayOfWeek: number; // 0=Sun..6=Sat
  time: string; // London wall clock, e.g. "20:30"
}

/** Two slots are identical when org, venue, weekday AND time all match. */
export function isSameSlot(a: ActivitySlot, b: ActivitySlot): boolean {
  return (
    a.orgId === b.orgId &&
    a.venue === b.venue &&
    a.dayOfWeek === b.dayOfWeek &&
    a.time === b.time
  );
}

/**
 * Does any existing match in the generation window already cover this slot?
 *
 * @param slot           The slot being generated (the activity's slot).
 * @param existingSlots  Slots of matches already present in the date window
 *                       (read from each match's Activity).
 */
export function hasMatchForSlot(
  slot: ActivitySlot,
  existingSlots: ActivitySlot[],
): boolean {
  return existingSlots.some((s) => isSameSlot(slot, s));
}
