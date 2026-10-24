/**
 * A guest's turn-up record (slice L4), from GuestPlace results: the first
 * ranking key, and the one definition L7's reliability line will reuse.
 */
import { describe, expect, it } from "vitest";
import { compareTurnUp, RELIABLE_MAX_MISS_SHARE, turnUpRecordOf, turnUpTier } from "../turn-up";
import type { GuestResult } from "../vocab";

describe("turnUpRecordOf", () => {
  const table: Array<[string, GuestResult[], { played: number; missed: number }]> = [
    ["nothing yet", [], { played: 0, missed: 0 }],
    ["played counts as turned up", ["played", "played"], { played: 2, missed: 0 }],
    ["no-show and late cancel are misses", ["no-show", "late-cancel", "played"], { played: 1, missed: 2 }],
    ["booked (not played yet) and withdrawn in time are neither", ["booked", "withdrawn", "played"], { played: 1, missed: 0 }],
  ];
  it.each(table)("%s", (_n, results, want) => expect(turnUpRecordOf(results)).toEqual(want));
});

describe("turnUpTier", () => {
  const table: Array<[string, { played: number; missed: number }, string]> = [
    ["no counted game: new", { played: 0, missed: 0 }, "new"],
    ["only misses: unreliable", { played: 0, missed: 1 }, "unreliable"],
    ["all played: reliable", { played: 3, missed: 0 }, "reliable"],
    ["miss share exactly at the limit: reliable", { played: 4, missed: 1 }, "reliable"],
    ["just over the limit: unreliable", { played: 3, missed: 1 }, "unreliable"],
  ];
  it.each(table)("%s", (_n, rec, want) => expect(turnUpTier(rec)).toBe(want));
  it("the limit is one constant", () => expect(RELIABLE_MAX_MISS_SHARE).toBe(0.2));
});

describe("compareTurnUp: reliable, then new, then unreliable; fewer misses, then more games", () => {
  it("orders a shuffled list the same way every time", () => {
    const recs = [
      { played: 0, missed: 2 },
      { played: 0, missed: 0 },
      { played: 5, missed: 0 },
      { played: 1, missed: 0 },
      { played: 9, missed: 1 },
      { played: 1, missed: 1 },
    ];
    const want = [
      { played: 5, missed: 0 },
      { played: 1, missed: 0 },
      { played: 9, missed: 1 },
      { played: 0, missed: 0 },
      { played: 1, missed: 1 },
      { played: 0, missed: 2 },
    ];
    for (let i = 0; i < 6; i++) {
      const shuffled = [...recs.slice(i), ...recs.slice(0, i)].reverse();
      expect([...shuffled].sort(compareTurnUp)).toEqual(want);
    }
  });
});
