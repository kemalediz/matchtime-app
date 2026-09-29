/**
 * THE ADMIN PLAYERS PAGE SHOWS EACH PLAYER'S CLUB RATING.
 *
 * Kemal, 2026-09-29: "shouldn't the admin be able to see their current
 * rating?" The admin roster only ever showed the seed. The number it now
 * shows beside the seed is the SAME one the player sees on their own
 * page (`clubDisplayRating`): the raw mean of this club's most recent 60
 * ratings of them, null until a team-mate has rated them. Never the seed,
 * never another club's rows (the loader filters by org before this runs).
 *
 * Pure: `summariseClubDisplayRatings` takes rating rows the caller has
 * already scoped to one club, newest first. No DB.
 */
import { describe, it, expect } from "vitest";
import { summariseClubDisplayRatings, clubDisplayRating } from "@/lib/player-rating";

type Row = { playerId: string; matchId: string; score: number };

describe("summariseClubDisplayRatings", () => {
  it("gives each player the raw mean of their club ratings and counts distinct games", () => {
    const rows: Row[] = [
      { playerId: "riley", matchId: "m1", score: 8 },
      { playerId: "riley", matchId: "m1", score: 7 },
      { playerId: "pat", matchId: "m1", score: 4 },
      { playerId: "riley", matchId: "m0", score: 6 },
    ];
    const out = summariseClubDisplayRatings(["riley", "pat", "walt"], rows, 60);
    expect(out.riley.rating).toBeCloseTo(7, 5);
    expect(out.riley.ratedGames).toBe(2);
    expect(out.pat).toEqual({ rating: 4, ratedGames: 1 });
  });

  it("an unrated player has no number, even though the admin may have seeded them", () => {
    const out = summariseClubDisplayRatings(["walt"], [], 60);
    expect(out.walt).toEqual({ rating: null, ratedGames: 0 });
  });

  it("reads the same 60-rating window as the player's own page", () => {
    // 60 newest 9s, then 5 older 1s that the window must drop.
    const rows: Row[] = [
      ...Array.from({ length: 60 }, (_, i) => ({ playerId: "p", matchId: `new${i}`, score: 9 })),
      ...Array.from({ length: 5 }, (_, i) => ({ playerId: "p", matchId: `old${i}`, score: 1 })),
    ];
    const out = summariseClubDisplayRatings(["p"], rows, 60);
    expect(out.p.rating).toBe(9);
    expect(out.p.rating).toBe(
      clubDisplayRating({ clubSeedRating: null, clubPeerRatings: rows.slice(0, 60).map((r) => r.score) }),
    );
    // Games are every distinct game this club rated them in.
    expect(out.p.ratedGames).toBe(65);
  });

  it("ignores rows for players it was not asked about", () => {
    const out = summariseClubDisplayRatings(["a"], [{ playerId: "b", matchId: "m", score: 3 }], 60);
    expect(Object.keys(out)).toEqual(["a"]);
    expect(out.a.rating).toBeNull();
  });
});
