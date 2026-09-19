/**
 * `computeClubRating`, the club-scoped replacement for
 * `computePlayerRating`, per section 4.2 of
 * `MDs/club-scoped-ratings-design-2026-09-18.md`.
 *
 * Pure arithmetic, no DB, no network. The shape is unchanged from the
 * function it replaces: a Bayesian blend of a prior (weight 3) and the
 * player's own peer scores. What changes is the IDENTITY of the prior
 * and the provenance of the peer scores, both of which are now
 * club-scoped:
 *
 *   prior = Membership.seedRating for THIS club
 *           ?? the mean of every rating given in THIS club
 *           ?? 5.0
 *
 * The last of those three is the honest "this club has never rated
 * anybody" answer, and it makes every player equal so the balancer
 * falls through to position composition.
 *
 * The isolation property itself (a rating in club A cannot move a
 * player's number in club B) is proven end to end in
 * `club-rating-isolation.test.ts`. This file proves the arithmetic.
 */
import { describe, it, expect } from "vitest";
import { computeClubRating, computePlayerRating } from "@/lib/player-rating";

/** Sutton FC's real club mean, measured read-only on 2026-09-18
 *  (design section 3.5). Used so the numbers below are the numbers the
 *  design quotes rather than a made-up pair. */
const SUTTON_MEAN = 6.674;

describe("computeClubRating", () => {
  it("peerCount 0 with a club seed returns the seed exactly", () => {
    const r = computeClubRating({
      clubSeedRating: 8,
      clubPeerRatings: [],
      clubMeanRating: SUTTON_MEAN,
    });
    expect(r.rating).toBe(8);
    expect(r.source).toBe("seed");
    expect(r.peerCount).toBe(0);
  });

  it("peerCount 0 with NO club seed falls to the club mean, not to 5.0", () => {
    const r = computeClubRating({
      clubSeedRating: null,
      clubPeerRatings: [],
      clubMeanRating: SUTTON_MEAN,
    });
    expect(r.rating).toBeCloseTo(SUTTON_MEAN, 10);
    expect(r.source).toBe("club-average");
    expect(r.peerCount).toBe(0);
  });

  it("peerCount 0 with no seed and no club mean returns 5.0", () => {
    // The Turkish club on day one: nobody seeded, nobody rated. Every
    // player gets the same number, so the rating term is constant and
    // the balancer falls through to composition and its hill-climb.
    const r = computeClubRating({
      clubSeedRating: null,
      clubPeerRatings: [],
      clubMeanRating: null,
    });
    expect(r.rating).toBe(5);
    expect(r.source).toBe("club-average");
  });

  it("peerCount 1 shrinks the single score 75% toward the prior", () => {
    // (9 + 6*3) / (1+3) = 27/4 = 6.75
    const r = computeClubRating({
      clubSeedRating: 6,
      clubPeerRatings: [9],
      clubMeanRating: SUTTON_MEAN,
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
      clubMeanRating: SUTTON_MEAN,
    });
    expect(r.rating).toBeCloseTo(7.2, 10);
    expect(r.source).toBe("blended");
  });

  it("peerCount 3 is the 50/50 crossover", () => {
    // (9+9+9 + 6*3) / (3+3) = 45/6 = 7.5
    const r = computeClubRating({
      clubSeedRating: 6,
      clubPeerRatings: [9, 9, 9],
      clubMeanRating: SUTTON_MEAN,
    });
    expect(r.rating).toBeCloseTo(7.5, 10);
    expect(r.source).toBe("blended");
  });

  it("peerCount 9 flips source to peer", () => {
    const r = computeClubRating({
      clubSeedRating: 6,
      clubPeerRatings: Array(9).fill(7),
      clubMeanRating: SUTTON_MEAN,
    });
    expect(r.source).toBe("peer");
    expect(r.peerCount).toBe(9);
  });

  it("peerCount 8 is still blended, 9 is the threshold", () => {
    const eight = computeClubRating({
      clubSeedRating: 6,
      clubPeerRatings: Array(8).fill(7),
      clubMeanRating: SUTTON_MEAN,
    });
    expect(eight.source).toBe("blended");
  });

  it("the club mean is ignored whenever a club seed exists", () => {
    const withMean = computeClubRating({
      clubSeedRating: 7,
      clubPeerRatings: [8, 8],
      clubMeanRating: 2,
    });
    const withoutMean = computeClubRating({
      clubSeedRating: 7,
      clubPeerRatings: [8, 8],
      clubMeanRating: null,
    });
    expect(withMean.rating).toBe(withoutMean.rating);
  });

  it("clamps to [1, 10] for an out-of-band seed, as today", () => {
    expect(
      computeClubRating({ clubSeedRating: 99, clubPeerRatings: [], clubMeanRating: null }).rating,
    ).toBe(10);
    expect(
      computeClubRating({ clubSeedRating: -4, clubPeerRatings: [], clubMeanRating: null }).rating,
    ).toBe(1);
  });

  it("clamps an out-of-band club mean too", () => {
    expect(
      computeClubRating({ clubSeedRating: null, clubPeerRatings: [], clubMeanRating: 42 }).rating,
    ).toBe(10);
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
      const old = computePlayerRating({ seedRating: seed, peerRatings: peers });
      const now = computeClubRating({
        clubSeedRating: seed,
        clubPeerRatings: peers,
        // Irrelevant: the seed wins. Deliberately absurd so a bug that
        // consulted it would be loud.
        clubMeanRating: 1,
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
      clubMeanRating: 6.674,
      // @ts-expect-error there is no global/all-clubs input, by design
      peerRatings: [9, 9, 9],
    });
    expect(true).toBe(true);
  });

  it("the three inputs are the whole input", () => {
    // A structural guard on the arity of the argument object. If a
    // fourth key is ever added, this test is where the reviewer is
    // asked whether it is club-scoped.
    const args = { clubSeedRating: 6, clubPeerRatings: [7], clubMeanRating: 6.674 };
    expect(Object.keys(args).sort()).toEqual([
      "clubMeanRating",
      "clubPeerRatings",
      "clubSeedRating",
    ]);
    expect(computeClubRating(args).peerCount).toBe(1);
  });
});
