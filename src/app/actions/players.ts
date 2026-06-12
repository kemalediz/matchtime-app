"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { onboardingSchema, playerPositionsSchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { normalisePhone } from "@/lib/phone";
import { mergePlayersCore } from "@/lib/merge-players-core";
import { findExistingOrgMember } from "@/lib/resolve-player";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { format } from "date-fns";

/** Default seed rating for newly-created players — a neutral mid-point the
 *  team-balancer uses until they accumulate enough peer ratings. */
const DEFAULT_SEED_RATING = 6;

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
      await mergePlayersCore(tx, keepUserId, dropUserId, { saveAliasInOrgIds: [orgId] });
    },
    { timeout: 60_000 },
  );

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
      // Backfill a name if the record had none.
      if (name && !existing.name) {
        await db.user.update({ where: { id: existing.id }, data: { name } });
      }
      const mem = await db.membership.findUnique({
        where: { userId_orgId: { userId: existing.id, orgId } },
        select: { id: true, leftAt: true },
      });
      if (mem && !mem.leftAt) {
        return { ok: false, error: `That number already belongs to ${existing.name ?? "a player"} in this group.` };
      }
      if (mem && mem.leftAt) {
        await db.membership.update({ where: { id: mem.id }, data: { leftAt: null } });
        revalidatePath("/admin/players");
        return { ok: true, userId: existing.id, created: false, rejoined: true };
      }
      await db.membership.create({ data: { userId: existing.id, orgId, role: "PLAYER" } });
      revalidatePath("/admin/players");
      return { ok: true, userId: existing.id, created: false, rejoined: false };
    }

    if (!name) return { ok: false, error: "Please enter a name" };
    const placeholderEmail = `wa-${phone.replace(/^\+/, "")}@placeholder.matchtime`;
    const user = await db.user.create({
      data: { name, email: placeholderEmail, phoneNumber: phone, seedRating: DEFAULT_SEED_RATING, onboarded: false, isActive: true },
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
    data: { name, email, phoneNumber: null, seedRating: DEFAULT_SEED_RATING, onboarded: false, isActive: true },
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
        return { phoneNumber: normalised, mergedSyncOrphan: colliding!.id };
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
          phoneNumber: normalised,
          mergedProvisional: dropId,
          // When the admin's record was the one dropped, the UI needs to
          // navigate to the kept record — the page they were on is now
          // pointing at a merged-out User.
          redirectToUserId: keepCollidingSide ? keepId : undefined,
        };
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
 *  an active membership. New users default to seedRating 6. */
async function ensureOrgPlayer(
  orgId: string,
  input: { userId?: string; name?: string; phone?: string },
): Promise<{ ok: true; userId: string; created: boolean } | { ok: false; error: string }> {
  const name = (input.name ?? "").trim();

  if (input.userId) {
    const u = await db.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!u) return { ok: false, error: "Player not found" };
    await ensureMembership(u.id, orgId);
    return { ok: true, userId: u.id, created: false };
  }

  const phoneInput = (input.phone ?? "").trim();
  if (phoneInput) {
    const phone = normalisePhone(phoneInput);
    if (!phone) return { ok: false, error: "That doesn't look like a valid phone number" };
    const existing = await db.user.findUnique({ where: { phoneNumber: phone }, select: { id: true, name: true } });
    if (existing) {
      if (name && !existing.name) await db.user.update({ where: { id: existing.id }, data: { name } });
      await ensureMembership(existing.id, orgId);
      return { ok: true, userId: existing.id, created: false };
    }
    if (!name) return { ok: false, error: "Please enter a name" };
    const user = await db.user.create({
      data: { name, email: `wa-${phone.replace(/^\+/, "")}@placeholder.matchtime`, phoneNumber: phone, seedRating: DEFAULT_SEED_RATING, onboarded: false, isActive: true },
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
    data: { name, email, seedRating: DEFAULT_SEED_RATING, onboarded: false, isActive: true },
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

  const resolved = await ensureOrgPlayer(orgId, input);
  if (!resolved.ok) return resolved;
  const userId = resolved.userId;

  // Append at the end of the chosen status group.
  const last = await db.attendance.findFirst({
    where: { matchId, status },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  await db.attendance.upsert({
    where: { matchId_userId: { matchId, userId } },
    update: { status, position: (last?.position ?? 0) + 1 },
    create: { matchId, userId, status, position: (last?.position ?? 0) + 1 },
  });

  // Late rating-link DM — only when it still makes sense: the match has
  // happened, MoM isn't announced yet, the org rates players, and the
  // player is confirmed + has a phone + hasn't already been sent one.
  let ratingDmSent = false;
  const endedAt = new Date(match.date.getTime() + match.activity.matchDurationMins * 60 * 1000);
  const hasHappened = match.status === "COMPLETED" || new Date() >= endedAt;
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
      const statsToken = signMagicLinkToken({ userId, purpose: "sign-in", nextPath: "/profile/stats", ttlSeconds: MAGIC_LINK_TTL.permanent });
      const dlabel = format(match.date, "EEE d MMM");
      await db.botJob.create({
        data: {
          orgId,
          kind: "dm",
          phone: u.phoneNumber.replace(/^\+/, ""),
          text:
            `🏆 *${match.activity.name}* — ${dlabel}\n\n` +
            `Rate your teammates and pick ${match.activity.sport.mvpLabel}. Takes ~1 minute.\n\n` +
            `Your personal link:\n${await buildShortMagicLinkUrl(token)}\n\n` +
            `Link expires in 5 days.\n\n` +
            `📊 Your season stats (ratings, MoM, badges, share card) — any time:\n${await buildShortMagicLinkUrl(statsToken)}`,
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

  await db.attendance.deleteMany({ where: { matchId, userId } });
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

  await db.attendance.updateMany({
    where: { matchId, userId },
    data: { status: "CONFIRMED" },
  });
  revalidatePath(`/matches/${matchId}`);
  return { ok: true };
}
