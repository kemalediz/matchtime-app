/**
 * Loads /play's game line, and the club's offer under it, for a campaign
 * code (2026-11-11; offer 2026-11-13). SERVER ONLY. The rule and the map
 * of codes to clubs are `campaign-game-line.ts`.
 *
 * The code must be a LIVE campaign: a `PoolCampaign` row with that code,
 * switched on. That is the campaign half of how /play's visits and sign-ups
 * are attributed (`visits.ts` pageStepBucket, `signup.ts` resolveSource),
 * which there comes after a friend's share code; a code switched off, or
 * with no row, counts as direct there, so here it names no game and no
 * offer (review, 2026-11-15).
 *
 * The match is the club's next LIVE one that has not kicked off: upcoming,
 * or with its teams made or published (`OPEN_MATCH_STATUSES`; UPCOMING
 * alone jumped to next week's game on the day teams were made,
 * 2026-11-15). A co-timed ghost from a format switch loses to the lower id.
 * Only that match, and only while the bot would treat it as the next game
 * and a new player could still be asked for it:
 *   - `isNextUpcomingForPosting` with the clock, the bot's own gate: an
 *     earlier game of the fixture still live (tonight's, kicked off but
 *     not yet completed) holds it, and so does a game of the fixture
 *     cancelled whose London day is not over (rule 3), so a cancelled
 *     Tuesday does not put next Tuesday's game on the page that same day;
 *   - before the club's pool cut-off (`poolAskCutoffOf`, the instant from
 *     which the ask round refuses a new ask), since past it nobody who
 *     signs up now can be offered the game.
 * Its open places are `askPlacesOpen`, the count every ask uses (a running
 * month's week counts its own way). When the match is full or past its
 * cut-off the line is gone; the week after is not offered.
 *
 * The candidate matches are the org's from two days back, as the partner
 * ask's own next-match check reads them (`partner-ask.ts` isNextMatch).
 */
import { db } from "../db";
import type { Lang } from "../i18n/lang";
import { askPlacesOpen } from "../monthly-week-asks";
import { isNextUpcomingForPosting } from "../next-upcoming-match";
import { campaignGameClub, campaignGameForClub, type CampaignGame } from "./campaign-game-line";
import { OPEN_MATCH_STATUSES } from "./matching-rules";
import { poolAskCutoffOf } from "./round";

const LOOKBACK_MS = 2 * 24 * 3600_000;
const LIVE: ReadonlySet<string> = new Set(OPEN_MATCH_STATUSES);

export async function loadCampaignGame(code: string | null, lang: Lang, now: Date = new Date()): Promise<CampaignGame | null> {
  const club = campaignGameClub(code);
  if (!club || !code) return null;
  const campaign = await db.poolCampaign.findFirst({ where: { code, active: true }, select: { code: true } });
  if (!campaign) return null;
  const candidates = await db.match.findMany({
    where: { activity: { orgId: club.orgId, org: { dormantAt: null } }, isHistorical: false, date: { gte: new Date(now.getTime() - LOOKBACK_MS) } },
    select: {
      id: true,
      date: true,
      status: true,
      activityId: true,
      isHistorical: true,
      maxPlayers: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true } },
    },
  });
  const match = candidates
    .filter((m) => LIVE.has(m.status) && m.date.getTime() > now.getTime())
    .sort((a, b) => a.date.getTime() - b.date.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  if (!match || !isNextUpcomingForPosting(candidates, match, now)) return null;
  if (now.getTime() >= (await poolAskCutoffOf(club.orgId, match.date)).getTime()) return null;
  const placesOpen = await askPlacesOpen(match.id);
  return campaignGameForClub({ club, match: { date: match.date, maxPlayers: match.maxPlayers, venue: match.activity.venue, placesOpen }, now, lang });
}
