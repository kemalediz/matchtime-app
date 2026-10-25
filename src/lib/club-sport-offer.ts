/**
 * Which of a club's own Sport rows a NEW weekly game may use: a live sport
 * (`LIVE_SPORTS`, src/lib/pool/sports.ts), or one the club already plays, so
 * an existing club keeps its sport. The rule is `isOfferedClubSport`; this
 * file only reads the rows. The admin activities picker (/api/sports) and the
 * actions behind it (createActivity, updateActivity) share it.
 */
import { db } from "./db";
import { isOfferedClubSport } from "./pool/sports";

export const SPORT_NOT_OFFERED = "That sport is not offered yet.";

/** The club's sports a new weekly game may use, by name. */
export async function offeredClubSports(orgId: string) {
  const [sports, games] = await Promise.all([
    db.sport.findMany({ where: { orgId }, orderBy: { name: "asc" } }),
    db.activity.findMany({ where: { orgId }, select: { sportId: true } }),
  ]);
  const inUse = new Set(games.map((g) => g.sportId));
  return sports.filter((s) => isOfferedClubSport(s, { inUse: inUse.has(s.id) }));
}

/** Throws unless `sportId` is this club's and offered for a new weekly game. */
export async function assertSportOfferedForGame(orgId: string, sportId: string): Promise<void> {
  const sport = await db.sport.findFirst({ where: { id: sportId, orgId } });
  if (!sport) throw new Error("Sport not found in this organisation");
  if (isOfferedClubSport(sport)) return;
  const played = await db.activity.findFirst({ where: { orgId, sportId }, select: { id: true } });
  if (!played) throw new Error(SPORT_NOT_OFFERED);
}
