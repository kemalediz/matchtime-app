/**
 * Loads /play's game line for a campaign code (2026-11-11). SERVER ONLY.
 * The rule and the map of codes to clubs are `campaign-game-line.ts`.
 *
 * The match is the club's next UPCOMING one that has not kicked off (a
 * co-timed ghost from a format switch loses to the lower id, as in
 * `next-upcoming-match.ts`); its open places are `askPlacesOpen`, the count
 * every ask uses (a running month's week counts its own way). Only that
 * match: when it is full the line is gone, the week after is not offered.
 */
import { db } from "../db";
import type { Lang } from "../i18n/lang";
import { askPlacesOpen } from "../monthly-week-asks";
import { campaignGameClub, campaignGameLine } from "./campaign-game-line";

export async function loadCampaignGameLine(code: string | null, lang: Lang, now: Date = new Date()): Promise<string | null> {
  const club = campaignGameClub(code);
  if (!club) return null;
  const match = await db.match.findFirst({
    where: { activity: { orgId: club.orgId, org: { dormantAt: null } }, status: "UPCOMING", isHistorical: false, date: { gt: now } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    select: { id: true, date: true, maxPlayers: true, activity: { select: { venue: true } } },
  });
  if (!match) return null;
  const placesOpen = await askPlacesOpen(match.id);
  return campaignGameLine({ code, match: { date: match.date, maxPlayers: match.maxPlayers, venue: match.activity.venue, placesOpen }, now, lang });
}
