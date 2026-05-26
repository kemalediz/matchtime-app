"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { onboardingSchema, playerPositionsSchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { normalisePhone } from "@/lib/phone";
import { mergePlayersCore } from "@/lib/merge-players-core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function completeOnboarding(formData: { name: string; phoneNumber?: string }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = onboardingSchema.parse(formData);

  await db.user.update({
    where: { id: session.user.id },
    data: {
      name: parsed.name,
      phoneNumber: parsed.phoneNumber || null,
      onboarded: true,
    },
  });

  redirect("/");
}

export async function updateProfile(formData: { name: string; phoneNumber?: string }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = onboardingSchema.parse(formData);

  await db.user.update({
    where: { id: session.user.id },
    data: {
      name: parsed.name,
      phoneNumber: parsed.phoneNumber || null,
    },
  });

  revalidatePath("/profile");
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

export async function updatePlayerRole(userId: string, orgId: string, role: "ADMIN" | "PLAYER") {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, orgId);

  await db.membership.update({
    where: { userId_orgId: { userId, orgId } },
    data: { role },
  });

  revalidatePath("/admin/players");
}

export async function seedPlayerRating(userId: string, orgId: string, rating: number) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, orgId);

  if (rating < 1 || rating > 10) throw new Error("Rating must be between 1 and 10");

  await db.user.update({
    where: { id: userId },
    data: { seedRating: rating },
  });

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
 * analyzed messages, and team assignments. Backfills `phoneNumber`,
 * `seedRating`, and `matchRating` from the drop record only when the
 * keep record is missing them. The drop user + memberships are deleted
 * at the end. Transactional — partial failures roll back.
 */
export async function mergePlayers(
  orgId: string,
  keepUserId: string,
  dropUserId: string,
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

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

  await db.$transaction(async (tx) => {
    await mergePlayersCore(tx, keepUserId, dropUserId, { saveAliasInOrgIds: [orgId] });
  });

  revalidatePath("/admin/players");
  revalidatePath("/admin");
}
export async function updatePlayerName(userId: string, orgId: string, name: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  const trimmed = name.trim();
  if (trimmed.length < 1) throw new Error("Name can't be empty");
  if (trimmed.length > 100) throw new Error("Name too long");

  // Confirm the player is in this org (stops cross-org renames).
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true },
  });
  if (!membership) throw new Error("Player is not a member of this organisation");

  await db.user.update({ where: { id: userId }, data: { name: trimmed } });

  revalidatePath("/admin/players");
}

/**
 * Admin: confirm that an auto-provisioned player is real. Clears the
 * provisionallyAddedAt flag so the "NEW" badge disappears. Does not
 * touch anything else — phone/positions/rating are edited via the
 * usual inputs on the same row.
 */
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
export async function removeProvisionalPlayer(userId: string, orgId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  await db.membership.update({
    where: { userId_orgId: { userId, orgId } },
    data: { leftAt: new Date(), provisionallyAddedAt: null },
  });

  revalidatePath("/admin/players");
  revalidatePath("/admin");
}

export async function updatePlayerPhone(userId: string, orgId: string, phone: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, orgId);

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true },
  });
  if (!membership) throw new Error("Player is not a member of this organisation");

  const normalised = normalisePhone(phone);
  if (!normalised) throw new Error("Phone number is not a valid international format");

  try {
    await db.user.update({ where: { id: userId }, data: { phoneNumber: normalised } });
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
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
      const isSyncOrphan =
        !!colliding &&
        colliding.id !== userId &&
        (colliding.name === null || colliding.name === "") &&
        typeof colliding.email === "string" &&
        colliding.email.startsWith("wa-sync+");
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
        return { phoneNumber: normalised, mergedSyncOrphan: colliding!.id };
      }
      throw new Error(
        `Phone number ${normalised} is already assigned to another player` +
          (colliding?.name ? ` (${colliding.name})` : ""),
      );
    }
    throw err;
  }

  revalidatePath("/admin/players");
  revalidatePath("/admin/players/phones");
  return { phoneNumber: normalised };
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

export async function addPlayerAlias(userId: string, orgId: string, rawAlias: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);

  const alias = aliasNorm(rawAlias);
  if (alias.length < 2) throw new Error("Alias must be at least 2 characters");
  if (alias.length > 40) throw new Error("Alias is too long");

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true },
  });
  if (!membership) throw new Error("Player is not a member of this organisation");

  // If alias is already taken by someone else in the org, surface it.
  const existing = await db.userAlias.findUnique({
    where: { orgId_alias: { orgId, alias } },
    select: { userId: true },
  });
  if (existing && existing.userId !== userId) {
    throw new Error(
      `Alias "${alias}" is already assigned to another player in this organisation`,
    );
  }
  if (existing && existing.userId === userId) {
    // Idempotent — already exists for this user.
    return { alias, alreadyExisted: true };
  }

  await db.userAlias.create({
    data: { orgId, userId, alias, source: "manual" },
  });
  revalidatePath("/admin/players");
  return { alias, alreadyExisted: false };
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
