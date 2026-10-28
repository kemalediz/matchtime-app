"use server";

import { isGuestMembership } from "@/lib/guest-membership";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { onboardingSchema, playerPositionsSchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { normalisePhone } from "@/lib/phone";
import { mergePlayersCore } from "@/lib/merge-players-core";
import { recordAttendanceEvent } from "@/lib/attendance-events";
import { findExistingOrgMember } from "@/lib/resolve-player";
import {
  isClubOwnedUser,
  loadOwnershipFacts,
  clubOwnsUser,
  playerEditContext,
} from "@/lib/player-account-guard";
import { decideOwnPhoneWrite, type OwnPhoneRefusal } from "@/lib/own-phone-rules";
import { decideCrossClubLink, firstNameOf, type CrossClubRefusal } from "@/lib/cross-club-link-rules";
import { linkAcrossClubsCore, loadCrossClubLinkFacts } from "@/lib/cross-club-link";
import { changeMemberRole, transferOwnership, type RoleChangeOutcome, type TransferOutcome } from "@/lib/role-change";
import { t, type Strings } from "@/lib/i18n/t";
import { DEFAULT_LANG } from "@/lib/i18n/lang";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

/* A NEW PLAYER CARRIES NO RATING (2026-09-19).
 *
 * There used to be a default seed constant of 6 here, stamped onto every
 * user this file created. It was a number somebody picked in March doing
 * duty as a club's opinion of a person it had never seen play, and on
 * the global `User.seedRating` it was the same number at every club.
 *
 * A membership is now created unseeded. The balancer already handles
 * that: with no `Membership.seedRating` it shrinks toward the CLUB's own
 * mean rating, which at Sutton is 6.674 and at a brand new club is 5.0.
 * See MDs/club-scoped-ratings-design-2026-09-18.md sections 4.2 and 4.3.
 */

export type OwnDetailsResult = { ok: true } | { ok: false; reason: OwnPhoneRefusal };

/**
 * Write a player's own name (and, at most, ADD a number) from /welcome or
 * /profile. A blank phone never clears the stored one, and a stored one is
 * the sign-in number, so it is never changed here (own-phone-rules.ts;
 * FNF 2026-10-18, Feroz's number was wiped by a blank /welcome field).
 * Refusals are reason codes; the page words them in the visitor's language.
 */
async function writeOwnDetails(
  userId: string,
  formData: { name: string; phoneNumber?: string },
  extra: { onboarded?: true },
): Promise<OwnDetailsResult> {
  const parsed = onboardingSchema.parse(formData);
  const me = await db.user.findUnique({ where: { id: userId }, select: { phoneNumber: true } });
  const decision = decideOwnPhoneWrite({ current: me?.phoneNumber ?? null, submitted: parsed.phoneNumber });
  if (decision.kind === "refuse") return { ok: false, reason: decision.reason };

  const data: { name: string; onboarded?: true; phoneNumber?: string } = { name: parsed.name, ...extra };
  if (decision.kind === "set") {
    const holder = await db.user.findUnique({ where: { phoneNumber: decision.phone }, select: { id: true } });
    if (holder && holder.id !== userId) return { ok: false, reason: "taken" };
    data.phoneNumber = decision.phone;
  }

  try {
    await db.user.update({ where: { id: userId }, data });
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      return { ok: false, reason: "taken" };
    }
    throw err;
  }
  return { ok: true };
}

export async function completeOnboarding(formData: { name: string; phoneNumber?: string }): Promise<OwnDetailsResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const res = await writeOwnDetails(session.user.id, formData, { onboarded: true });
  if (!res.ok) return res;
  redirect("/");
  return res;
}

export async function updateProfile(formData: { name: string; phoneNumber?: string }): Promise<OwnDetailsResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const res = await writeOwnDetails(session.user.id, formData, {});
  if (res.ok) revalidatePath("/profile");
  return res;
}

/**
 * Set the signed-in user's positions for a specific activity. A row is
 * created on first call per (user, activity).
 */
export async function setMyPositions(formData: { activityId: string; positions: string[] }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = playerPositionsSchema.parse(formData);

  // Verify the user is a member of the org owning this activity.
  const activity = await db.activity.findUnique({
    where: { id: parsed.activityId },
    select: { orgId: true, sport: { select: { positions: true } } },
  });
  if (!activity) throw new Error("Activity not found");
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId: session.user.id, orgId: activity.orgId } },
  });
  if (!membership) throw new Error("Not a member of this organisation");

  // Validate picks against the activity's sport's position list.
  const valid = new Set(activity.sport.positions);
  const cleaned = parsed.positions.filter((p) => valid.has(p));
  if (cleaned.length === 0) throw new Error("No valid positions picked");

  await db.playerActivityPosition.upsert({
    where: { userId_activityId: { userId: session.user.id, activityId: parsed.activityId } },
    create: { userId: session.user.id, activityId: parsed.activityId, positions: cleaned },
    update: { positions: cleaned },
  });

  revalidatePath("/profile");
  revalidatePath(`/matches`);
  return { positions: cleaned };
}

/**
 * Admin: set a player's positions for a specific activity in this org.
 *
 * Under the hood we propagate the positions to EVERY activity in the same
 * org that shares the same sport. Rationale: "I play goalkeeper when I
 * play football here" is a property of (player, org, sport), not
 * (player, activity). If you set GK on Tuesday 7-a-side, Tuesday 5-a-side
 * gets it too because it's the same sport. You can still diverge by
 * passing different positions for a different-sport activity.
 */
export async function setPlayerPositions(
  userId: string,
  activityId: string,
  positions: string[],
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: { orgId: true, sportId: true, sport: { select: { positions: true } } },
  });
  if (!activity) throw new Error("Activity not found");

  await requireOrgAdmin(session.user.id, activity.orgId);

  const targetMembership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId: activity.orgId } },
  });
  if (!targetMembership) throw new Error("Player is not a member of this organisation");

  const valid = new Set(activity.sport.positions);
  const cleaned = positions.filter((p) => valid.has(p));
  if (cleaned.length === 0) throw new Error("No valid positions picked");

  // Find every activity in this org with the same sport — positions apply
  // to all of them, not just the one the admin clicked on.
  const sameSportActivities = await db.activity.findMany({
    where: { orgId: activity.orgId, sportId: activity.sportId },
    select: { id: true },
  });

  await db.$transaction(
    sameSportActivities.map((a) =>
      db.playerActivityPosition.upsert({
        where: { userId_activityId: { userId, activityId: a.id } },
        create: { userId, activityId: a.id, positions: cleaned },
        update: { positions: cleaned },
      }),
    ),
  );

  revalidatePath("/admin/players");
  revalidatePath("/admin/players/positions");
  return { positions: cleaned };
}

/**
 * Admin: make a member an Admin or a Player. An OWNER is refused and left
 * untouched (2026-10-20, FNF: Hamzah, the club's creator, was found as
 * ADMIN with no record of who changed it), and every change is logged
 * in RoleChange. See src/lib/role-change.ts.
 */
export async function updatePlayerRole(
  userId: string,
  orgId: string,
  role: "ADMIN" | "PLAYER",
): Promise<RoleChangeOutcome> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, orgId);

  const res = await changeMemberRole(db, {
    orgId,
    userId,
    to: role,
    actorUserId: session.user.id,
    source: "admin-players-page",
  });

  if (res.ok && res.changed) revalidatePath("/admin/players");
  return res;
}

/**
 * The owner hands the club to another member: they become OWNER and the
 * owner becomes ADMIN, both logged in RoleChange. Refused for anybody
 * who is not the club's OWNER, a superadmin without an OWNER membership
 * included (src/lib/role-change-rules.ts).
 */
export async function makeOwner(userId: string, orgId: string): Promise<TransferOutcome> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, orgId);

  const res = await transferOwnership(db, { orgId, actorUserId: session.user.id, targetUserId: userId });
  if (res.ok) revalidatePath("/admin/players");
  return res;
}

export async function seedPlayerRating(userId: string, orgId: string, rating: number) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, orgId);

  if (rating < 1 || rating > 10) throw new Error("Rating must be between 1 and 10");

  // The seed is THIS club's opinion, so it lives on THIS club's
  // membership. It used to be written to `User.seedRating`, one global
  // column, which meant an admin correcting a number in their own seed
  // editor moved the balancer input at every other club the same person
  // plays for (MDs/club-scoped-ratings-design-2026-09-18.md, section 2
  // decision 5). `orgId` was already in the signature and already
  // authorised against above; only the write target was global.
  //
  // `updateMany` rather than `update`: `Membership` is unique on
  // [userId, orgId] so it can match at most one row, and a miss comes
  // back as `count: 0` instead of a raw Prisma P2025 for the admin to
  // read. A miss is a real condition worth naming, not a no-op: it means
  // the player is not a member of the club being seeded.
  const { count } = await db.membership.updateMany({
    where: { userId, orgId },
    data: { seedRating: rating },
  });
  if (count === 0) throw new Error("That player is not a member of this club");

  revalidatePath("/admin/players");
}

/**
 * Admin: rename a player. Useful when an auto-provisioned member came
 * in with a WhatsApp pushname that's not their real name (e.g.
 * "MJA swthree" → "Michael"). Does NOT touch any other field —
 * resolveSender will pick up the new name on the next message via
 * fuzzy matching, so the existing user gets reused rather than a
 * fresh ghost being created.
 */
/**
 * Admin: merge two duplicate user records into one. Keeps `keepUserId`,
 * drops `dropUserId`. Re-attributes attendance, ratings, MoM votes,
 * analyzed messages, and team assignments. Backfills `phoneNumber` and
 * the rest of a real identity from the drop record only when the keep
 * record is missing them, and carries the per-club seed and Elo across
 * one membership at a time. The drop user + memberships are deleted at
 * the end. Transactional, so partial failures roll back.
 */
export async function mergePlayers(
  orgId: string,
  keepUserId: string,
  dropUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
  const { s, refusal } = await playerEditContext(session.user.id, orgId);
  if (refusal) return { ok: false, error: refusal.error };

  if (keepUserId === dropUserId) throw new Error("Pick two different players");

  // Both must be members of THIS org so the merge can't reach across
  // orgs the admin doesn't run.
  const [keepMembership, dropMembership] = await Promise.all([
    db.membership.findUnique({ where: { userId_orgId: { userId: keepUserId, orgId } } }),
    db.membership.findUnique({ where: { userId_orgId: { userId: dropUserId, orgId } } }),
  ]);
  if (!keepMembership || !dropMembership) {
    throw new Error("Both players must be members of this organisation");
  }

  // Account safety (player-account-guard.ts). The dropped record is
  // deleted and its identity (number, OAuth link, other clubs) moves to
  // the keeper, so it must be a record this club owns. And when the keeper
  // is somebody's own account, the merge must not hand it a number or a
  // name from the placeholder: that is a phone change by another route.
  const [keepFacts, dropFacts] = await Promise.all([loadOwnershipFacts(keepUserId), loadOwnershipFacts(dropUserId)]);
  if (!keepFacts || !dropFacts) throw new Error("Player not found");
  if (!clubOwnsUser(dropFacts, orgId)) return { ok: false, error: s.pg_err_merge_keep_owned };
  // A dropped record lent out to a partner club carries rows there (its
  // guest membership, attendance, ratings), and the merge moves them all.
  // Only onto a record this club owns too, never onto someone's own
  // account (adversarial review, 2026-10-22).
  const dropReachesOtherClubs = (dropFacts.memberships ?? []).some((m) => m.orgId !== orgId);
  if (dropReachesOtherClubs && !clubOwnsUser(keepFacts, orgId)) return { ok: false, error: s.pg_err_player_owns_account };
  if (!clubOwnsUser(keepFacts, orgId)) {
    const [keepUser, dropUser] = await Promise.all([
      db.user.findUnique({ where: { id: keepUserId }, select: { phoneNumber: true, name: true } }),
      db.user.findUnique({ where: { id: dropUserId }, select: { phoneNumber: true, name: true } }),
    ]);
    const givesPhone = !keepUser?.phoneNumber && !!dropUser?.phoneNumber;
    const givesName = !keepUser?.name && !!dropUser?.name;
    if (givesPhone || givesName) return { ok: false, error: s.pg_err_player_owns_account };
  }

  // 2026-06-12: explicit 60s timeout. mergePlayersCore issues ~25+ serial
  // round-trips (one per relation scan / per-row conflict check) inside
  // ONE interactive transaction; from a Vercel function to the Supabase
  // eu-west pooler that's ~200ms each, so Prisma's DEFAULT 5s interactive-
  // transaction timeout expires mid-merge (P2028, seen live on the Omar
  // Yusuf merge: "timeout for this transaction was 5000 ms, however
  // 5184 ms passed", dying at moMVote.updateMany). The transaction rolls
  // back cleanly but the admin just sees a redacted "Failed".
  // updatePlayerPhone's two merge paths already pass 60_000 for the same
  // reason (added 2026-05-26); this entry point was missed. House rule in
  // MDs/skills.md: any transaction spanning more than two writes gets
  // { timeout: 60_000 }.
  await db.$transaction(
    async (tx) => {
      await mergePlayersCore(tx, keepUserId, dropUserId, { saveAliasInOrgIds: [orgId], actorUserId: session.user.id });
    },
    { timeout: 60_000 },
  );

  revalidatePath("/admin/players");
  revalidatePath("/admin");
  return { ok: true };
}
export async function updatePlayerName(
  userId: string,
  orgId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
  const { s, refusal } = await playerEditContext(session.user.id, orgId);
  if (refusal) return { ok: false, error: refusal.error };

  const trimmed = name.trim();
  if (trimmed.length < 1) throw new Error("Name can't be empty");
  if (trimmed.length > 100) throw new Error("Name too long");

  // Confirm the player is in this org (stops cross-org renames).
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true },
  });
  if (!membership) throw new Error("Player is not a member of this organisation");
  // `User.name` is global: a rename shows at every club they play at. Only
  // a record this club owns (player-account-guard.ts).
  if (!(await isClubOwnedUser(userId, orgId))) return { ok: false, error: s.pg_err_player_owns_account };

  await db.user.update({ where: { id: userId }, data: { name: trimmed } });

  revalidatePath("/admin/players");
  return { ok: true };
}

/**
 * Admin: confirm that an auto-provisioned player is real. Clears the
 * provisionallyAddedAt flag so the "NEW" badge disappears. Does not
 * touch anything else — phone/positions/rating are edited via the
 * usual inputs on the same row.
 */
/**
 * Admin: manually add a player to the org from the portal — for guests
 * who played but aren't in the WhatsApp group (so the bot never
 * auto-created them) and don't use the invite link.
 *
 * Phone-aware + dedup-safe: if a record with that phone already exists
 * anywhere, we reuse it (add/reactivate the membership) instead of
 * creating a duplicate — same principle as the group-join flow. Returns a
 * discriminated union (errors as DATA, not thrown — Next redacts thrown
 * Server-Action messages in production).
 */
export type CreatePlayerResult =
  | { ok: true; userId: string; created: boolean; rejoined: boolean }
  | { ok: false; error: string };

export async function createPlayer(
  orgId: string,
  rawName: string,
  rawPhone?: string,
): Promise<CreatePlayerResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
  const { s, refusal } = await playerEditContext(session.user.id, orgId);
  if (refusal) return { ok: false, error: refusal.error };

  const name = rawName.trim();
  const phoneInput = (rawPhone ?? "").trim();

  // ── Phone supplied: reuse any existing record to avoid duplicates ──
  if (phoneInput) {
    const phone = normalisePhone(phoneInput);
    if (!phone) return { ok: false, error: "That doesn't look like a valid phone number" };

    const existing = await db.user.findUnique({
      where: { phoneNumber: phone },
      select: { id: true, name: true },
    });
    if (existing) {
      const mem = await db.membership.findUnique({
        where: { userId_orgId: { userId: existing.id, orgId } },
        select: { id: true, leftAt: true, guestMatchId: true },
      });
      // The number already belongs to somebody who is not this club's
      // member (another club, a guest here, or no club yet).
      // Never attach them silently: the answer names nobody and no club
      // (player-account-guard.ts).
      if (!mem || isGuestMembership(mem)) return { ok: false, error: s.pg_err_number_on_matchtime };
      // Backfill a name if the record had none, only on a record we own.
      if (name && !existing.name && (await isClubOwnedUser(existing.id, orgId))) {
        await db.user.update({ where: { id: existing.id }, data: { name } });
      }
      if (!mem.leftAt) {
        return { ok: false, error: `That number already belongs to ${existing.name ?? "a player"} in this group.` };
      }
      await db.membership.update({ where: { id: mem.id }, data: { leftAt: null } });
      revalidatePath("/admin/players");
      return { ok: true, userId: existing.id, created: false, rejoined: true };
    }

    if (!name) return { ok: false, error: "Please enter a name" };
    const placeholderEmail = `wa-${phone.replace(/^\+/, "")}@placeholder.matchtime`;
    const user = await db.user.create({
      data: { name, email: placeholderEmail, phoneNumber: phone, onboarded: false, isActive: true },
      select: { id: true },
    });
    await db.membership.create({ data: { userId: user.id, orgId, role: "PLAYER" } });
    revalidatePath("/admin/players");
    return { ok: true, userId: user.id, created: true, rejoined: false };
  }

  // ── No phone: name-only guest (synthetic unique email) ──
  if (!name) return { ok: false, error: "Please enter a name (or a phone number)" };
  // Dedup BEFORE creating: reuse an existing member only on a strong,
  // unambiguous signal (alias / unique exact-or-fuzzy name). Ambiguous names
  // fall through to a fresh create so we never collapse two distinct people.
  const nameMatch = await findExistingOrgMember(orgId, { name });
  if (nameMatch) {
    const mem = await db.membership.findUnique({
      where: { userId_orgId: { userId: nameMatch.userId, orgId } },
      select: { id: true, leftAt: true },
    });
    if (mem && !mem.leftAt) {
      return { ok: true, userId: nameMatch.userId, created: false, rejoined: false };
    }
    if (mem && mem.leftAt) {
      await db.membership.update({ where: { id: mem.id }, data: { leftAt: null } });
      revalidatePath("/admin/players");
      return { ok: true, userId: nameMatch.userId, created: false, rejoined: true };
    }
    await db.membership.create({ data: { userId: nameMatch.userId, orgId, role: "PLAYER" } });
    revalidatePath("/admin/players");
    return { ok: true, userId: nameMatch.userId, created: false, rejoined: false };
  }
  const email = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@placeholder.matchtime`;
  const user = await db.user.create({
    data: { name, email, phoneNumber: null, onboarded: false, isActive: true },
    select: { id: true },
  });
  await db.membership.create({ data: { userId: user.id, orgId, role: "PLAYER" } });
  revalidatePath("/admin/players");
  return { ok: true, userId: user.id, created: true, rejoined: false };
}

export async function confirmProvisionalPlayer(userId: string, orgId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  await db.membership.update({
    where: { userId_orgId: { userId, orgId } },
    data: { provisionallyAddedAt: null },
  });

  revalidatePath("/admin/players");
  revalidatePath("/admin");
}

/**
 * Admin: remove a player who was auto-provisioned but shouldn't have
 * been (e.g. non-playing group member). Sets leftAt, preserving any
 * attendance/rating history.
 */
export async function removeProvisionalPlayer(
  userId: string,
  orgId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
  const { refusal } = await playerEditContext(session.user.id, orgId);
  if (refusal) return { ok: false, error: refusal.error };

  await db.membership.update({
    where: { userId_orgId: { userId, orgId } },
    data: { leftAt: new Date(), provisionallyAddedAt: null },
  });
  // ...and off every match of the club still to come (FNF, 2026-10-24:
  // "Glazers" stayed on the bench, printed as "a player"). After the
  // leftAt write: the helper acts only on a closed membership. Imported
  // when needed, like the partner-guest check below (attendance.ts pulls in
  // the scheduler).
  const { takeRemovedMemberOffUpcomingMatches } = await import("@/lib/member-removal");
  const takenOff = await takeRemovedMemberOffUpcomingMatches({
    userId,
    orgId,
    event: {
      cause: "member-removed",
      actorKind: "admin",
      actorUserId: session.user.id,
      sourceRef: "admin:removeProvisionalPlayer",
    },
  });

  revalidatePath("/admin/players");
  revalidatePath("/admin");
  for (const t of takenOff) revalidatePath(`/matches/${t.matchId}`);
  return { ok: true };
}

/**
 * Result of setting a player's phone. Errors are DATA, not thrown: Next
 * redacts a thrown Server-Action message in production, which is how the
 * FNF admin got "An error occurred in the Server Components render"
 * (2026-10-18). Every `error` is a readable sentence in the club's
 * language.
 *
 * `link` is set when the number belongs to a MatchTime user who is not a
 * member of this club and the rules allow linking (cross-club-link-rules
 * .ts). It carries the other user's FIRST name and their clubs' names,
 * nothing else; the page then asks "same person?" and on yes calls
 * `linkPlayerByPhone`.
 */
export interface PhoneLinkOffer {
  /** The number as the admin typed it, normalised. */
  phone: string;
  firstName: string | null;
  clubNames: string[];
  /** This club's own name, for the dialog's explanation. */
  thisClub: string;
}
export type UpdatePlayerPhoneResult =
  | {
      ok: true;
      phoneNumber: string;
      mergedSyncOrphan?: string;
      mergedProvisional?: string;
      redirectToUserId?: string;
    }
  | { ok: false; error: string; link?: PhoneLinkOffer };

async function clubStrings(orgId: string): Promise<{ s: Strings; clubName: string }> {
  try {
    const org = await db.organisation.findUnique({ where: { id: orgId }, select: { name: true, language: true } });
    return { s: t(org?.language), clubName: org?.name ?? "" };
  } catch {
    return { s: t(DEFAULT_LANG), clubName: "" };
  }
}

function refusalMessage(s: Strings, reason: CrossClubRefusal): string {
  switch (reason) {
    case "drop_other_clubs":
      return s.phone_link_refused_drop_other_clubs;
    case "drop_has_sign_in":
      return s.phone_link_refused_drop_sign_in;
    case "drop_guest":
      return s.phone_err_guest;
    case "drop_not_member":
      return s.phone_err_not_member;
    // Superadmin, number gone, same user: say only that it is taken.
    // No name on a refusal.
    default:
      return s.phone_err_taken;
  }
}

export async function updatePlayerPhone(
  userId: string,
  orgId: string,
  phone: string,
): Promise<UpdatePlayerPhoneResult> {
  try {
    return await updatePlayerPhoneInner(userId, orgId, phone);
  } catch (err) {
    // Anything unexpected: logged in full, shown as a sentence.
    console.error("[updatePlayerPhone] failed", { userId, orgId, err });
    const { s } = await clubStrings(orgId);
    return { ok: false, error: s.phone_err_generic };
  }
}

async function updatePlayerPhoneInner(
  userId: string,
  orgId: string,
  phone: string,
): Promise<UpdatePlayerPhoneResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: (await clubStrings(orgId)).s.phone_err_not_allowed };

  try {
    await requireOrgAdmin(session.user.id, orgId);
  } catch {
    return { ok: false, error: (await clubStrings(orgId)).s.phone_err_not_allowed };
  }
  // #314: an approved club (or a platform superadmin) only.
  const { s, refusal } = await playerEditContext(session.user.id, orgId);
  if (refusal) return { ok: false, error: refusal.error };

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true, guestMatchId: true },
  });
  if (!membership) return { ok: false, error: (await clubStrings(orgId)).s.phone_err_not_member };
  // A guest, a partner club's or the player pool's (cross-club ask, review
  // H1; pool, L5a): his number is not this club's to see or to set.
  if (isGuestMembership(membership)) return { ok: false, error: s.phone_err_guest };
  // A number is a sign-in (verifyPhoneSignIn): only a record this club
  // owns may have it changed by an admin (player-account-guard.ts, #314).
  // This runs BEFORE the cross-club link offer below, so a link can only
  // ever be offered for a record this club owns.
  if (!(await isClubOwnedUser(userId, orgId))) return { ok: false, error: s.pg_err_player_owns_account };

  const normalised = normalisePhone(phone);
  if (!normalised) return { ok: false, error: (await clubStrings(orgId)).s.phone_err_invalid };

  try {
    await db.user.update({ where: { id: userId }, data: { phoneNumber: normalised } });
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      // ── Cross-club first (FNF incident 2026-10-18) ──
      // The number belongs to somebody who is not a member of this club.
      // Never merge silently across clubs: ask the admin "same person?"
      // when the rules allow a link, otherwise say it is taken (with no
      // name). A number whose owner IS in this club, or is in no club at
      // all, falls through to the same-club paths below, unchanged.
      const facts = await loadCrossClubLinkFacts(db, { orgId, dropUserId: userId, phone: normalised });
      const verdict = decideCrossClubLink(facts);
      if (verdict.kind === "offer") {
        const { s, clubName } = await clubStrings(orgId);
        return {
          ok: false,
          error: s.phone_err_taken,
          link: { phone: normalised, firstName: verdict.firstName, clubNames: verdict.clubNames, thisClub: clubName },
        };
      }
      if (verdict.kind === "refuse") {
        const { s } = await clubStrings(orgId);
        return { ok: false, error: refusalMessage(s, verdict.reason) };
      }

      // P2002 = unique-constraint failure on User.phoneNumber. Two
      // scenarios collide here:
      //   (a) The phone genuinely belongs to a DIFFERENT real player
      //       already in the system — admin made a typo. Surface a
      //       friendly error so they can correct it.
      //   (b) The phone belongs to a wweb.js sync-orphan: a placeholder
      //       User that the bot's sync-participants step auto-created
      //       when it found the contact in the WhatsApp group with no
      //       saved display name. The orphan has phone but no name and
      //       a synthetic email like `wa-sync+player-<id>@matchtime.local`.
      //       In that case the admin's intent is clear — they're
      //       claiming the phone for the player they're editing — so we
      //       merge the orphan in instead of fighting them. The orphan's
      //       attendance/ratings/etc. (if any) transfer to the target.
      //       Documented in MDs/learnings.md after the recurring
      //       duplicate-User issue 2026-05-25/26.
      const colliding = await db.user.findUnique({
        where: { phoneNumber: normalised },
        select: { id: true, name: true, email: true },
      });
      // Both merges below fold one record into the other. The record that
      // holds the number must be this club's own too, or the merge would
      // pull another club's player (or a real account) in. Otherwise the
      // plain refusal, which names nobody outside this club (#314).
      if (colliding && colliding.id !== userId && !(await isClubOwnedUser(colliding.id, orgId))) {
        const here = await db.membership.findUnique({
          where: { userId_orgId: { userId: colliding.id, orgId } },
          select: { guestMatchId: true },
        });
        if (here && !isGuestMembership(here)) {
          return { ok: false, error: s.phone_err_taken_here({ name: firstNameOf(colliding.name) }) };
        }
        return { ok: false, error: s.phone_err_taken };
      }
      const isSyncOrphan =
        !!colliding &&
        colliding.id !== userId &&
        (colliding.name === null || colliding.name === "") &&
        typeof colliding.email === "string" &&
        colliding.email.startsWith("wa-sync+");
      // provisional+ orphan: same admin-intent class as wa-sync but with
      // a NAMED placeholder. Created when the LLM resolved a player name
      // without a phone match (e.g. "Faris" mentioned in chat → a
      // provisional User). When the admin later types Faris's phone into
      // ANOTHER provisional Faris record (different org's group), P2002
      // fires. Sutton Lads Faris 2026-05-28 incident: target was an
      // empty placeholder; colliding was the older Sutton FC Faris with
      // 11 ratings + 1 team assignment + 1 attendance. Naively dropping
      // the colliding (as we do for wa-sync) would have destroyed real
      // history. So direction here is chosen by history weight: keep
      // whichever side has more attendance/ratings/MoM/TA rows.
      const isProvisionalOrphan =
        !!colliding &&
        colliding.id !== userId &&
        typeof colliding.email === "string" &&
        colliding.email.startsWith("provisional+");
      if (isSyncOrphan) {
        // Merge the orphan INTO the target user. We need shared-org IDs
        // for alias scope — fall back to the action's orgId so at
        // minimum the orphan's dropped name (if it ever got one) ends
        // up aliased here.
        const orphanMemberships = await db.membership.findMany({
          where: { userId: colliding!.id },
          select: { orgId: true },
        });
        const targetMemberships = await db.membership.findMany({
          where: { userId },
          select: { orgId: true },
        });
        const targetOrgSet = new Set(targetMemberships.map((m) => m.orgId));
        const aliasOrgs = orphanMemberships
          .map((m) => m.orgId)
          .filter((id) => targetOrgSet.has(id));
        if (aliasOrgs.length === 0) aliasOrgs.push(orgId);
        await db.$transaction(
          async (tx) => {
            await mergePlayersCore(tx, userId, colliding!.id, { saveAliasInOrgIds: aliasOrgs });
          },
          { timeout: 60_000 },
        );
        // After the merge the phone is now on the target user.
        revalidatePath("/admin/players");
        revalidatePath("/admin/players/phones");
        return { ok: true, phoneNumber: normalised, mergedSyncOrphan: colliding!.id };
      }
      if (isProvisionalOrphan) {
        // Weigh by history rows on each side. The one with MORE history
        // is the established record; the other is a placeholder.
        const weigh = async (uid: string) => {
          const [att, rGiven, rRecv, mom, ta] = await Promise.all([
            db.attendance.count({ where: { userId: uid } }),
            db.rating.count({ where: { raterId: uid } }),
            db.rating.count({ where: { playerId: uid } }),
            db.moMVote.count({ where: { voterId: uid } }),
            db.teamAssignment.count({ where: { userId: uid } }),
          ]);
          return att + rGiven + rRecv + mom + ta;
        };
        const [targetWeight, collidingWeight] = await Promise.all([
          weigh(userId),
          weigh(colliding!.id),
        ]);
        const keepCollidingSide = collidingWeight > targetWeight;
        const keepId = keepCollidingSide ? colliding!.id : userId;
        const dropId = keepCollidingSide ? userId : colliding!.id;
        // Alias scope: shared orgs between both sides, fall back to the
        // edit context.
        const [keepMems, dropMems] = await Promise.all([
          db.membership.findMany({ where: { userId: keepId }, select: { orgId: true } }),
          db.membership.findMany({ where: { userId: dropId }, select: { orgId: true } }),
        ]);
        const keepOrgSet = new Set(keepMems.map((m) => m.orgId));
        const aliasOrgs = dropMems.map((m) => m.orgId).filter((id) => keepOrgSet.has(id));
        if (aliasOrgs.length === 0) aliasOrgs.push(orgId);
        await db.$transaction(
          async (tx) => {
            await mergePlayersCore(tx, keepId, dropId, { saveAliasInOrgIds: aliasOrgs });
          },
          { timeout: 60_000 },
        );
        revalidatePath("/admin/players");
        revalidatePath("/admin/players/phones");
        return {
          ok: true,
          phoneNumber: normalised,
          mergedProvisional: dropId,
          // When the admin's record was the one dropped, the UI needs to
          // navigate to the kept record — the page they were on is now
          // pointing at a merged-out User.
          redirectToUserId: keepCollidingSide ? keepId : undefined,
        };
      }
      // Taken, and not a placeholder we may fold in. Only a record this
      // club owns reaches here (the #314 check above), so naming it names
      // one of the club's own players.
      if (facts.keep?.hasMembershipInOrg) {
        return { ok: false, error: s.phone_err_taken_here({ name: firstNameOf(colliding?.name) }) };
      }
      return { ok: false, error: s.phone_err_taken };
    }
    throw err;
  }

  revalidatePath("/admin/players");
  revalidatePath("/admin/players/phones");
  return { ok: true, phoneNumber: normalised };
}

/**
 * "Yes, link them" (FNF incident 2026-10-18). Club A's player `userId`
 * is merged INTO the existing account that holds `phone`, through the
 * shared `mergePlayersCore`, so the person ends up a member of both
 * clubs. The existing account keeps its id and its phone.
 *
 * Authorised for any OWNER or ADMIN of club A (`orgId`); the actor needs
 * no role at the other club. Everything is re-read and re-decided inside
 * the transaction (cross-club-link.ts), so a stale dialog cannot link
 * anything the rules would now refuse. Only club A's rows and club A's
 * membership are written: the rules refuse a player of A who has any
 * other club's membership or rows. The `UserMerge` tombstone records who
 * linked whom and when.
 */
export type LinkPlayerByPhoneResult = { ok: true; keptUserId: string } | { ok: false; error: string };

export async function linkPlayerByPhone(
  userId: string,
  orgId: string,
  phone: string,
): Promise<LinkPlayerByPhoneResult> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: (await clubStrings(orgId)).s.phone_err_not_allowed };
    const actorUserId = session.user.id;
    try {
      await requireOrgAdmin(actorUserId, orgId);
    } catch {
      return { ok: false, error: (await clubStrings(orgId)).s.phone_err_not_allowed };
    }
    // #314: an approved club (or a platform superadmin) only. The record
    // being merged away must also have no sign in of its own and belong
    // to club A alone; that is re-checked inside the transaction
    // (cross-club-link-rules.ts, `drop_has_sign_in` / `drop_other_clubs`,
    // using player-account-guard's `hasOwnSignIn`).
    const { refusal } = await playerEditContext(actorUserId, orgId);
    if (refusal) return { ok: false, error: refusal.error };
    const normalised = normalisePhone(phone);
    if (!normalised) return { ok: false, error: (await clubStrings(orgId)).s.phone_err_invalid };

    const result = await db.$transaction(
      async (tx) => linkAcrossClubsCore(tx, { orgId, dropUserId: userId, phone: normalised, actorUserId }),
      { timeout: 60_000 },
    );
    if (!result.ok) {
      const { s } = await clubStrings(orgId);
      return {
        ok: false,
        error: result.verdict.kind === "refuse" ? refusalMessage(s, result.verdict.reason) : s.phone_err_taken,
      };
    }
    console.info("[linkPlayerByPhone] linked across clubs", {
      orgId,
      actorUserId,
      droppedUserId: userId,
      keptUserId: result.keptUserId,
    });
    revalidatePath("/admin/players");
    revalidatePath("/admin/players/phones");
    revalidatePath("/admin");
    return { ok: true, keptUserId: result.keptUserId };
  } catch (err) {
    console.error("[linkPlayerByPhone] failed", { userId, orgId, err });
    return { ok: false, error: (await clubStrings(orgId)).s.phone_err_generic };
  }
}

/**
 * Add a UserAlias for a player. Aliases are nicknames / short
 * pushnames / variant spellings the sender resolver uses when the
 * WhatsApp display name doesn't fuzzy-match the canonical name —
 * "Nunu" → Elnur Mammadov, "ba" → Baki when there are multiple
 * "ba*" first names in the org.
 *
 * Schema: aliases are stored lowercased + diacritic-stripped (matches
 * the resolver's comparison key), so the input gets normalised here
 * regardless of how the admin types it. Unique per (orgId, alias) —
 * adding the same alias for a different user errors out.
 */
const aliasNorm = (s: string) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Result is a discriminated union, NOT a thrown error, for the EXPECTED
 * validation failures (too short/long, alias already taken by someone
 * else). Next.js redacts thrown Server-Action error messages in
 * production — they surface to the client as the generic "An error
 * occurred in the Server Components render…" digest — so a useful message
 * has to be RETURNED as data. (Caught us 2026-06-05: adding an alias that
 * already belonged to another player showed that scary generic error
 * instead of "alias already assigned".) Genuine faults (not authed, not
 * admin) still throw — those shouldn't reach the UI.
 */
export type AddAliasResult =
  | { ok: true; alias: string; alreadyExisted: boolean }
  | { ok: false; error: string; conflictUserId?: string };

export async function addPlayerAlias(
  userId: string,
  orgId: string,
  rawAlias: string,
): Promise<AddAliasResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  const alias = aliasNorm(rawAlias);
  if (alias.length < 2) return { ok: false, error: "Alias must be at least 2 characters" };
  if (alias.length > 40) return { ok: false, error: "Alias is too long" };

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true },
  });
  if (!membership) return { ok: false, error: "Player is not a member of this organisation" };

  // If alias is already taken by someone else in the org, surface it.
  const existing = await db.userAlias.findUnique({
    where: { orgId_alias: { orgId, alias } },
    select: { userId: true },
  });
  if (existing && existing.userId !== userId) {
    // Name the conflicting player so the admin knows where it lives.
    const other = await db.user.findUnique({
      where: { id: existing.userId },
      select: { name: true },
    });
    return {
      ok: false,
      conflictUserId: existing.userId,
      error: `"${alias}" is already an alias of ${other?.name ?? "another player"}. Merge the two records or remove it there first.`,
    };
  }
  if (existing && existing.userId === userId) {
    return { ok: true, alias, alreadyExisted: true };
  }

  await db.userAlias.create({
    data: { orgId, userId, alias, source: "manual" },
  });
  revalidatePath("/admin/players");
  return { ok: true, alias, alreadyExisted: false };
}

export async function removePlayerAlias(userId: string, orgId: string, rawAlias: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  const alias = aliasNorm(rawAlias);
  // Bound the delete to (orgId, alias, userId) so an admin can't
  // accidentally delete someone else's alias even if they passed the
  // wrong userId in the request body.
  const row = await db.userAlias.findUnique({
    where: { orgId_alias: { orgId, alias } },
    select: { id: true, userId: true },
  });
  if (!row) return { removed: false };
  if (row.userId !== userId) {
    throw new Error("Alias belongs to a different player");
  }
  await db.userAlias.delete({ where: { id: row.id } });
  revalidatePath("/admin/players");
  return { removed: true };
}

// ─── Add a player directly to a match (2026-06-05) ──────────────────────
//   Admin convenience: drop a missing player into a specific match's squad
//   — past or future — creating their record on the fly if needed. For a
//   match that has ALREADY happened and whose MoM isn't announced yet, it
//   also DMs them their rating link so they can rate + be rated before the
//   window closes. Removes the need to hand-fix recovered squads.

/** Find or create a player in `orgId` from {userId|phone|name}, ensuring
 *  an active membership. A new player is created UNSEEDED: see the note
 *  at the top of this file. */
async function ensureOrgPlayer(
  orgId: string,
  input: { userId?: string; name?: string; phone?: string },
  s: Strings,
): Promise<{ ok: true; userId: string; created: boolean } | { ok: false; error: string }> {
  const name = (input.name ?? "").trim();

  if (input.userId) {
    const u = await db.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!u) return { ok: false, error: "Player not found" };
    // Only somebody who is (or was) this club's own member: an arbitrary
    // user id must not attach a stranger (player-account-guard.ts).
    const mem = await db.membership.findUnique({
      where: { userId_orgId: { userId: u.id, orgId } },
      select: { guestMatchId: true, leftAt: true },
    });
    if (!mem || (isGuestMembership(mem) && mem.leftAt)) return { ok: false, error: s.pg_err_number_on_matchtime };
    await ensureMembership(u.id, orgId);
    return { ok: true, userId: u.id, created: false };
  }

  const phoneInput = (input.phone ?? "").trim();
  if (phoneInput) {
    const phone = normalisePhone(phoneInput);
    if (!phone) return { ok: false, error: "That doesn't look like a valid phone number" };
    const existing = await db.user.findUnique({ where: { phoneNumber: phone }, select: { id: true, name: true } });
    if (existing) {
      // Same rule as createPlayer: a number that belongs to somebody who
      // is not this club's member attaches nobody and names nobody.
      const mem = await db.membership.findUnique({
        where: { userId_orgId: { userId: existing.id, orgId } },
        select: { guestMatchId: true },
      });
      if (!mem || isGuestMembership(mem)) return { ok: false, error: s.pg_err_number_on_matchtime };
      if (name && !existing.name && (await isClubOwnedUser(existing.id, orgId))) {
        await db.user.update({ where: { id: existing.id }, data: { name } });
      }
      await ensureMembership(existing.id, orgId);
      return { ok: true, userId: existing.id, created: false };
    }
    if (!name) return { ok: false, error: "Please enter a name" };
    const user = await db.user.create({
      data: { name, email: `wa-${phone.replace(/^\+/, "")}@placeholder.matchtime`, phoneNumber: phone, onboarded: false, isActive: true },
      select: { id: true },
    });
    await db.membership.create({ data: { userId: user.id, orgId, role: "PLAYER" } });
    return { ok: true, userId: user.id, created: true };
  }

  if (!name) return { ok: false, error: "Please enter a name (or a phone number)" };
  // Dedup BEFORE creating: reuse an existing member only on a strong,
  // unambiguous signal (alias / unique exact-or-fuzzy name). Ambiguous names
  // fall through to a fresh create so we never collapse two distinct people.
  const match = await findExistingOrgMember(orgId, { name });
  if (match) {
    await ensureMembership(match.userId, orgId);
    return { ok: true, userId: match.userId, created: false };
  }
  const email = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@placeholder.matchtime`;
  const user = await db.user.create({
    data: { name, email, onboarded: false, isActive: true },
    select: { id: true },
  });
  await db.membership.create({ data: { userId: user.id, orgId, role: "PLAYER" } });
  return { ok: true, userId: user.id, created: true };
}

async function ensureMembership(userId: string, orgId: string) {
  const mem = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { id: true, leftAt: true },
  });
  if (!mem) await db.membership.create({ data: { userId, orgId, role: "PLAYER" } });
  else if (mem.leftAt) await db.membership.update({ where: { id: mem.id }, data: { leftAt: null } });
}

export type AddToMatchResult =
  | { ok: true; userId: string; created: boolean; ratingDmSent: boolean }
  | { ok: false; error: string };

export async function addPlayerToMatch(
  matchId: string,
  input: { userId?: string; name?: string; phone?: string },
  status: "CONFIRMED" | "BENCH" = "CONFIRMED",
): Promise<AddToMatchResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      status: true,
      activity: {
        select: { name: true, orgId: true, matchDurationMins: true, sport: { select: { mvpLabel: true } } },
      },
    },
  });
  if (!match) return { ok: false, error: "Match not found" };
  const orgId = match.activity.orgId;
  await requireOrgAdmin(session.user.id, orgId);
  const { s, refusal } = await playerEditContext(session.user.id, orgId);
  if (refusal) return { ok: false, error: refusal.error };

  const resolved = await ensureOrgPlayer(orgId, input, s);
  if (!resolved.ok) return resolved;
  const userId = resolved.userId;

  // Append at the end of the chosen status group.
  const last = await db.attendance.findFirst({
    where: { matchId, status },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const priorRow = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { status: true, position: true },
  });
  // Same transaction as the record of it — see lib/attendance-events.ts.
  await db.$transaction(async (tx) => {
    const row = await tx.attendance.upsert({
      where: { matchId_userId: { matchId, userId } },
      update: { status, position: (last?.position ?? 0) + 1 },
      create: { matchId, userId, status, position: (last?.position ?? 0) + 1 },
    });
    await recordAttendanceEvent(
      tx,
      {
        matchId,
        userId,
        orgId,
        fromStatus: priorRow?.status ?? null,
        toStatus: row.status,
        fromPosition: priorRow?.position ?? null,
        toPosition: row.position,
      },
      {
        cause: "admin-squad-edit",
        actorKind: "admin",
        actorUserId: session.user!.id,
        sourceRef: "admin:addPlayerToMatch",
      },
    );
  });

  // Late rating-link DM — only when it still makes sense: the match has
  // happened, MoM isn't announced yet, the org rates players, and the
  // player is confirmed + has a phone + hasn't already been sent one.
  let ratingDmSent = false;
  const endedAt = new Date(match.date.getTime() + match.activity.matchDurationMins * 60 * 1000);
  // A cancelled match never happened (2026-10-28): nothing to rate.
  const hasHappened = match.status !== "CANCELLED" && (match.status === "COMPLETED" || new Date() >= endedAt);
  if (status === "CONFIRMED" && hasHappened) {
    const { getOrgFeatures } = await import("@/lib/org-features");
    const features = await getOrgFeatures(orgId);
    const rateKey = `${matchId}:rate-dm:${userId}`;
    const [momDone, already, u] = await Promise.all([
      db.sentNotification.findUnique({ where: { key: `${matchId}:mom-announcement` }, select: { id: true } }),
      db.sentNotification.findUnique({ where: { key: rateKey }, select: { id: true } }),
      db.user.findUnique({ where: { id: userId }, select: { phoneNumber: true } }),
    ]);
    if (features.playerRating && !momDone && !already && u?.phoneNumber) {
      const { signMagicLinkToken, MAGIC_LINK_TTL } = await import("@/lib/magic-link");
      const { buildShortMagicLinkUrl } = await import("@/lib/short-link");
      const token = signMagicLinkToken({ userId, purpose: "rate-match", matchId, ttlSeconds: MAGIC_LINK_TTL.rateMatch });
      const statsToken = signMagicLinkToken({ userId, purpose: "sign-in", nextPath: "/profile/stats", ttlSeconds: MAGIC_LINK_TTL.bookmark });
      const { buildRatingDm } = await import("@/lib/dm-copy");
      const { dayLabel } = await import("@/lib/i18n/dates");
      const { organisersPickMom } = await import("@/lib/mom-chooser");
      await db.botJob.create({
        data: {
          orgId,
          kind: "dm",
          phone: u.phoneNumber.replace(/^\+/, ""),
          text: buildRatingDm({
            activityName: match.activity.name,
            // The match's org language (`features` is that org's).
            dateLabel: dayLabel(features.language, match.date),
            lang: features.language,
            mvpLabel: match.activity.sport.mvpLabel,
            rateUrl: await buildShortMagicLinkUrl(token),
            statsUrl: await buildShortMagicLinkUrl(statsToken),
            // Same option as the scheduler's rating DM (bot-scheduler.ts
            // 6b): when the organisers pick Man of the Match, ratings only.
            ...(organisersPickMom(features) ? { momVote: false } : {}),
          }),
        },
      });
      await db.sentNotification.create({ data: { key: rateKey, kind: "rate-dm", matchId, targetUser: userId } });
      ratingDmSent = true;
    }
  }

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/admin/players");
  return { ok: true, userId, created: resolved.created, ratingDmSent };
}

/** Remove a player from a match's squad (e.g. added by mistake). Deletes
 *  the attendance row so they vanish from the squad + rating list. History
 *  in other matches is untouched. Admin-only. */
export async function removePlayerFromMatch(matchId: string, userId: string): Promise<{ ok: true }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { activity: { select: { orgId: true } } },
  });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  // A DELETION is a transition like any other, and it is the one the
  // old model lost completely: the row simply vanished, leaving nothing
  // to say a player was ever in this squad. `toStatus: null` records it.
  const priorRow = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { status: true, position: true },
  });
  await db.$transaction(async (tx) => {
    await tx.attendance.deleteMany({ where: { matchId, userId } });
    if (priorRow) {
      await recordAttendanceEvent(
        tx,
        {
          matchId,
          userId,
          orgId: match.activity.orgId,
          fromStatus: priorRow.status,
          toStatus: null,
          fromPosition: priorRow.position,
          toPosition: null,
        },
        {
          cause: "admin-squad-edit",
          actorKind: "admin",
          actorUserId: session.user!.id,
          sourceRef: "admin:removePlayerFromMatch",
          note: "attendance row deleted outright",
        },
      );
    }
  });
  // The one admin removal that does not go through `cancelAttendance` (it
  // deletes the row): a partner guest taken off here is told exactly as
  // there, by the same check (2026-10-22). Never fails the removal.
  if (priorRow && (priorRow.status === "CONFIRMED" || priorRow.status === "BENCH")) {
    try {
      const { tellGuestTakenOffByAdmin } = await import("@/lib/partner-guest");
      await tellGuestTakenOffByAdmin({ userId, matchId });
    } catch (err) {
      console.error("[players] partner guest check failed:", err instanceof Error ? err.message : "failed");
    }
  }
  revalidatePath(`/matches/${matchId}`);
  return { ok: true };
}

/** Squad-level "move up from bench": promote a BENCH player into the
 *  playing squad (status → CONFIRMED). Squad management only — does NOT
 *  assign a team (that's done in the teams section). Admin-only. */
export async function moveUpFromBench(matchId: string, userId: string): Promise<{ ok: true }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { activity: { select: { orgId: true } } },
  });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const priorRow = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { status: true, position: true },
  });
  await db.$transaction(async (tx) => {
    await tx.attendance.updateMany({
      where: { matchId, userId },
      data: { status: "CONFIRMED" },
    });
    if (priorRow) {
      await recordAttendanceEvent(
        tx,
        {
          matchId,
          userId,
          orgId: match.activity.orgId,
          fromStatus: priorRow.status,
          toStatus: "CONFIRMED",
          fromPosition: priorRow.position,
          toPosition: priorRow.position,
        },
        {
          cause: "admin-squad-edit",
          actorKind: "admin",
          actorUserId: session.user!.id,
          sourceRef: "admin:moveUpFromBench",
        },
      );
    }
  });
  revalidatePath(`/matches/${matchId}`);
  return { ok: true };
}

/**
 * ORGANISER PICK on the match page (slice 2b, plan 2.13): an admin brings
 * a player in from the waiting list. The same writer as a reply in the
 * admin channel (`applyOrganiserPick`), so the web, a DM and the admin
 * group have one writer, one set of posts (A1 to the admin channel with
 * this admin as the picker, A2 in the group, A3 to the player) and the
 * team-slot fill. Admin-only.
 */
export async function pickFromWaitingList(
  matchId: string,
  userId: string,
): Promise<{ ok: true; brought: boolean; full: boolean }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({ where: { id: matchId }, select: { activity: { select: { orgId: true } } } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);
  const { pickFromWaitingListAsAdmin } = await import("@/lib/organiser-pick");
  const res = await pickFromWaitingListAsAdmin({ matchId, userId, adminUserId: session.user.id });
  revalidatePath(`/matches/${matchId}`);
  return { ok: true, brought: res.applied.length > 0, full: res.applied.length === 0 && res.noPlaceFor.length > 0 };
}

/**
 * Reorder the waiting list (slice 2b, plan 2.13). Rewrites `position` for
 * BENCH rows only, reusing the positions they already hold, so confirmed
 * positions never move; one audit event per moved row. The next pick
 * message lists the waiting list in this order. Admin-only.
 */
export async function reorderWaitingList(matchId: string, orderedUserIds: string[]): Promise<{ ok: true; moved: number }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (!Array.isArray(orderedUserIds) || orderedUserIds.some((id) => typeof id !== "string")) {
    throw new Error("orderedUserIds must be a list of user ids");
  }
  const match = await db.match.findUnique({ where: { id: matchId }, select: { activity: { select: { orgId: true } } } });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);
  const { reorderWaitingListRows } = await import("@/lib/organiser-pick");
  const res = await reorderWaitingListRows({ matchId, orderedUserIds, adminUserId: session.user.id });
  revalidatePath(`/matches/${matchId}`);
  return { ok: true, moved: res.moved };
}
