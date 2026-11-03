/**
 * A PLAYER'S SEED CARRIED INTO A NEW CLUB (Kemal, 2026-11-03). The pure
 * rule (`carried-seed.ts`): his shown club rating at each other club,
 * weighted by the games that club rated him in, rounded to the seed
 * box's whole numbers and clamped to 1..10; only for a membership being
 * created with no seed. No DB, no model.
 */
import { describe, expect, it, vi } from "vitest";
import { carriedSeed, fillCarriedSeed, needsCarriedSeed, planCarriedSeeds, SEED_MAX, SEED_MIN } from "@/lib/carried-seed";

describe("carriedSeed", () => {
  it("one other club: its rating, rounded", () => {
    expect(carriedSeed([{ orgId: "a", rating: 7.4, ratedGames: 12 }])).toEqual({ seed: 7, fromOrgIds: ["a"] });
    expect(carriedSeed([{ orgId: "a", rating: 7.5, ratedGames: 12 }])?.seed).toBe(8);
  });

  it("several clubs: weighted by the games each rated him in, not a plain mean", () => {
    // Plain mean (9 + 6) / 2 = 7.5 would round to 8; weighted
    // (9 x 1 + 6 x 9) / 10 = 6.3 rounds to 6.
    const r = carriedSeed([
      { orgId: "guested-once", rating: 9, ratedGames: 1 },
      { orgId: "home", rating: 6, ratedGames: 9 },
    ]);
    expect(r).toEqual({ seed: 6, fromOrgIds: ["guested-once", "home"] });
  });

  it("a club that never rated him is left out of the average", () => {
    expect(
      carriedSeed([
        { orgId: "a", rating: null, ratedGames: 0 },
        { orgId: "b", rating: 8.2, ratedGames: 3 },
      ]),
    ).toEqual({ seed: 8, fromOrgIds: ["b"] });
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

  it("always a whole number, the seed box's precision", () => {
    for (const rating of [1, 3.49, 5.5, 6.01, 9.99]) {
      expect(Number.isInteger(carriedSeed([{ orgId: "a", rating, ratedGames: 4 }])!.seed)).toBe(true);
    }
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
      { membershipId: "m1", orgId: "vets", userId: "kemal", seed: 7, fromOrgIds: ["sutton"] },
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
