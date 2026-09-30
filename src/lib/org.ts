import { db } from "./db";
import { cookies } from "next/headers";

export async function getCurrentOrgId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get("orgId")?.value ?? null;
}

export async function setCurrentOrgId(orgId: string) {
  const cookieStore = await cookies();
  cookieStore.set("orgId", orgId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
}

/**
 * Make the club a magic link names the active one (2026-09-30).
 *
 * Called at magic-link sign-in. Only for an ACTIVE member of that club, or
 * the platform superadmin; anybody else keeps whatever club they had, and
 * the page's own admin gate still decides what they may see. Never throws:
 * a failure here must not break signing in. Returns whether it pinned.
 */
export async function pinOrgFromMagicLink(userId: string, orgId: string): Promise<boolean> {
  try {
    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      select: { leftAt: true },
    });
    const allowed = (membership && membership.leftAt === null) || (await isSuperadmin(userId));
    if (!allowed) return false;
    await setCurrentOrgId(orgId);
    return true;
  } catch (err) {
    console.error("[org] could not pin the club from a magic link:", err);
    return false;
  }
}

/** Is this user a superadmin? Cached per request via db call. */
export async function isSuperadmin(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { isSuperadmin: true },
  });
  return !!user?.isSuperadmin;
}

/**
 * Returns the active org the user is operating in, with membership info
 * when available. Resolution order:
 *
 *  1. The orgId in the `orgId` cookie, provided the user is a member OR
 *     is a superadmin (superadmins can scope to any org they like).
 *  2. The first non-left membership by createdAt.
 *  3. For superadmins with no memberships, the first Organisation on the
 *     platform.
 *
 * The returned `membership` is a fake synthesised object when the user is
 * a superadmin with no real membership — role = "ADMIN" so all admin
 * gates pass.
 */
export async function getUserOrg(userId: string) {
  const superuser = await isSuperadmin(userId);
  const orgId = await getCurrentOrgId();

  if (orgId) {
    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      include: { org: true },
    });
    if (membership && membership.leftAt === null) return membership;

    // Superadmin → synthesise a membership-shaped result for any org in DB
    if (superuser) {
      const org = await db.organisation.findUnique({ where: { id: orgId } });
      if (org) {
        return {
          id: `super-${userId}-${org.id}`,
          userId,
          orgId: org.id,
          org,
          role: "ADMIN" as const,
          leftAt: null,
          createdAt: new Date(0),
        };
      }
    }
  }

  // Fallback 1: user's first real membership
  const membership = await db.membership.findFirst({
    where: { userId, leftAt: null },
    include: { org: true },
    orderBy: { createdAt: "asc" },
  });
  if (membership) return membership;

  // Fallback 2: superadmin with zero memberships — grab the first org on
  // the platform so admin UIs still render.
  if (superuser) {
    const org = await db.organisation.findFirst({ orderBy: { createdAt: "asc" } });
    if (org) {
      return {
        id: `super-${userId}-${org.id}`,
        userId,
        orgId: org.id,
        org,
        role: "ADMIN" as const,
        leftAt: null,
        createdAt: new Date(0),
      };
    }
  }

  return null;
}

export async function isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
  // Superadmins pass every org-admin check.
  if (await isSuperadmin(userId)) return true;
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  if (!membership || membership.leftAt !== null) return false;
  return membership.role === "OWNER" || membership.role === "ADMIN";
}

export async function requireOrgAdmin(userId: string, orgId: string) {
  const admin = await isOrgAdmin(userId, orgId);
  if (!admin) throw new Error("Admin access required");
}

/**
 * Every OWNER + ADMIN of this org who has a phone number set. Used for
 * WhatsApp DM nudges (switch/cancel day-before, group_join/leave
 * auto-notifications, …). Excludes members whose `leftAt` is set — a
 * former admin shouldn't get op-notifications just because they're
 * still a membership row for history purposes.
 */
export async function findOrgAdminsWithPhone(
  orgId: string,
): Promise<Array<{ id: string; name: string | null; phoneNumber: string }>> {
  const memberships = await db.membership.findMany({
    where: { orgId, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
    include: { user: { select: { id: true, name: true, phoneNumber: true } } },
    orderBy: { role: "asc" },
  });
  return memberships
    .map((m) => m.user)
    .filter((u): u is { id: string; name: string | null; phoneNumber: string } => !!u.phoneNumber);
}
