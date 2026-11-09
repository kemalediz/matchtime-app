/**
 * A PLAYER'S SEED CARRIED INTO A NEW CLUB (Kemal, 2026-11-03). The pure
 * rule (`carried-seed.ts`): his shown club rating at each other club,
 * weighted by the games that club rated him in, kept exactly as it
 * comes out (never rounded, Kemal 2026-11-09) and clamped to 1..10; only
 * for a membership being created with no seed. No DB, no model.
 */
import { describe, expect, it, vi } from "vitest";
import { carriedSeed, fillCarriedSeed, needsCarriedSeed, planCarriedSeeds, SEED_MAX, SEED_MIN } from "@/lib/carried-seed";
import { classifyCarriedSeedRecompute } from "@/lib/carried-seed-recompute";

describe("carriedSeed", () => {
  it("one other club: its rating, exactly", () => {
    expect(carriedSeed([{ orgId: "a", rating: 7.4, ratedGames: 12 }])).toEqual({ seed: 7.4, fromOrgIds: ["a"] });
    expect(carriedSeed([{ orgId: "a", rating: 7.5, ratedGames: 12 }])?.seed).toBe(7.5);
    expect(carriedSeed([{ orgId: "a", rating: 6.41666666666667, ratedGames: 12 }])?.seed).toBe(6.41666666666667);
  });

  it("several clubs: weighted by the games each rated him in, not a plain mean", () => {
    // Plain mean (9 + 6) / 2 = 7.5; weighted (9 x 1 + 6 x 9) / 10 = 6.3.
    const r = carriedSeed([
      { orgId: "guested-once", rating: 9, ratedGames: 1 },
      { orgId: "home", rating: 6, ratedGames: 9 },
    ]);
    expect(r?.fromOrgIds).toEqual(["guested-once", "home"]);
    expect(r?.seed).toBeCloseTo(6.3, 12);
  });

  it("a club that never rated him is left out of the average", () => {
    expect(
      carriedSeed([
        { orgId: "a", rating: null, ratedGames: 0 },
        { orgId: "b", rating: 8.2, ratedGames: 3 },
      ]),
    ).toEqual({ seed: 8.2, fromOrgIds: ["b"] });
  });

  it("no rating at any other club: no carried seed, so the default 6 stands", () => {
    expect(carriedSeed([])).toBeNull();
    expect(carriedSeed([{ orgId: "a", rating: null, ratedGames: 0 }])).toBeNull();
  });

  it("clamped to the seed box's range", () => {
    expect(SEED_MIN).toBe(1);
    expect(SEED_MAX).toBe(10);
    expect(carriedSeed([{ orgId: "a", rating: 12, ratedGames: 2 }])?.seed).toBe(10);
    expect(carriedSeed([{ orgId: "a", rating: 0.2, ratedGames: 2 }])?.seed).toBe(1);
  });

  it("never rounded: what the balancer uses is the average itself (Kemal, 2026-11-09)", () => {
    for (const rating of [1, 3.49, 5.5, 6.01, 9.99]) {
      expect(carriedSeed([{ orgId: "a", rating, ratedGames: 4 }])!.seed).toBe(rating);
    }
    // (8 + 8 + 9) / 3 at one club, as the web spec seeds it.
    expect(carriedSeed([{ orgId: "a", rating: 25 / 3, ratedGames: 3 }])!.seed).toBe(25 / 3);
  });
});

describe("needsCarriedSeed", () => {
  it("only an unset seed takes one", () => {
    expect(needsCarriedSeed(undefined)).toBe(true);
    expect(needsCarriedSeed(null)).toBe(true);
    expect(needsCarriedSeed(6)).toBe(false);
    expect(needsCarriedSeed(3)).toBe(false);
  });
});

describe("fillCarriedSeed", () => {
  const ids = { userId: "u", orgId: "new-club" };

  it("fills an unset seed from the other clubs, asking about the club being joined", async () => {
    const read = vi.fn().mockResolvedValue({ seed: 8, fromOrgIds: ["a"] });
    const out = await fillCarriedSeed({ userId: "u", orgId: "new-club", role: "PLAYER" }, ids, read);
    expect(out).toEqual({ userId: "u", orgId: "new-club", role: "PLAYER", seedRating: 8 });
    expect(read).toHaveBeenCalledWith("u", "new-club");
  });

  it("never overwrites a seed somebody set, and does not even read", async () => {
    const read = vi.fn().mockResolvedValue({ seed: 8, fromOrgIds: ["a"] });
    expect(await fillCarriedSeed({ seedRating: 3 }, ids, read)).toEqual({ seedRating: 3 });
    expect(read).not.toHaveBeenCalled();
  });

  it("no rating elsewhere: the payload is unchanged and the seed stays unset", async () => {
    const data = { userId: "u", orgId: "new-club" };
    expect(await fillCarriedSeed(data, ids, vi.fn().mockResolvedValue(null))).toEqual(data);
  });

  it("guests carry a seed too", async () => {
    const guest = { userId: "u", orgId: "new-club", role: "PLAYER", guestVia: "partner", guestFromOrgId: "home", guestMatchId: "m" };
    const out = await fillCarriedSeed(guest, ids, vi.fn().mockResolvedValue({ seed: 7, fromOrgIds: ["home"] }));
    expect(out).toEqual({ ...guest, seedRating: 7 });
  });

  it("a failed read never fails the join", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const data = { userId: "u", orgId: "new-club" };
    expect(await fillCarriedSeed(data, ids, vi.fn().mockRejectedValue(new Error("db down")))).toEqual(data);
    spy.mockRestore();
  });

  it("no user id: nothing to carry", async () => {
    const read = vi.fn();
    expect(await fillCarriedSeed({}, { userId: undefined, orgId: "x" }, read)).toEqual({});
    expect(read).not.toHaveBeenCalled();
  });
});

describe("planCarriedSeeds (the backfill)", () => {
  const ratings = new Map([
    ["kemal", [
      { orgId: "sutton", rating: 7.2, ratedGames: 20 },
      { orgId: "vets", rating: 5, ratedGames: 1 },
    ]],
    ["only-here", [{ orgId: "vets", rating: 8, ratedGames: 4 }]],
  ]);

  it("seeds an unset membership from the player's other clubs only", () => {
    const plan = planCarriedSeeds(
      [
        { id: "m1", orgId: "vets", userId: "kemal", seedRating: null },
        { id: "m2", orgId: "sutton", userId: "kemal", seedRating: null },
      ],
      ratings,
    );
    expect(plan).toEqual([
      { membershipId: "m1", orgId: "vets", userId: "kemal", seed: 7.2, fromOrgIds: ["sutton"] },
      { membershipId: "m2", orgId: "sutton", userId: "kemal", seed: 5, fromOrgIds: ["vets"] },
    ]);
  });

  it("never touches a seed somebody set", () => {
    expect(planCarriedSeeds([{ id: "m1", orgId: "vets", userId: "kemal", seedRating: 4 }], ratings)).toEqual([]);
  });

  it("a player rated only at this club, or nowhere: left out", () => {
    expect(
      planCarriedSeeds(
        [
          { id: "m1", orgId: "vets", userId: "only-here", seedRating: null },
          { id: "m2", orgId: "vets", userId: "nobody", seedRating: null },
        ],
        ratings,
      ),
    ).toEqual([]);
  });
});

/**
 * The re-computation of seeds carried before 2026-11-09, which were
 * stored rounded (`scripts/_tmp-recompute-carried-seeds.ts`). A stored
 * seed is only replaced when it is still exactly the rounded carried
 * value: anything else is an admin's own number, or was never carried.
 */
describe("classifyCarriedSeedRecompute", () => {
  it("a stored whole number that is the carried value rounded: replaced by the exact value", () => {
    expect(classifyCarriedSeedRecompute(7, 6.533333333333333)).toEqual({ action: "recompute", from: 7, to: 6.533333333333333 });
    expect(classifyCarriedSeedRecompute(8, 8.333333333333334)).toEqual({ action: "recompute", from: 8, to: 8.333333333333334 });
  });

  it("no seed: nothing to fix", () => {
    expect(classifyCarriedSeedRecompute(null, 6.5)).toEqual({ action: "skip", reason: "no-seed" });
  });

  it("already a decimal (an admin's typed decimal, or set exactly by hand): left alone", () => {
    expect(classifyCarriedSeedRecompute(6.41666666666667, 6.41666666666667)).toEqual({ action: "skip", reason: "already-exact" });
    expect(classifyCarriedSeedRecompute(6.5, 6.3)).toEqual({ action: "skip", reason: "already-exact" });
  });

  it("the carried value was a whole number anyway: nothing changes", () => {
    expect(classifyCarriedSeedRecompute(8, 8)).toEqual({ action: "skip", reason: "already-exact" });
  });

  it("no rating at another club at the time: the seed did not come from carrying", () => {
    expect(classifyCarriedSeedRecompute(7, null)).toEqual({ action: "skip", reason: "no-carry" });
  });

  it("a stored number that is not the carried value rounded: an admin's own seed, never touched", () => {
    expect(classifyCarriedSeedRecompute(9, 6.53)).toEqual({ action: "skip", reason: "differs" });
    expect(classifyCarriedSeedRecompute(6, 6.53)).toEqual({ action: "skip", reason: "differs" });
  });
});
