/**
 * "INVITE TO CLUB" ON THE GUEST CARD (slice L5b, 2026-10-24; made live in
 * L8). PURE.
 *
 * Approved spec, "Guest players in the app": the button shows for any guest
 * with at least one game with this club, however long ago, who is not yet a
 * member; it is greyed out if he stopped messages or deleted his profile.
 * The organiser's tap counts as the admins' yes; MatchTime then privately
 * asks the guest and sends the invite link only on his yes.
 *
 * L8 implements the action (`src/app/actions/club-invite.ts`, over
 * `club-invitation.ts`) and the page and match page pass it to the card.
 * The same tap answers a guest who asked to join after a game ("requested"):
 * then it is the club's yes that sends him the link.
 */
import type { PoolProfileStatus } from "./vocab";
import type { InvitationView } from "./club-invitation-rules";

/** Is the Invite to club button live? True since L8. */
export const CLUB_INVITE_LIVE = true;

/**
 * His pool profile as the rule needs it: "none" when he never had one (a
 * partner club's guest), "deleted" when he came through the pool and the
 * profile is gone, else its status.
 */
export type GuestPoolState = "none" | "deleted" | PoolProfileStatus;

/**
 *   hidden       no button: already a member, or no game played here yet.
 *   available    the organiser may invite him (an after-game question he
 *                has not answered yet included: the tap is the club's yes).
 *   requested    he asked to join after a game: the tap sends him the link,
 *                "Not now" closes it.
 *   invited      the club said yes, waiting for him.
 *   link-sent    both said yes, the link went; he has not joined yet.
 *   declined     greyed: he said no thanks lately.
 *   unavailable  greyed out: he stopped messages or deleted his profile.
 */
export type InviteToClubState = "hidden" | "available" | "requested" | "invited" | "link-sent" | "declined" | "unavailable";

export function inviteToClubState(g: {
  member: boolean;
  /** Games he PLAYED with this club, ever. */
  playedHere: number;
  invitation: InvitationView;
  pool: GuestPoolState;
}): InviteToClubState {
  if (g.member || g.playedHere < 1) return "hidden";
  if (g.invitation === "club-yes") return "invited";
  if (g.invitation === "accepted") return "link-sent";
  // His own yes is an answer to us, so it is honoured even after a stop.
  if (g.invitation === "player-yes") return "requested";
  if (g.pool === "stopped" || g.pool === "deleted") return "unavailable";
  if (g.invitation === "declined") return "declined";
  return "available";
}

/** What the action is given: the club, the guest; the actor is the session. */
export interface InviteToClubInput {
  orgId: string;
  userId: string;
  /** "no": the organisers' "Not now" to a guest who asked to join. */
  answer?: "yes" | "no";
}

export type InviteToClubResult =
  | { ok: true; state: InviteToClubState }
  | { ok: false; reason: "not-allowed" | "not-eligible" | "already-invited" | "no-link" | "failed" };

/**
 * The server action: checks the actor is an owner or admin of `orgId`,
 * re-checks `inviteToClubState` from the database (never trusting the
 * page), records the club's yes, and asks the guest privately (or, when he
 * asked first, sends him the link).
 */
export type InviteToClubAction = (input: InviteToClubInput) => Promise<InviteToClubResult>;
