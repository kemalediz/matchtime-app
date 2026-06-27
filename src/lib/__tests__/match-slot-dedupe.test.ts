/**
 * Unit tests for the SLOT-BASED dedupe used by the weekly match generator
 * (`/api/cron/generate-matches`).
 *
 * Bug (2026-06-27, Sutton FC): an admin switched the Tuesday match from
 * 7-a-side → 5-a-side. `switchMatchFormat` only re-points the Match's
 * `activityId` to the 5-a-side Activity; it does NOT deactivate the old
 * 7-a-side Activity, which stays `isActive: true`. The generator deduped
 * by `activityId` ONLY, so when it ran for the still-active 7-a-side
 * Activity it found no match (the Tuesday match now belongs to the
 * 5-a-side Activity) and CREATED A BRAND-NEW EMPTY 7-a-side ghost match
 * for the same Tuesday slot. The 17:00 reminder then chased "need 14 more"
 * for the ghost.
 *
 * Fix: dedupe on the recurring SLOT — (orgId, venue, dayOfWeek, time) — not
 * on activityId. A match already existing for the slot (even under a
 * different Activity after a format switch) suppresses generation.
 * Requiring equality on `time` (and dayOfWeek) keeps the ability to have
 * genuinely different games at the same venue on the same day at different
 * times — only a TRUE same-slot match gets deduped.
 *
 * Pure logic — no DB. The route loads candidate matches in the window and
 * delegates the decision here so the same predicate is unit-testable.
 */
import { describe, it, expect } from "vitest";
import { hasMatchForSlot, isSameSlot, type ActivitySlot } from "@/lib/match-slot";

const slot = (over: Partial<ActivitySlot> = {}): ActivitySlot => ({
  orgId: "sutton-fc",
  venue: "Goals North Cheam",
  dayOfWeek: 2, // Tuesday
  time: "20:30",
  ...over,
});

describe("isSameSlot", () => {
  it("is true when org/venue/day/time all match (different activity is irrelevant)", () => {
    expect(isSameSlot(slot(), slot())).toBe(true);
  });

  it("is false when the time differs", () => {
    expect(isSameSlot(slot({ time: "20:30" }), slot({ time: "19:00" }))).toBe(false);
  });

  it("is false when the dayOfWeek differs", () => {
    expect(isSameSlot(slot({ dayOfWeek: 2 }), slot({ dayOfWeek: 4 }))).toBe(false);
  });

  it("is false when the venue differs", () => {
    expect(isSameSlot(slot({ venue: "Goals North Cheam" }), slot({ venue: "PlayFootball Mitcham" }))).toBe(false);
  });

  it("is false when the org differs", () => {
    expect(isSameSlot(slot({ orgId: "sutton-fc" }), slot({ orgId: "other-org" }))).toBe(false);
  });
});

describe("hasMatchForSlot", () => {
  it("THE BUG: a format-switched match (same slot, DIFFERENT activity) suppresses regeneration", () => {
    // Generating for the still-active 7-a-side activity. A match already
    // exists for the same Tuesday 20:30 slot — it now belongs to the
    // 5-a-side activity after the switch. Must NOT generate a ghost.
    const generatingFor = slot(); // the 7-a-side activity's slot
    const existing = [slot()]; // the switched 5-a-side match's slot — identical
    expect(hasMatchForSlot(generatingFor, existing)).toBe(true);
  });

  it("a genuinely different TIME at the same venue/day still generates", () => {
    // Two real games on Tuesday at Goals North Cheam: 19:00 and 20:30.
    // Generating the 20:30 one must not be suppressed by the 19:00 match.
    const generatingFor = slot({ time: "20:30" });
    const existing = [slot({ time: "19:00" })];
    expect(hasMatchForSlot(generatingFor, existing)).toBe(false);
  });

  it("the ordinary case: same-activity match in the window suppresses a re-run", () => {
    const generatingFor = slot();
    const existing = [slot()];
    expect(hasMatchForSlot(generatingFor, existing)).toBe(true);
  });

  it("a different venue on the same day/time still generates", () => {
    const generatingFor = slot();
    const existing = [slot({ venue: "PlayFootball Mitcham" })];
    expect(hasMatchForSlot(generatingFor, existing)).toBe(false);
  });

  it("a different org never suppresses", () => {
    const generatingFor = slot();
    const existing = [slot({ orgId: "other-org" })];
    expect(hasMatchForSlot(generatingFor, existing)).toBe(false);
  });

  it("no existing matches → generate", () => {
    expect(hasMatchForSlot(slot(), [])).toBe(false);
  });
});
