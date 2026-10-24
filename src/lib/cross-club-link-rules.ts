/**
 * Cross-club phone link: the pure rules (FNF incident 2026-10-18).
 *
 * An OWNER or ADMIN of club A types a phone number on one of A's players
 * on /admin/players, and the number already belongs to a MatchTime user
 * who is NOT a member of A (FNF's pasted "Habib" and Sutton Football
 * Club's Habib). Before this, the action threw and the admin saw the
 * redacted "Server Components render" error.
 *
 * Now MatchTime asks "same person?". On yes, club A's row is merged INTO
 * the existing account through `mergePlayersCore`. The existing account
 * keeps its id and its phone, and gains a membership of A.
 *
 * WHO MAY DO IT: any OWNER or ADMIN of club A (or a platform superadmin,
 * as for every org-admin check). The actor needs no role in the other
 * club. That is checked by the action, not here.
 *
 * THE RULES (each one is a refusal reason below):
 *
 *   - club A's player must be a member of A, and not a partner club's
 *     guest (a guest's number is not A's to set).
 *   - club A's player must belong to NO other club, and hold no rows in
 *     another club's matches. `mergePlayersCore` moves everything the
 *     dropped user has, so this is what guarantees that only club A's
 *     data and club A's membership are written.
 *   - club A's player must have no sign in of their own (an OAuth
 *     account, a session, a password, or a real email). Merging one in
 *     would graft a second login, or a different email, onto somebody
 *     else's account: an account takeover dressed up as a tidy-up.
 *   - the existing account must not be a platform superadmin.
 *   - the existing account's ROLE at its other club is never read and
 *     never written, so an admin or owner elsewhere is allowed: linking
 *     only adds a membership of A.
 *   - a different name is allowed. The admin is shown the other user's
 *     first name and confirms explicitly; that is the check.
 *
 * WHAT THE ADMIN MAY SEE: the other user's first name and the other
 * club's name, and nothing else (no rating, no phone beyond what they
 * typed, no history). On a refusal they see no name at all.
 *
 * A number whose owner is already in club A, or belongs to no club at
 * all, is "not-cross-club": the existing same-club paths handle it.
 */

import { isGuestMembership } from "@/lib/guest-membership";

export interface CrossClubLinkFacts {
  orgId: string;
  /** Club A's player, the row that is merged away. */
  drop: {
    id: string;
    /** Their membership of club A, or null when they have none. */
    membershipInOrg: { guestFromOrgId: string | null; guestMatchId?: string | null } | null;
    /** Membership rows (left ones included) at any club other than A. */
    otherClubMemberships: number;
    /** Attendance, ratings, MoM votes, team places, positions, aliases,
     *  messages, survey rows and squad-month rows tied to another club. */
    rowsOutsideOrg: number;
    hasOwnSignIn: boolean;
  };
  /** The user the number belongs to, or null when nobody holds it. */
  keep: {
    id: string;
    name: string | null;
    isSuperadmin: boolean;
    /** Any membership row of club A, left or guest ones included. */
    hasMembershipInOrg: boolean;
    /** Names of the clubs they are a member of, active ones first. */
    clubNames: string[];
  } | null;
}

export type CrossClubRefusal =
  | "keep_missing"
  | "same_user"
  | "drop_not_member"
  | "drop_guest"
  | "drop_other_clubs"
  | "drop_has_sign_in"
  | "keep_superadmin";

export type CrossClubLinkVerdict =
  | { kind: "not-cross-club" }
  | { kind: "offer"; firstName: string | null; clubNames: string[] }
  | { kind: "refuse"; reason: CrossClubRefusal };

export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** MatchTime's synthetic addresses (same test as `mergePlayersCore`'s). */
export function isPlaceholderEmail(e: string | null | undefined): boolean {
  return !e || /@placeholder\.matchtime$|@matchtime\.local$/i.test(e);
}

export function decideCrossClubLink(f: CrossClubLinkFacts): CrossClubLinkVerdict {
  const { drop, keep } = f;
  if (!keep) return { kind: "refuse", reason: "keep_missing" };
  if (keep.id === drop.id) return { kind: "refuse", reason: "same_user" };
  if (keep.hasMembershipInOrg) return { kind: "not-cross-club" };
  const clubNames = [...new Set(keep.clubNames.filter((n) => n && n.trim()))];
  if (clubNames.length === 0) return { kind: "not-cross-club" };

  if (!drop.membershipInOrg) return { kind: "refuse", reason: "drop_not_member" };
  // A guest of either kind (partner or pool) is not club A's to link.
  if (isGuestMembership(drop.membershipInOrg)) return { kind: "refuse", reason: "drop_guest" };
  if (drop.otherClubMemberships > 0 || drop.rowsOutsideOrg > 0) {
    return { kind: "refuse", reason: "drop_other_clubs" };
  }
  if (drop.hasOwnSignIn) return { kind: "refuse", reason: "drop_has_sign_in" };
  if (keep.isSuperadmin) return { kind: "refuse", reason: "keep_superadmin" };

  return { kind: "offer", firstName: firstNameOf(keep.name), clubNames };
}
