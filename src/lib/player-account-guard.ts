/**
 * WHO MAY CHANGE A PLAYER'S NUMBER OR NAME (2026-10-18, security fix).
 *
 * A phone number is a sign-in on MatchTime: `verifyPhoneSignIn` finds the
 * user by `User.phoneNumber` and signs them in, and every rating or sign-in
 * link MatchTime DMs goes to that number. `User.phoneNumber` and
 * `User.name` are GLOBAL: one row per person, shared by every club they
 * play at. So a club admin who could set the number on someone else's
 * account could sign in as that person, and a club admin who could rename
 * them would rename them at every other club too.
 *
 * The rule, in one place:
 *
 *   A club admin may change a player's number or name ONLY when the club
 *   OWNS that user record: nobody has ever signed in as it, and it belongs
 *   to no other club (current or past, guest rows included).
 *
 * "Has signed in" is traced from what the code actually writes:
 *   - `onboarded` is set true by every sign-in that proves the phone:
 *     WhatsApp code sign-in and sign-up (phone-signup.ts), the claim flow
 *     (claim.ts) and the /welcome form (players.ts completeOnboarding);
 *   - an OAuth `Account` row (Google, the platform owner's fallback);
 *   - a `password` or an `emailVerified` stamp (legacy; none today);
 *   - a real email: every record MatchTime makes for a player it has not
 *     met uses a synthetic `@placeholder.matchtime` / `@matchtime.local`
 *     address, so anything else came from the person.
 * Sessions are JWT (auth.ts), so there are no Session rows to consult.
 *
 * Second rule (createPlayer / addPlayerToMatch / the setup wizard): a
 * number typed by an admin that already belongs to a user who is not a
 * member of this club is refused, never silently attached. The answer
 * names nobody and no club.
 *
 * Third rule: the player-editing admin actions need an approved club, or a
 * platform superadmin. A draft or pending club's owner sees only the
 * connect panel (admin/layout.tsx), so nothing they legitimately do needs
 * these actions.
 */
import { db } from "./db";
import { t, type Strings } from "./i18n/t";
import { isClubApproved } from "./club-approval-state";

/** Every synthetic address MatchTime mints for a player it has not met. */
const PLACEHOLDER_EMAIL = /@placeholder\.matchtime$|@matchtime\.local$/i;

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !email || PLACEHOLDER_EMAIL.test(email);
}

export interface OwnershipFacts {
  email: string | null;
  onboarded: boolean;
  password: string | null;
  emailVerified: Date | null;
  isSuperadmin: boolean;
  accountCount: number;
  memberships: Array<{ orgId: string; guestFromOrgId: string | null }>;
}

/** Has this person ever signed in as this record? (pure) */
export function hasOwnSignIn(f: OwnershipFacts): boolean {
  return (
    f.onboarded ||
    f.accountCount > 0 ||
    !!f.password ||
    !!f.emailVerified ||
    f.isSuperadmin ||
    !isPlaceholderEmail(f.email)
  );
}

/**
 * Does club `orgId` own this user record? (pure) No own sign-in, and its
 * only membership anywhere is an ordinary (non-guest) one at this club.
 */
export function clubOwnsUser(f: OwnershipFacts, orgId: string): boolean {
  if (hasOwnSignIn(f)) return false;
  if (f.memberships.length === 0) return false;
  return f.memberships.every((m) => m.orgId === orgId && !m.guestFromOrgId);
}

export async function loadOwnershipFacts(userId: string): Promise<OwnershipFacts | null> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      onboarded: true,
      password: true,
      emailVerified: true,
      isSuperadmin: true,
      _count: { select: { accounts: true } },
      memberships: { select: { orgId: true, guestFromOrgId: true } },
    },
  });
  if (!u) return null;
  return {
    email: u.email,
    onboarded: u.onboarded,
    password: u.password,
    emailVerified: u.emailVerified,
    isSuperadmin: u.isSuperadmin,
    accountCount: u._count?.accounts ?? 0,
    memberships: u.memberships ?? [],
  };
}

export async function isClubOwnedUser(userId: string, orgId: string): Promise<boolean> {
  const f = await loadOwnershipFacts(userId);
  return !!f && clubOwnsUser(f, orgId);
}

export type GuardRefusal = {
  ok: false;
  error: string;
  reason: "club-not-approved" | "player-owns-account" | "number-on-matchtime";
};

export interface PlayerEditContext {
  /** The club's string table, for any refusal the caller words itself. */
  s: Strings;
  /** Set when the actor may not edit this club's players at all. */
  refusal: GuardRefusal | null;
}

/**
 * The club gate (rule 3) plus the club's language. Call after
 * `requireOrgAdmin`. A platform superadmin passes whatever the club's
 * approval state; everyone else needs an approved club.
 */
export async function playerEditContext(actorId: string, orgId: string): Promise<PlayerEditContext> {
  const [org, actor] = await Promise.all([
    db.organisation.findUnique({ where: { id: orgId }, select: { approvalStatus: true, language: true } }),
    db.user.findUnique({ where: { id: actorId }, select: { isSuperadmin: true } }),
  ]);
  const s = t(org?.language);
  if (actor?.isSuperadmin) return { s, refusal: null };
  if (!org || !isClubApproved(org)) {
    return { s, refusal: { ok: false, reason: "club-not-approved", error: s.pg_err_club_not_approved } };
  }
  return { s, refusal: null };
}

export function ownsAccountRefusal(s: Strings): GuardRefusal {
  return { ok: false, reason: "player-owns-account", error: s.pg_err_player_owns_account };
}

export function numberOnMatchTimeRefusal(s: Strings): GuardRefusal {
  return { ok: false, reason: "number-on-matchtime", error: s.pg_err_number_on_matchtime };
}
