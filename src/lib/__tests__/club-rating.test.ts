/**
 * `computeClubRating`, the club-scoped replacement for the global
 * `computePlayerRating` (deleted by slice 6), per section 4.2 of
 * `MDs/club-scoped-ratings-design-2026-09-18.md`.
 *
 * Pure arithmetic, no DB, no network. The shape is unchanged from the
 * function it replaces: a Bayesian blend of a prior (weight 3) and the
 * player's own peer scores. What changes is the IDENTITY of the prior
 * and the provenance of the peer scores, both of which are now
 * club-scoped:
 *
 *   prior = Membership.seedRating for THIS club ?? DEFAULT_SEED_RATING (6)
 *
 * Until 2026-11-02 the fallback was this club's mean rating, else 5.0.
 * Kemal made the default seed 6, the medium player the admin's seed box
 * now shows, and the balancer uses that same 6 (`default-seed.test.ts`).
 *
 * The isolation property itself (a rating in club A cannot move a
 * player's number in club B) is proven end to end in
 * `club-rating-isolation.test.ts`. This file proves the arithmetic.
 */
import { describe, it, expect } from "vitest";
import { computeClubRating } from "@/lib/player-rating";

/**
 * THE GLOBAL FORMULA, as it stood before 2026-09-19, reproduced here
 * verbatim. `computePlayerRating` itself was deleted by slice 6 once
 * its last caller (the dashboard tile) became club-scoped, and a
 * deleted function cannot be compared against. Keeping the arithmetic
 * local is the same move `scripts/compare-rating-formulas.ts` makes for
 * the elo-mix formula it outlived: the comparison stays a comparison
 * and not a paraphrase.
 */
function legacyGlobalRating(args: { seedRating: number | null; peerRatings: number[] }): {
  rating: number;
  source: "peer" | "blended" | "seed";
  peerCount: number;
} {
  const PRIOR_WEIGHT = 3;
  const seed = args.seedRating ?? 5;
  const peerCount = args.peerRatings.length;
  const sumPeer = args.peerRatings.reduce((s, r) => s + r, 0);
  const blended = (sumPeer + seed * PRIOR_WEIGHT) / (peerCount + PRIOR_WEIGHT);
  const rating = Math.max(1, Math.min(10, blended));
  const source = peerCount === 0 ? "seed" : peerCount >= PRIOR_WEIGHT * 3 ? "peer" : "blended";
  return { rating, source, peerCount };
}

describe("computeClubRating", () => {
  it("peerCount 0 with a club seed returns the seed exactly", () => {
    const r = computeClubRating({
      clubSeedRating: 8,
      clubPeerRatings: [],
    });
    expect(r.rating).toBe(8);
    expect(r.source).toBe("seed");
    expect(r.peerCount).toBe(0);
  });

  it("peerCount 0 with NO club seed is the default seed, 6, whatever the club rates on average", () => {
    const r = computeClubRating({ clubSeedRating: null, clubPeerRatings: [] });
    expect(r.rating).toBe(6);
    expect(r.source).toBe("default-seed");
    expect(r.peerCount).toBe(0);
  });

  it("peerCount 1 shrinks the single score 75% toward the prior", () => {
    // (9 + 6*3) / (1+3) = 27/4 = 6.75
    const r = computeClubRating({
      clubSeedRating: 6,
      clubPeerRatings: [9],
    });
    expect(r.rating).toBeCloseTo(6.75, 10);
    expect(r.source).toBe("blended");
    expect(r.peerCount).toBe(1);
  });

  it("peerCount 2 shrinks 60% toward the prior", () => {
    // (9+9 + 6*3) / (2+3) = 36/5 = 7.2
    const r = computeClubRating({
      clubSeedRating: 6,
      clubPeerRatings: [9, 9],
    });
    expect(r.rating).toBeCloseTo(7.2, 10);
    expect(r.source).toBe("blended");
  });

  it("peerCount 3 is the 50/50 crossover", () => {
    // (9+9+9 + 6*3) / (3+3) = 45/6 = 7.5
    const r = computeClubRating({
      clubSeedRating: 6,
      clubPeerRatings: [9, 9, 9],
    });
    expect(r.rating).toBeCloseTo(7.5, 10);
    expect(r.source).toBe("blended");
  });

  it("peerCount 9 flips source to peer", () => {
    const r = computeClubRating({
      clubSeedRating: 6,
      clubPeerRatings: Array(9).fill(7),
    });
    expect(r.source).toBe("peer");
    expect(r.peerCount).toBe(9);
  });

  it("peerCount 8 is still blended, 9 is the threshold", () => {
    const eight = computeClubRating({
      clubSeedRating: 6,
      clubPeerRatings: Array(8).fill(7),
    });
    expect(eight.source).toBe("blended");
  });

  it("clamps to [1, 10] for an out-of-band seed, as today", () => {
    expect(
      computeClubRating({ clubSeedRating: 99, clubPeerRatings: [] }).rating,
    ).toBe(10);
    expect(
      computeClubRating({ clubSeedRating: -4, clubPeerRatings: [] }).rating,
    ).toBe(1);
  });

});

/**
 * "No unnecessary movement." 34 of Sutton's 43 rated members have every
 * one of their ratings inside Sutton, and all 143 users carry a seed.
 * For them the new function must return the number the old one did, to
 * the last bit. If this fails, the change is not "stop borrowing from
 * another club", it is "re-rate the whole club".
 */
describe("computeClubRating matches the old formula for a single-club seeded player", () => {
  const cases: { seed: number; peers: number[] }[] = [
    { seed: 6, peers: [] },
    { seed: 6, peers: [7] },
    { seed: 7, peers: [8, 6, 9] },
    { seed: 5.5, peers: [6, 6, 7, 7, 8, 5, 6, 7, 9, 4] },
    { seed: 8, peers: Array(60).fill(7) },
  ];
  for (const { seed, peers } of cases) {
    it(`seed ${seed} with ${peers.length} peer ratings`, () => {
      const old = legacyGlobalRating({ seedRating: seed, peerRatings: peers });
      const now = computeClubRating({
        clubSeedRating: seed,
        clubPeerRatings: peers,
      });
      expect(now.rating).toBe(old.rating);
      expect(now.peerCount).toBe(old.peerCount);
      expect(now.source).toBe(old.source);
    });
  }
});

/**
 * Design section 10.2 case 9: the bug is unrepresentable in the type.
 * There is no parameter on `computeClubRating` that could carry another
 * club's number, so a caller cannot pass one even by accident. Asserted
 * by type, not at runtime: the `@ts-expect-error` below fails the
 * `tsc --noEmit` gate the day somebody widens the signature.
 */
describe("the signature cannot carry another club's number", () => {
  it("rejects a global peerRatings parameter at compile time", () => {
    computeClubRating({
      clubSeedRating: 6,
      clubPeerRatings: [7],
      // @ts-expect-error there is no global/all-clubs input, by design
      peerRatings: [9, 9, 9],
    });
    expect(true).toBe(true);
  });

  it("the two inputs are the whole input", () => {
    // A structural guard on the arity of the argument object. If a
    // third key is ever added, this test is where the reviewer is
    // asked whether it is club-scoped. (The club mean was the third
    // until 2026-11-02.)
    const args = { clubSeedRating: 6, clubPeerRatings: [7] };
    expect(Object.keys(args).sort()).toEqual(["clubPeerRatings", "clubSeedRating"]);
    expect(computeClubRating(args).peerCount).toBe(1);
  });
});
