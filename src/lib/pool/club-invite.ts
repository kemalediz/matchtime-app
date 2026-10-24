/**
 * "INVITE TO CLUB" ON THE GUEST CARD (slice L5b, 2026-10-24). PURE.
 *
 * Approved spec, "Guest players in the app": the button shows for any guest
 * with at least one game with this club, however long ago, who is not yet a
 * member; it is greyed out if he stopped messages or deleted his profile.
 * The organiser's tap counts as the admins' yes; MatchTime then privately
 * asks the guest and sends the invite link only on his yes.
 *
 * L5b owns the rule and the button's states. Sending the invitation is
 * slice L8 (`ClubInvitation`, origin "organiser"): L8 writes a server action
 * of type `InviteToClubAction` and passes it to the card. Until then the
 * page passes none, so the button is not rendered (`CLUB_INVITE_LIVE`).
 */
import type { PoolProfileStatus } from "./vocab";

/** Is the Invite to club button live? False until L8 ships the action. */
export const CLUB_INVITE_LIVE = false;

/**
 * His pool profile as the rule needs it: "none" when he never had one (a
 * partner club's guest), "deleted" when he came through the pool and the
 * profile is gone, else its status.
 */
export type GuestPoolState = "none" | "deleted" | PoolProfileStatus;

/**
 *   hidden       no button: already a member, or no game played here yet.
 *   available    the organiser may invite him.
 *   invited      an invitation to this club is open, waiting for him.
 *   unavailable  greyed out: he stopped messages or deleted his profile.
 */
export type InviteToClubState = "hidden" | "available" | "invited" | "unavailable";

export function inviteToClubState(g: {
  member: boolean;
  /** Games he PLAYED with this club, ever. */
  playedHere: number;
  openInvitation: boolean;
  pool: GuestPoolState;
}): InviteToClubState {
  if (g.member || g.playedHere < 1) return "hidden";
  if (g.openInvitation) return "invited";
  if (g.pool === "stopped" || g.pool === "deleted") return "unavailable";
  return "available";
}

/** What L8's action is given: the club, the guest; the actor is the session. */
export interface InviteToClubInput {
  orgId: string;
  userId: string;
}

export type InviteToClubResult = { ok: true } | { ok: false; reason: "not-allowed" | "not-eligible" | "already-invited" | "failed" };

/**
 * The seam slice L8 implements: a server action that checks the actor is an
 * owner or admin of `orgId`, re-checks `inviteToClubState` from the database
 * (never trusting the page), records the club's yes as an "organiser"
 * `ClubInvitation`, and asks the guest privately.
 */
export type InviteToClubAction = (input: InviteToClubInput) => Promise<InviteToClubResult>;
