/**
 * Unit tests for the SLOT-BASED dedupe used by the weekly match generator
 * (`/api/cron/generate-matches`).
 *
 * Bug #1 (2026-06-27, Sutton FC): an admin switched the Tuesday match from
 * 7-a-side → 5-a-side. `switchMatchFormat` only re-points the Match's
 * `activityId` to the 5-a-side Activity; it does NOT deactivate the old
 * 7-a-side Activity, which stays `isActive: true`. The generator deduped
 * by `activityId` ONLY, so when it ran for the still-active 7-a-side
 * Activity it CREATED A BRAND-NEW EMPTY 7-a-side ghost match.
 *
 * Bug #2 (THIS fix, 2026-06-29): the first fix keyed the slot on EXACT
 * `time` string equality — (orgId, venue, dayOfWeek, time). But the two
 * formats of the SAME recurring Tuesday fixture have DIFFERENT kickoff
 * times in prod: `tuesday-7aside` is "21:30", `tuesday-5aside` is "21:15".
 * `switchMatchFormat` keeps the original Match.date (the 21:30 instant), so
 * exact-time equality saw two different slots and STILL created the ghost.
 *
 * Fix: a "slot" is (orgId, venue, dayOfWeek) PLUS the match INSTANT, and two
 * slots match when org/venue/day are equal AND the instants are within a
 * ±90-minute tolerance. We compare the real Match.date instant against the
 * computed matchDate — the instant is the source of truth and is immune to
 * activity-`time` config drift (exactly the drift that broke fix #1). A 15-
 * minute format shift = same slot; a genuinely different session ≥ ~2h away
 * = different slot and still generates.
 *
 * Pure logic — no DB. The route loads candidate matches in the window and
 * delegates the decision here so the same predicate is unit-testable.
 */
import { describe, it, expect } from "vitest";
import {
  hasMatchForSlot,
  isSameSlot,
  SLOT_TIME_TOLERANCE_MS,
  type MatchSlot,
} from "@/lib/match-slot";

// Real prod instant: 2026-06-30 (Tuesday) 21:30 BST = 20:30 UTC.
const TUESDAY_2130_BST = new Date("2026-06-30T20:30:00Z");

const slot = (over: Partial<MatchSlot> = {}): MatchSlot => ({
  orgId: "sutton-fc",
  venue: "Goals North Cheam",
  dayOfWeek: 2, // Tuesday
  instant: TUESDAY_2130_BST,
  ...over,
});

const minutes = (n: number) => n * 60 * 1000;

describe("isSameSlot", () => {
  it("is true when org/venue/day match and instants are identical", () => {
    expect(isSameSlot(slot(), slot())).toBe(true);
  });

  it("is true when instants differ by a small format shift (15 min)", () => {
    const shifted = slot({ instant: new Date(TUESDAY_2130_BST.getTime() + minutes(15)) });
    expect(isSameSlot(slot(), shifted)).toBe(true);
  });

  it("is false when instants are ~2h apart (a different session)", () => {
    const later = slot({ instant: new Date(TUESDAY_2130_BST.getTime() + minutes(120)) });
    expect(isSameSlot(slot(), later)).toBe(false);
  });

  it("is false just outside the tolerance boundary", () => {
    const justOver = slot({
      instant: new Date(TUESDAY_2130_BST.getTime() + SLOT_TIME_TOLERANCE_MS + minutes(1)),
    });
    expect(isSameSlot(slot(), justOver)).toBe(false);
  });

  it("is false when the dayOfWeek differs", () => {
    expect(isSameSlot(slot({ dayOfWeek: 2 }), slot({ dayOfWeek: 4 }))).toBe(false);
  });

  it("is false when the venue differs", () => {
    expect(
      isSameSlot(slot(), slot({ venue: "PlayFootball Mitcham" })),
    ).toBe(false);
  });

  it("is false when the org differs", () => {
    expect(isSameSlot(slot(), slot({ orgId: "other-org" }))).toBe(false);
  });
});

describe("hasMatchForSlot", () => {
  it("THE REGRESSION: a format-switched match at the SAME instant suppresses regeneration even though activity times differ (21:30 vs 21:15)", () => {
    // Generating for the still-active 7-a-side activity: computed matchDate
    // is the 21:30 BST instant. The switched 5-a-side match kept the
    // original Match.date — the SAME 21:30 instant — even though the
    // 5-a-side Activity is configured at 21:15. org/venue/day match and the
    // instants are identical → same slot → MUST suppress (no ghost).
    const generatingFor = slot({ instant: TUESDAY_2130_BST });
    const existing = [slot({ instant: TUESDAY_2130_BST })];
    expect(hasMatchForSlot(generatingFor, existing)).toBe(true);
  });

  it("a small (15 min) time shift between formats still dedupes", () => {
    const generatingFor = slot({ instant: TUESDAY_2130_BST });
    const existing = [
      slot({ instant: new Date(TUESDAY_2130_BST.getTime() - minutes(15)) }),
    ];
    expect(hasMatchForSlot(generatingFor, existing)).toBe(true);
  });

  it("a genuinely different SESSION (~2h off) at the same venue/day still generates", () => {
    // 18:00 league game vs 20:00 game at the same venue on Tuesday.
    const generatingFor = slot({ instant: new Date("2026-06-30T19:00:00Z") }); // 20:00 BST
    const existing = [slot({ instant: new Date("2026-06-30T17:00:00Z") })]; // 18:00 BST
    expect(hasMatchForSlot(generatingFor, existing)).toBe(false);
  });

  it("the ordinary case: same-slot match in the window suppresses a re-run", () => {
    expect(hasMatchForSlot(slot(), [slot()])).toBe(true);
  });

  it("a different venue on the same day/instant still generates", () => {
    const existing = [slot({ venue: "PlayFootball Mitcham" })];
    expect(hasMatchForSlot(slot(), existing)).toBe(false);
  });

  it("a different dayOfWeek still generates", () => {
    const existing = [slot({ dayOfWeek: 4 })];
    expect(hasMatchForSlot(slot(), existing)).toBe(false);
  });

  it("a different org never suppresses", () => {
    const existing = [slot({ orgId: "other-org" })];
    expect(hasMatchForSlot(slot(), existing)).toBe(false);
  });

  it("no existing matches → generate", () => {
    expect(hasMatchForSlot(slot(), [])).toBe(false);
  });
});
