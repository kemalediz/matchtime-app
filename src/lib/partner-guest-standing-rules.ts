/**
 * A PARTNER GUEST'S STANDING AT HIS OWN CLUB (Kemal, 2026-10-22, option C).
 *
 * When a player of one club volunteers for a partner club's ask, the
 * asking club's organisers decide whether to take him. They are told how
 * good he is at HIS club, never against theirs (ratings are club-scoped,
 * and two clubs rate on their own scales):
 *
 *   always    his band among his own club's rated players, in thirds;
 *   opt-in    his own club rating (the raw number he sees there), only when
 *             HIS club has "Share our players' ratings with partner clubs"
 *             on (`Organisation.sharePlayerRatingsWithPartners`).
 *
 * THE POOL (`loadGuestStandings` builds it): his club's current ordinary
 * members (not left, not guests there) with a shown club rating, that is at
 * least one rated game (`clubDisplayRating`: the raw mean of that club's
 * ratings, never the seed, never the balancer's shrunk figure). One game is
 * enough because the band is a coarse third, and a stricter pool would band
 * nobody at a young club (FNF on 2026-10-22: 18 rated members, every one
 * of them with one rated game). He is always in his own pool.
 *
 * THE BAND. n = the pool, him included; `above` = the players rated
 * strictly higher than him. Top third while above < n/3, middle third
 * while above < 2n/3, else bottom third. A tie counts in his favour (only a
 * strictly higher rating ranks above him). Below `STANDING_MIN_POOL` rated
 * players a third means nothing ("top third of two"), so the band is
 * "too-few". No rating at his club: "unrated".
 *
 * PURE and client-safe. Never sees a name: only numbers.
 */
import { t } from "./i18n/t";

export type StandingBand = "top" | "middle" | "bottom" | "too-few" | "unrated";

/** The fewest rated players (him included) a band is given for. */
export const STANDING_MIN_POOL = 5;

/** His band. `guest` is his club rating there, or null; `others` the club
 *  ratings of the rest of the pool. */
export function standingBand(guest: number | null, others: readonly number[]): StandingBand {
  if (guest === null) return "unrated";
  const n = others.length + 1;
  if (n < STANDING_MIN_POOL) return "too-few";
  const above = others.filter((r) => r > guest).length;
  if (above < n / 3) return "top";
  if (above < (2 * n) / 3) return "middle";
  return "bottom";
}

export interface GuestStanding {
  /** His own club's name. */
  club: string;
  band: StandingBand;
  /** His club rating there, ONLY when his club shares ratings and he has
   *  one. Null otherwise. */
  rating: number | null;
}

/** "Friday MT Community, top third there[, rated 7.4]", in the language of
 *  the club that reads it (the asking club). A number shows only with a
 *  band from a real rating: never for an unrated player. */
export function standingPhrase(lang: string | null | undefined, s: GuestStanding): string {
  return t(lang).xask_guest_standing({
    club: s.club,
    band: s.band,
    rating: s.band === "unrated" || s.rating === null ? null : s.rating.toFixed(1),
  });
}
