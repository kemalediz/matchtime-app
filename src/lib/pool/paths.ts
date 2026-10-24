/**
 * The pool's pages (slice L2). CLIENT-SAFE. One place for the paths the
 * public-path list, the sidebar rule, the links in DMs and the pages share.
 */
export const POOL_PLAY_PATH = "/play";
export const POOL_MANAGE_PATH = "/play/manage";
/** My invitations (L8): his open club invitations and game offers. Needs his session. */
export const POOL_INVITATIONS_PATH = "/play/invitations";
/** The sign-up and venue-search API (public: the form posts to it). */
export const POOL_API_PREFIX = "/api/play/";

/** Is this one of the pool's own pages (no app sidebar, ever)? */
export function isPoolPage(pathname: string | null | undefined): boolean {
  return pathname === POOL_PLAY_PATH || !!pathname?.startsWith(`${POOL_PLAY_PATH}/`);
}
