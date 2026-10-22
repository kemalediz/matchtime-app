/**
 * A PARTNER GUEST'S STANDING AT HIS OWN CLUB, read from the database
 * (Kemal, 2026-10-22, option C). The rules and the words are in
 * `partner-guest-standing-rules.ts`; this reads, for each guest, his OWN
 * club's ratings and nothing else:
 *
 *   - his club's current ordinary members (not left, not guests there);
 *   - their ratings given IN THAT CLUB (the org filter sits next to the
 *     player filter, as in `loadClubDisplayRatings`), each member's shown
 *     club rating over the same 60-rating window players see;
 *   - whether that club shares its players' ratings with partner clubs.
 *
 * Never compares across clubs, never returns another player's name or
 * number: only his band, and his own number when his club shares it.
 * Never throws: a failed read leaves him out of the map, and the caller
 * shows his club's name alone, as before.
 */
import { db } from "./db";
import { summariseClubDisplayRatings } from "./player-rating";
import { standingBand, type GuestStanding } from "./partner-guest-standing-rules";

/** The window players see (player-stats.ts `CLUB_RATING_WINDOW`). */
const CLUB_RATING_WINDOW = 60;

export async function loadGuestStandings(guests: ReadonlyArray<{ userId: string; homeOrgId: string }>): Promise<Map<string, GuestStanding>> {
  const out = new Map<string, GuestStanding>();
  if (guests.length === 0) return out;
  try {
    const homeIds = [...new Set(guests.map((g) => g.homeOrgId))];
    const [orgs, members] = await Promise.all([
      db.organisation.findMany({ where: { id: { in: homeIds } }, select: { id: true, name: true, sharePlayerRatingsWithPartners: true } }),
      db.membership.findMany({ where: { orgId: { in: homeIds }, leftAt: null, guestFromOrgId: null }, select: { userId: true, orgId: true } }),
    ]);
    for (const org of orgs) {
      const mine = guests.filter((g) => g.homeOrgId === org.id);
      const poolIds = [...new Set([...members.filter((m) => m.orgId === org.id).map((m) => m.userId), ...mine.map((g) => g.userId)])];
      const rows = await db.rating.findMany({
        where: { playerId: { in: poolIds }, match: { activity: { orgId: org.id } } },
        orderBy: { createdAt: "desc" },
        select: { playerId: true, matchId: true, score: true },
      });
      const shown = summariseClubDisplayRatings(poolIds, rows, CLUB_RATING_WINDOW);
      for (const g of mine) {
        const own = shown[g.userId]?.rating ?? null;
        const others = poolIds
          .filter((id) => id !== g.userId)
          .map((id) => shown[id]?.rating ?? null)
          .filter((r): r is number => r !== null);
        const band = standingBand(own, others);
        out.set(g.userId, {
          club: org.name,
          band,
          rating: org.sharePlayerRatingsWithPartners === true && own !== null ? own : null,
        });
      }
    }
  } catch (err) {
    console.error("[partner-guest] standing not read:", err instanceof Error ? err.message : "failed");
    return new Map();
  }
  return out;
}
