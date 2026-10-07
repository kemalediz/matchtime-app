/**
 * `invertEloDeltas`: recovering the deltas a result applied, from the
 * ratings as they stand AFTERWARDS (2026-10-06).
 *
 * The applied deltas of a match were never stored before today, so a
 * score that was recorded the wrong way round (Sutton FC, 6 Oct 2026:
 * "9-6 to yellows" recorded as Red 9, Yellow 6) can only be undone by
 * working backwards. Every player on a team gets the same delta, so the
 * unknown is one integer per team, and the forward function is the
 * referee: a candidate pair is a solution only if subtracting it and
 * running `computeEloDeltas` forwards reproduces exactly that pair.
 */
import { describe, it, expect } from "vitest";
import { computeEloDeltas, invertEloDeltas, type PlayerEloInput } from "../elo";

function squad(red: number[], yellow: number[]): PlayerEloInput[] {
  return [
    ...red.map((r, i) => ({ userId: `r${i}`, team: "RED" as const, matchRating: r })),
    ...yellow.map((r, i) => ({ userId: `y${i}`, team: "YELLOW" as const, matchRating: r })),
  ];
}

function applyForward(pre: PlayerEloInput[], red: number, yellow: number): PlayerEloInput[] {
  const deltas = computeEloDeltas(pre, red, yellow);
  return pre.map((p) => ({ ...p, matchRating: deltas.find((d) => d.userId === p.userId)!.after }));
}

function truthOf(pre: PlayerEloInput[], red: number, yellow: number) {
  const forward = computeEloDeltas(pre, red, yellow);
  // `+ 0`: Math.round can hand back -0, which is the same delta.
  return {
    red: forward.find((d) => d.userId === "r0")!.delta + 0,
    yellow: forward.find((d) => d.userId === "y0")!.delta + 0,
  };
}

describe("invertEloDeltas", () => {
  it("recovers exactly the deltas the forward pass applied", () => {
    const pre = squad([1008, 1097, 976, 1102, 1073, 1077, 1062], [991, 942, 934, 796, 1041, 955, 971]);
    const solutions = invertEloDeltas(applyForward(pre, 9, 6), 9, 6);
    expect(solutions).toEqual([truthOf(pre, 9, 6)]);
  });

  it("always contains the true deltas, and is never more than two adjacent candidates", () => {
    // NOT always unique, and the test says so rather than hiding it. The
    // forward pass rounds, and one point of delta moves the rating gap by
    // two points, which moves the unrounded answer by well under one
    // point. So two neighbouring integers can both survive the rounding.
    // A caller has to treat two candidates as "known to within one
    // point", never as licence to pick silently.
    // Deterministic pseudo-random squads: no Math.random in a test.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let ambiguous = 0;
    for (let i = 0; i < 300; i++) {
      const pre = squad(
        Array.from({ length: 7 }, () => 800 + Math.floor(next() * 400)),
        Array.from({ length: 7 }, () => 800 + Math.floor(next() * 400)),
      );
      const r = Math.floor(next() * 16);
      const y = Math.floor(next() * 16);
      const truth = truthOf(pre, r, y);
      const solutions = invertEloDeltas(applyForward(pre, r, y), r, y);
      expect(solutions).toContainEqual(truth);
      expect(solutions.length).toBeLessThanOrEqual(2);
      for (const s of solutions) {
        expect(Math.abs(s.red - truth.red)).toBeLessThanOrEqual(1);
        expect(Math.abs(s.yellow - truth.yellow)).toBeLessThanOrEqual(1);
      }
      if (solutions.length > 1) ambiguous++;
    }
    // Both outcomes really occur, so neither branch of a caller is dead.
    expect(ambiguous).toBeGreaterThan(0);
    expect(ambiguous).toBeLessThan(300);
  });

  it("leaves a player whose rating was never written out of the subtraction", () => {
    // No membership at the club: they entered the maths at 1000 and
    // nothing was persisted, so they still read 1000 afterwards.
    const pre = squad([1000, 1040, 1000], [990, 1010, 1000]);
    const after = applyForward(pre, 5, 2).map((p) =>
      p.userId === "r2" ? { ...p, matchRating: 1000 } : p,
    );
    expect(invertEloDeltas(after, 5, 2, new Set(["r2"]))).toContainEqual(truthOf(pre, 5, 2));
  });

  it("returns nothing for a match with an empty side, as the forward pass does", () => {
    expect(invertEloDeltas(squad([1000, 1000], []), 3, 1)).toEqual([]);
  });
});
