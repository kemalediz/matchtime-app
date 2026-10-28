/**
 * The pool's pages (slice L2). CLIENT-SAFE. One place for the paths the
 * public-path list, the sidebar rule, the links in DMs and the pages share.
 */
export const POOL_PLAY_PATH = "/play";
/** The website's page for players (2026-10-25): what the pool is, then the
 *  button to /play. A marketing page, not one of the pool's own pages. */
export const PLAYERS_PAGE_PATH = "/players";
export const POOL_MANAGE_PATH = "/play/manage";
/** My invitations (L8): his open club invitations and game offers. Needs his session. */
export const POOL_INVITATIONS_PATH = "/play/invitations";
/** The sign-up and venue-search API (public: the form posts to it). */
export const POOL_API_PREFIX = "/api/play/";

/** The "Play elsewhere too" card on /profile, which the pool banner's
 *  "Join the pool" opens (2026-10-28). */
export const PLAY_ELSEWHERE_ANCHOR = "play-elsewhere";
export const PLAY_ELSEWHERE_PATH = `/profile#${PLAY_ELSEWHERE_ANCHOR}`;
/** Fired by the pool banner when "Join the pool" is tapped on /profile itself
 *  (a same-page hash link fires no hashchange). */
export const PLAY_ELSEWHERE_FOCUS_EVENT = "mt:play-elsewhere-focus";
/** "Tell your players about the player pool" on club settings. */
export const POOL_CLUB_SHARE_SETTINGS_PATH = "/admin/settings#pool-club-share";

/** Is this one of the pool's own pages (no app sidebar, ever)? */
export function isPoolPage(pathname: string | null | undefined): boolean {
  return pathname === POOL_PLAY_PATH || !!pathname?.startsWith(`${POOL_PLAY_PATH}/`);
}
