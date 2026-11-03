/**
 * The reads behind a carried seed (`carried-seed-loader.ts`): per club,
 * the rating players see there (newest 60, raw mean) and the games it
 * rated him in; the club being joined is never one of the "other clubs";
 * cancelled matches never count. A fake client, no DB.
 */
import { describe, expect, it, vi } from "vitest";
import { loadCarriedSeed, loadClubRatingsByClub, otherClubs, type CarriedSeedRatingRow } from "@/lib/carried-seed-loader";
import { NOT_CANCELLED } from "@/lib/played-match";

const row = (playerId: string, orgId: string, matchId: string, score: number): CarriedSeedRatingRow => ({
  playerId,
  matchId,
  score,
  match: { activity: { orgId } },
});

function clientWith(rows: CarriedSeedRatingRow[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { client: { rating: { findMany } }, findMany };
}

describe("loadClubRatingsByClub", () => {
  it("one query, newest first, cancelled matches excluded", async () => {
    const { client, findMany } = clientWith([]);
    await loadClubRatingsByClub(client, ["u1", "u2"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ playerId: { in: ["u1", "u2"] }, match: { ...NOT_CANCELLED } });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("no players: no query", async () => {
    const { client, findMany } = clientWith([]);
    expect((await loadClubRatingsByClub(client, [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("per club: the raw mean and the distinct games", async () => {
    const { client } = clientWith([
      row("u", "sutton", "m1", 8),
      row("u", "sutton", "m1", 6),
      row("u", "sutton", "m2", 7),
      row("u", "vets", "m9", 9),
    ]);
    const out = await loadClubRatingsByClub(client, ["u"]);
    expect(out.get("u")).toEqual([
      { orgId: "sutton", rating: 7, ratedGames: 2 },
      { orgId: "vets", rating: 9, ratedGames: 1 },
    ]);
  });

  it("the rating is over the newest 60 at each club, as players see it", async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => row("u", "a", `n${i}`, 8)),
      ...Array.from({ length: 20 }, (_, i) => row("u", "a", `o${i}`, 2)),
    ];
    const out = await loadClubRatingsByClub(clientWith(rows).client, ["u"]);
    expect(out.get("u")![0].rating).toBe(8);
  });
});

describe("the source club's sharing setting is not consulted (Kemal, 2026-11-03: always carry)", () => {
  it("a client with no organisation reads at all still carries, so the setting cannot gate it", async () => {
    const { client } = clientWith([row("u", "private-club", "s1", 7)]);
    expect("organisation" in client).toBe(false);
    expect(await loadCarriedSeed(client, "u", "vets")).toEqual({ seed: 7, fromOrgIds: ["private-club"] });
  });
});

describe("otherClubs and loadCarriedSeed", () => {
  it("the club being joined is never an 'other club'", () => {
    const all = [
      { orgId: "a", rating: 9, ratedGames: 3 },
      { orgId: "b", rating: 5, ratedGames: 3 },
    ];
    expect(otherClubs(all, "a")).toEqual([{ orgId: "b", rating: 5, ratedGames: 3 }]);
    expect(otherClubs(all, null)).toEqual(all);
    expect(otherClubs(undefined, "a")).toEqual([]);
  });

  it("the seed carried into a new club, from every other club, weighted by games", async () => {
    const { client } = clientWith([
      row("u", "sutton", "s1", 7),
      row("u", "sutton", "s2", 7),
      row("u", "sutton", "s3", 8),
      row("u", "vets", "v1", 4),
    ]);
    // Joining a third club: (7.333 x 3 + 4 x 1) / 4 = 6.5 -> 7.
    expect(await loadCarriedSeed(client, "u", "new")).toEqual({ seed: 7, fromOrgIds: ["sutton", "vets"] });
    // Joining the Vets: only Sutton counts, 7.333 -> 7.
    expect(await loadCarriedSeed(client, "u", "vets")).toEqual({ seed: 7, fromOrgIds: ["sutton"] });
    // Only rated at the club being joined: nothing to carry.
    expect(await loadCarriedSeed(clientWith([row("u", "vets", "v1", 4)]).client, "u", "vets")).toBeNull();
  });
});
