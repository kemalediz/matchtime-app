/**
 * MAY MATCHTIME BRING THIS PERSON INTO THIS CLUB'S GAMES AS A GUEST?
 * (Kemal, 2026-10-31.)
 *
 * Two doors bring a person who is not a member into a club's match: a
 * player pool offer (`pool/candidate-rows.ts`, read by the matching rules
 * as `blocked`) and a member's friend link (`friend-link/book.ts`, refused
 * with the neutral "blocked" reason). Both are shut, for THAT club only, by:
 *
 *   - a PoolBlock with the club (each door reads the side it always read:
 *     the pool either way, the friend link the club's own block or a
 *     MatchTime pause), and
 *   - an organiser having REMOVED him from the club
 *     (`Membership.removedByOrganiserAt`, stamped by the players page
 *     Remove). A person who left the WhatsApp group himself only has
 *     `leftAt`, and comes back as a guest as he always could.
 *
 * The removal stops counting while he is a live ordinary member of the
 * club again (the club has him back, and the guest doors are not his). An
 * organiser re-adding him, or adding him to a match, clears the stamp
 * (`app/actions/players.ts`); a guest placement never touches it.
 *
 * Pure: no db import.
 */
import { isGuestMembership, type GuestMarks } from "./guest-membership";

export interface GuestDoorMembership extends GuestMarks {
  leftAt: Date | null;
  removedByOrganiserAt: Date | null;
}

/** Prisma `select` for the membership fields this rule reads. */
export const GUEST_DOOR_SELECT = {
  leftAt: true,
  removedByOrganiserAt: true,
  guestMatchId: true,
  guestFromOrgId: true,
  guestVia: true,
} as const;

/** An organiser took him off this club, and the club has not had him back
 *  as a member since. */
export function removedByOrganiser(m: GuestDoorMembership | null | undefined): boolean {
  if (!m?.removedByOrganiserAt) return false;
  const liveMember = m.leftAt === null && !isGuestMembership(m);
  return !liveMember;
}

/** True when neither door may bring him into this club's games. */
export function guestDoorShut(f: { blocked: boolean; membership: GuestDoorMembership | null | undefined }): boolean {
  return f.blocked || removedByOrganiser(f.membership);
}
