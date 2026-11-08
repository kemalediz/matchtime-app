/**
 * Two games' windows overlap (plan 3.6: an hour of travel either side).
 * Kept from the automatic ask's tests (slice S5) when that ask was removed
 * (Kemal, 2026-11-08): the guest and pool rules still use it.
 */
import { describe, expect, it } from "vitest";
import { gamesOverlap } from "../partner-ask-rules";

describe("gamesOverlap: an hour either side of each game", () => {
  const at = (iso: string) => new Date(iso);
  it("20:30 and 21:00 the same evening overlap", () => {
    expect(gamesOverlap({ kickoff: at("2026-10-30T20:30:00Z"), durationMins: 60 }, { kickoff: at("2026-10-30T21:00:00Z"), durationMins: 60 })).toBe(true);
  });
  it("a 60-minute game at 18:00 and one at 21:00: an hour's gap either side still meets", () => {
    // 18:00 game ends 19:00, +1h = 20:00; the 21:00 game's window opens 20:00: touching, not overlapping.
    expect(gamesOverlap({ kickoff: at("2026-10-30T18:00:00Z"), durationMins: 60 }, { kickoff: at("2026-10-30T21:00:00Z"), durationMins: 60 })).toBe(false);
    expect(gamesOverlap({ kickoff: at("2026-10-30T18:00:00Z"), durationMins: 61 }, { kickoff: at("2026-10-30T21:00:00Z"), durationMins: 60 })).toBe(true);
  });
  it("a morning game and an evening game do not", () => {
    expect(gamesOverlap({ kickoff: at("2026-10-30T10:00:00Z"), durationMins: 90 }, { kickoff: at("2026-10-30T20:00:00Z"), durationMins: 60 })).toBe(false);
  });
  it("the window is symmetric", () => {
    const a = { kickoff: at("2026-10-30T20:30:00Z"), durationMins: 60 };
    const b = { kickoff: at("2026-10-30T19:00:00Z"), durationMins: 90 };
    expect(gamesOverlap(a, b)).toBe(gamesOverlap(b, a));
  });
});
