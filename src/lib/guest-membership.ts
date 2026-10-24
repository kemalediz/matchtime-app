/**
 * WHO IS A GUEST: the one definition (local player pool, slice L5a, 2026-10-24).
 *
 * A `Membership` row can be a guest's: a person given a one-off place in a
 * club's match without joining the club. Two kinds exist:
 *
 *   - a PARTNER guest (cross-club ask, 2026-10-16): `guestVia` "partner" (or
 *     NULL on rows written before the pool), `guestFromOrgId` = his home
 *     club, `guestMatchId` = the match;
 *   - a POOL guest (local player pool, 2026-10-24): `guestVia` "pool",
 *     `guestFromOrgId` NULL (he has no home club), `guestMatchId` set.
 *
 * The CHECK "Membership_guest_check" (prisma/sql/partner-ask-check.sql) is:
 *
 *   guestVia NULL      => (guestFromOrgId NULL) = (guestMatchId NULL)
 *   guestVia 'partner' => guestFromOrgId set AND guestMatchId set
 *   guestVia 'pool'    => guestFromOrgId NULL AND guestMatchId set
 *
 * So for every row that can exist, `guestMatchId IS NOT NULL` <=> "this row
 * is a guest (current, or past with `leftAt` set; partner or pool)". That
 * column, and ONLY that column, answers "is this an ordinary member?".
 *
 * `guestFromOrgId` must NOT be used for that question: it is NULL on a pool
 * guest, so `guestFromOrgId: null` would count a pool guest as a member (club
 * access, rosters, club size, an organiser seeing his phone number). It stays
 * the right column only for logic that genuinely needs the HOME club (partner
 * standings, the partner-guest DM, the "lent out" account rule). The source
 * guard `src/lib/__tests__/guest-membership-source-guard.test.ts` keeps it so.
 *
 * Pure: no db import, safe for client components and rules modules.
 */

/** Prisma `where` fragment: an ordinary (non-guest) membership. */
export const ORDINARY_MEMBER_WHERE = { guestMatchId: null } as const;

/** Prisma `where` fragment: any guest membership (partner or pool, current or past). */
export const GUEST_MEMBER_WHERE = { guestMatchId: { not: null } } as const;

export type GuestMarks = {
  guestMatchId?: string | null;
  guestFromOrgId?: string | null;
  guestVia?: string | null;
};

/** True for a guest row of either kind. Reads `guestMatchId`, with
 *  `guestFromOrgId` as a belt-and-braces fallback (a partner row always has
 *  both, so a caller that selected only the home club still answers right). */
export function isGuestMembership(m: GuestMarks | null | undefined): boolean {
  if (!m) return false;
  return !!m.guestMatchId || !!m.guestFromOrgId || m.guestVia === "pool" || m.guestVia === "partner";
}

export type GuestSource = "partner" | "pool";

/** A PARTNER guest's home club id; null for a pool guest and a member. The
 *  one accessor for logic that genuinely needs the home club. */
export function partnerHomeClubOf(m: GuestMarks | null | undefined): string | null {
  return m?.guestFromOrgId ?? null;
}

/** Where this guest came from, or null for an ordinary member. */
export function guestSourceOf(m: GuestMarks | null | undefined): GuestSource | null {
  if (!m) return null;
  if (m.guestFromOrgId || m.guestVia === "partner") return "partner";
  if (m.guestMatchId || m.guestVia === "pool") return "pool";
  return null;
}
