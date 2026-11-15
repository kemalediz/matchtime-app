/**
 * Loads /play's game line, and the club's offer under it, for a campaign
 * code (2026-11-11; offer 2026-11-13). SERVER ONLY. The rule and the map
 * of codes to clubs are `campaign-game-line.ts`.
 *
 * The code must be a LIVE campaign (`PoolCampaign.active`), the rule its
 * visits and sign-ups are counted by (`visits.ts`, `signup.ts`): a code
 * switched off, or with no row, counts as direct there, so it names no game
 * and no offer here (review, 2026-11-15).
 *
 * The match is the club's next LIVE one that has not kicked off: upcoming,
 * or with its teams made or published (`OPEN_MATCH_STATUSES`, the set every
 * live-match check uses; UPCOMING alone jumped to next week's game on the
 * day teams were made, 2026-11-15). A co-timed ghost from a format switch
 * loses to the lower id, as in `next-upcoming-match.ts`; its open places
 * are `askPlacesOpen`, the count every ask uses (a running month's week
 * counts its own way). Only that match: when it is full the line is gone,
 * the week after is not offered.
 */
import { db } from "../db";
import type { Lang } from "../i18n/lang";
import { askPlacesOpen } from "../monthly-week-asks";
import { campaignGameClub, campaignGameForClub, type CampaignGame } from "./campaign-game-line";
import { OPEN_MATCH_STATUSES } from "./matching-rules";

export async function loadCampaignGame(code: string | null, lang: Lang, now: Date = new Date()): Promise<CampaignGame | null> {
  const club = campaignGameClub(code);
  if (!club || !code) return null;
  const campaign = await db.poolCampaign.findFirst({ where: { code, active: true }, select: { code: true } });
  if (!campaign) return null;
  const match = await db.match.findFirst({
    where: { activity: { orgId: club.orgId, org: { dormantAt: null } }, status: { in: [...OPEN_MATCH_STATUSES] }, isHistorical: false, date: { gt: now } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    select: { id: true, date: true, maxPlayers: true, activity: { select: { venue: true } } },
  });
  if (!match) return null;
  const placesOpen = await askPlacesOpen(match.id);
  return campaignGameForClub({ club, match: { date: match.date, maxPlayers: match.maxPlayers, venue: match.activity.venue, placesOpen }, now, lang });
}
