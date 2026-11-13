/**
 * THE GAME A FACEBOOK LINK SELLS, named at the top of /play (2026-11-11).
 * CLIENT-SAFE and pure: no clock, no database.
 *
 * The Facebook posts (`?src=fb`, `fb1`, `fb2`) sell one real game: Sutton
 * FC's Tuesday 7-a-side at Goals North Cheam. /play said only "Join the
 * player pool", so the game the post promised was gone the moment the page
 * opened (10 Nov: 16 opens, 1 started form). Now the page names it:
 * "Tuesday 7-a-side in Sutton: Tue 17 Nov, 9:30pm, Goals North Cheam".
 *
 * The line rolls weekly by itself: every part comes from the club's next
 * upcoming match (`campaign-game-line-loader.ts`), never a typed date. It
 * shows only while that game is real for a stranger: kicking off within
 * {@link CAMPAIGN_GAME_WINDOW_DAYS} days with a place free. Full, too far
 * off, or no match: no line, never a promise of a place that is not there.
 *
 * Which club a code sells is the small map below, in code, not
 * `PoolCampaign.orgId`: that column means "the club whose own share post
 * this is" (source "club", `campaigns.ts`), and the Facebook rows are
 * MatchTime's posts about one club's game. The map also carries the area
 * the post names, because nothing stored says "Sutton" for this club
 * (`Organisation.town` is null, and is a WhatsApp-number slug anyway).
 *
 * Nextdoor (`?src=nd`, 2026-11-13) sells the same game. Each club entry
 * also says whether its first game is free for newcomers; Sutton FC's is
 * (permanent), so under its line /play says "First game free for new
 * players". The offer comes only with the line: no line, no offer.
 */
import { templateTimeLabel } from "../club-graphics-layout";
import { dayLabel, weekdayLabel } from "../i18n/dates";
import { flexFormatCopy } from "../i18n/flex-format";
import type { Lang } from "../i18n/lang";
import { poolPageCopy } from "./page-copy";

/** The club a campaign code sells a game of. */
export interface CampaignGameClub {
  orgId: string;
  /** The area the posts name. */
  area: string;
  /** The club gives a newcomer's first game free (Sutton FC, permanent
   *  since 2026-11-12), so /play says so under the game line. A club
   *  without the offer gets the line and no offer: the page never implies
   *  another club's games are free. */
  firstGameFree: boolean;
}

/** Sutton Football Club (production org id). */
const SUTTON_FC: CampaignGameClub = Object.freeze({ orgId: "cmnnwhdx30000zfr85q18lyy9", area: "Sutton", firstGameFree: true });

/** Campaign code to the club whose game its posts sell: the Facebook posts
 *  (fb, fb1, fb2) and Nextdoor (nd, 2026-11-13). */
const CAMPAIGN_GAME_CLUBS: Readonly<Record<string, CampaignGameClub>> = Object.freeze({
  fb: SUTTON_FC,
  fb1: SUTTON_FC,
  fb2: SUTTON_FC,
  nd: SUTTON_FC,
});

/** How far ahead a game may be and still be named. */
export const CAMPAIGN_GAME_WINDOW_DAYS = 8;
const WINDOW_MS = CAMPAIGN_GAME_WINDOW_DAYS * 24 * 3600_000;

/** The club a campaign code's posts sell a game of, or null. Codes arrive
 *  lowercased (`readSignupSource`). */
export function campaignGameClub(code: string | null | undefined): CampaignGameClub | null {
  if (!code || !Object.hasOwn(CAMPAIGN_GAME_CLUBS, code)) return null;
  const club = CAMPAIGN_GAME_CLUBS[code];
  return { orgId: club.orgId, area: club.area, firstGameFree: club.firstGameFree };
}

/** The club's next upcoming match, as the line needs it. */
export interface CampaignGameMatch {
  date: Date;
  /** The match's own size (`Match.maxPlayers`); half of it is the format. */
  maxPlayers: number;
  /** The club's name for the venue (`Activity.venue`). */
  venue: string;
  /** Places not yet taken (`askPlacesOpen`). */
  placesOpen: number;
}

/** What /play shows for the game: the line, and under it the club's offer
 *  (null when the club has none). */
export interface CampaignGame {
  line: string;
  offer: string | null;
}

type GameArgs = { match: CampaignGameMatch | null; now: Date; lang: Lang };

/**
 * The game for a club, or null when the game is not one a stranger can join
 * now: no club, no match, kicked off, more than 8 days away, full, or no
 * venue to name. The offer never shows without the line.
 */
export function campaignGameForClub(a: GameArgs & { club: CampaignGameClub | null }): CampaignGame | null {
  const { club, match: m } = a;
  if (!club || !m) return null;
  const ahead = m.date.getTime() - a.now.getTime();
  if (ahead <= 0 || ahead > WINDOW_MS) return null;
  if (m.placesOpen <= 0) return null;
  const venue = m.venue.trim();
  const perSide = Math.floor(m.maxPlayers / 2);
  if (!venue || perSide < 1) return null;
  const copy = poolPageCopy(a.lang).signup;
  const line = copy.gameLine({
    weekday: weekdayLabel(a.lang, m.date),
    format: flexFormatCopy(a.lang).side(perSide),
    area: club.area,
    day: dayLabel(a.lang, m.date),
    time: templateTimeLabel(a.lang, m.date),
    venue,
  });
  return { line, offer: club.firstGameFree ? copy.firstGameFree : null };
}

/** The game a campaign code sells, or null (see {@link campaignGameForClub}). */
export function campaignGame(a: GameArgs & { code: string | null }): CampaignGame | null {
  return campaignGameForClub({ ...a, club: campaignGameClub(a.code) });
}

/** Just the line of {@link campaignGame}. */
export function campaignGameLine(a: GameArgs & { code: string | null }): string | null {
  return campaignGame(a)?.line ?? null;
}
