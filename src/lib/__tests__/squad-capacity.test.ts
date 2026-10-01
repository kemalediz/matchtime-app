/**
 * Slice 2b (plan 2.6): the ONE rule for who may take a free place, called
 * by the engine's `applyClaim` (the react) and by `registerAttendance`
 * (the write), so the two cannot disagree.
 */
import { describe, expect, it } from "vitest";
import { canTakeFreePlace, normaliseBenchPickFallback, normaliseBenchPickMode } from "../squad-capacity";

const flags = [false, true];

describe("canTakeFreePlace", () => {
  it("first-come is today's rule on every input: a place is free, nothing else matters", () => {
    for (const confirmed of [0, 13, 14, 15]) {
      for (const actorIsAdmin of flags)
        for (const isReclaim of flags)
          for (const openBenchOffer of flags) {
            expect(
              canTakeFreePlace({ confirmed, maxPlayers: 14, pickMode: "first-come", actorIsAdmin, isReclaim, openBenchOffer }),
            ).toBe(confirmed < 14);
          }
    }
  });

  const organiser = { confirmed: 17, maxPlayers: 18, pickMode: "organiser" as const, actorIsAdmin: false, isReclaim: false, openBenchOffer: false };

  it("organiser: a non-admin IN with room goes to the waiting list", () => {
    expect(canTakeFreePlace(organiser)).toBe(false);
  });
  it("organiser: an admin, a reclaim, or a running fallback offer takes the place", () => {
    expect(canTakeFreePlace({ ...organiser, actorIsAdmin: true })).toBe(true);
    expect(canTakeFreePlace({ ...organiser, isReclaim: true })).toBe(true);
    expect(canTakeFreePlace({ ...organiser, openBenchOffer: true })).toBe(true);
  });
  it("full is the waiting list for everyone", () => {
    for (const actorIsAdmin of flags)
      for (const isReclaim of flags)
        for (const openBenchOffer of flags)
          expect(canTakeFreePlace({ ...organiser, confirmed: 18, actorIsAdmin, isReclaim, openBenchOffer })).toBe(false);
  });
});

describe("normalising the stored settings", () => {
  it("anything unknown reads as today's behaviour", () => {
    expect(normaliseBenchPickMode("organiser")).toBe("organiser");
    expect(normaliseBenchPickMode("first-come")).toBe("first-come");
    expect(normaliseBenchPickMode(undefined)).toBe("first-come");
    expect(normaliseBenchPickMode("ORGANISER ")).toBe("first-come");
    expect(normaliseBenchPickFallback("leave-empty")).toBe("leave-empty");
    expect(normaliseBenchPickFallback(null)).toBe("bench-offer");
  });
});
