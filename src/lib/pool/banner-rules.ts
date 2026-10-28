/**
 * THE PLAYER POOL BANNER, the pure rule (approved by Kemal 2026-10-28).
 * CLIENT-SAFE. One line at the top of every signed-in app page:
 *
 *   join    a member of a club with the pool open who is not in the pool
 *           yet (no profile, or a sign-up still waiting for its WhatsApp
 *           message): "Want more games? Join the MatchTime player pool."
 *   share   in the pool (active or paused, the same rule as the "Bring a
 *           friend" card, `shareCardShown`): "Know someone who wants a
 *           game? Share your link."
 *
 * Nothing at all for:
 *   - somebody who is not an ordinary member of at least one club whose
 *     pool is open (the platform switch AND the club's flag,
 *     `poolOffersOpenForClub`): guests and pool-only profiles included;
 *   - somebody who left the pool ("stopped"): he withdrew his consent, so
 *     this page never asks him back;
 *   - the dismissal columns not readable (the migration not applied yet).
 *
 * "Not interested" is stored per banner on his user row, so dismissing
 * join and joining later still shows share once. The admin line ("Tell
 * your players about it") rides on whichever banner shows.
 */
import type { PoolProfileStatus } from "./vocab";
import { isPoolPage } from "./paths";

export type PoolBannerKind = "join" | "share";

export interface PoolBannerFacts {
  /** Both dismissal columns could be read (false before the migration). */
  dismissalsReadable: boolean;
  /** An ordinary, current member of at least one club with the pool open. */
  memberOfOpenClub: boolean;
  /** His pool profile's status; null when he has none. */
  poolStatus: PoolProfileStatus | null;
  joinDismissedAt: Date | null;
  shareDismissedAt: Date | null;
  /** His personal /play?ref= link could be made. */
  hasShareLink: boolean;
  /** Owner or admin of his current club, whose pool is open and which has
   *  not sent "Tell your players about the player pool". */
  adminOfOpenClubNotShared: boolean;
}

export interface PoolBannerChoice {
  kind: PoolBannerKind;
  adminLine: boolean;
}

export function poolBannerFor(f: PoolBannerFacts): PoolBannerChoice | null {
  if (!f.dismissalsReadable || !f.memberOfOpenClub) return null;
  let kind: PoolBannerKind | null;
  if (f.poolStatus === "active" || f.poolStatus === "paused") kind = f.hasShareLink && !f.shareDismissedAt ? "share" : null;
  else if (f.poolStatus === "stopped") kind = null;
  else kind = f.joinDismissedAt ? null : "join";
  return kind ? { kind, adminLine: f.adminOfOpenClubNotShared } : null;
}

/** Pages that are public, the pool's own, sign-in, setup or payment. */
const HIDDEN_ROOTS = ["/login", "/signup", "/verify-email", "/claim", "/welcome", "/r", "/join", "/onboarding", "/create-org", "/finish-setup", "/pay", "/collect", "/billing", "/help", "/privacy", "/players", "/pricing"] as const;

/**
 * Does this page carry the banner? Only the signed-in app's pages (the
 * caller checks he is signed in; "/" is then his dashboard).
 */
export function poolBannerPathShown(pathname: string | null | undefined): boolean {
  if (!pathname || isPoolPage(pathname)) return false;
  return !HIDDEN_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}
