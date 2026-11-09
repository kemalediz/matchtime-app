/**
 * The reads behind a carried seed (`carried-seed.ts`): each player's
 * shown club rating at every club that has rated him, and how many games
 * each club rated him in. One query for any number of players.
 *
 * Takes the Prisma client as an argument instead of importing `db`,
 * because `db.ts` itself calls this from inside its membership-create
 * hook and must hand it the BASE client (a read through the extended
 * client would be harmless, but importing `db` here would be a cycle).
 *
 * The 60-rating window and the arithmetic are the ones players see
 * (`summariseClubDisplayRatings`, `CLUB_RATING_WINDOW`), per club, so a
 * carried number is exactly the club rating the player has there.
 * A cancelled match's ratings never count (`NOT_CANCELLED`).
 */
import { NOT_CANCELLED } from "./played-match";
import { CLUB_RATING_WINDOW, summariseClubDisplayRatings } from "./player-rating";
import { carriedSeed, type CarriedSeed, type OtherClubRating } from "./carried-seed";

export interface CarriedSeedRatingRow {
  playerId: string;
  matchId: string;
  score: number;
  match: { activity: { orgId: string } };
}

/** The slice of a Prisma client this needs. */
export interface CarriedSeedClient {
  rating: {
    findMany(args: {
      where: object;
      orderBy: { createdAt: "desc" };
      select: object;
    }): Promise<CarriedSeedRatingRow[]>;
  };
}

/**
 * Every listed player's club rating at every club that rated him, keyed
 * by player then club. A player no club has rated has no entry.
 *
 * `asOf` counts only ratings given up to that moment, so a seed carried
 * on a past day can be recomputed as it was then
 * (`scripts/_tmp-recompute-carried-seeds.ts`). Joins never pass it.
 */
export async function loadClubRatingsByClub(
  client: CarriedSeedClient,
  userIds: readonly string[],
  asOf?: Date,
): Promise<Map<string, OtherClubRating[]>> {
  const out = new Map<string, OtherClubRating[]>();
  if (userIds.length === 0) return out;
  const rows = await client.rating.findMany({
    where: { playerId: { in: [...userIds] }, match: { ...NOT_CANCELLED }, ...(asOf ? { createdAt: { lte: asOf } } : {}) },
    orderBy: { createdAt: "desc" },
    select: { playerId: true, matchId: true, score: true, match: { select: { activity: { select: { orgId: true } } } } },
  });
  const byClub = new Map<string, CarriedSeedRatingRow[]>();
  for (const r of rows) {
    const orgId = r.match.activity.orgId;
    const list = byClub.get(orgId) ?? [];
    list.push(r);
    byClub.set(orgId, list);
  }
  for (const [orgId, clubRows] of byClub) {
    const ids = [...new Set(clubRows.map((r) => r.playerId))];
    const shown = summariseClubDisplayRatings(ids, clubRows, CLUB_RATING_WINDOW);
    for (const id of ids) {
      const list = out.get(id) ?? [];
      list.push({ orgId, rating: shown[id].rating, ratedGames: shown[id].ratedGames });
      out.set(id, list);
    }
  }
  return out;
}

/** The ratings of every club except `excludeOrgId`. */
export function otherClubs(all: readonly OtherClubRating[] | undefined, excludeOrgId: string | null): OtherClubRating[] {
  return (all ?? []).filter((c) => c.orgId !== excludeOrgId);
}

/** The seed one player carries into `orgId`, or null for none. */
export async function loadCarriedSeed(
  client: CarriedSeedClient,
  userId: string,
  orgId: string | null,
): Promise<CarriedSeed | null> {
  const all = await loadClubRatingsByClub(client, [userId]);
  return carriedSeed(otherClubs(all.get(userId), orgId));
}
