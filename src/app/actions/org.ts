"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createOrgSchema } from "@/lib/validations";
import { setCurrentOrgId } from "@/lib/org";
import { revalidatePath } from "next/cache";

export async function createOrganisation(formData: { name: string; slug: string }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = createOrgSchema.parse(formData);

  const existing = await db.organisation.findUnique({ where: { slug: parsed.slug } });
  if (existing) throw new Error("This URL is already taken. Try a different one.");

  const org = await db.organisation.create({
    data: {
      name: parsed.name,
      slug: parsed.slug,
      memberships: {
        create: {
          userId: session.user.id,
          role: "OWNER",
        },
      },
    },
  });

  await setCurrentOrgId(org.id);
  revalidatePath("/");
  return { orgId: org.id, slug: org.slug };
}

export async function joinOrganisation(inviteCode: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const org = await db.organisation.findUnique({ where: { inviteCode } });
  if (!org) throw new Error("Invalid invite link");

  const existing = await db.membership.findUnique({
    where: { userId_orgId: { userId: session.user.id, orgId: org.id } },
  });

  if (existing) {
    await setCurrentOrgId(org.id);
    return { orgId: org.id, alreadyMember: true };
  }

  await db.membership.create({
    data: {
      userId: session.user.id,
      orgId: org.id,
      role: "PLAYER",
    },
  });

  await setCurrentOrgId(org.id);
  revalidatePath("/");
  return { orgId: org.id, alreadyMember: false };
}

/**
 * Permanently delete an organisation and everything attached to it.
 *
 * Authorised for: superadmin OR the org's OWNER. The caller must
 * additionally pass the org's slug as a typed confirmation so a stray
 * click on the UI button can't fire this — frontend collects it via a
 * confirm dialog.
 *
 * Used by the delete button on /admin/organisations.
 */
export async function deleteOrganisation(orgId: string, confirmSlug: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, slug: true },
  });
  if (!org) throw new Error("Organisation not found");
  if (org.slug !== confirmSlug) {
    throw new Error("Slug confirmation didn't match");
  }

  const { isSuperadmin } = await import("@/lib/org");
  const superuser = await isSuperadmin(session.user.id);
  if (!superuser) {
    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId: session.user.id, orgId } },
      select: { role: true, leftAt: true },
    });
    if (!membership || membership.leftAt !== null || membership.role !== "OWNER") {
      throw new Error("Only the org owner can delete an organisation");
    }
  }

  const { wipeOrg } = await import("@/lib/wipe-org");
  await wipeOrg(orgId);

  // If the deleted org was the current one, clear the cookie so the
  // next page load doesn't try to load a missing org.
  const { getCurrentOrgId } = await import("@/lib/org");
  const currentId = await getCurrentOrgId();
  if (currentId === orgId) {
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    cookieStore.delete("orgId");
  }

  revalidatePath("/admin/organisations");
  revalidatePath("/");
}

export async function switchOrg(orgId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  // Superadmins can switch to any org (even ones they're not a member of).
  const { isSuperadmin } = await import("@/lib/org");
  const superuser = await isSuperadmin(session.user.id);

  if (!superuser) {
    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId: session.user.id, orgId } },
    });
    if (!membership || membership.leftAt !== null) {
      throw new Error("Not a member of this organisation");
    }
  } else {
    const org = await db.organisation.findUnique({ where: { id: orgId } });
    if (!org) throw new Error("Organisation not found");
  }

  await setCurrentOrgId(orgId);
  revalidatePath("/");
}

/**
 * Toggle a single per-org feature module (Phase 1 — make the bot's
 * capabilities optional, per Kemal's promise to Amir's Thursday
 * group: MoM + ratings only). Admin-only. `paymentTracking` maps to
 * the pre-existing `paymentTrackingEnabled` column; the rest map to
 * `feature<Name>`.
 */
const FEATURE_COLUMN: Record<string, string> = {
  attendance: "featureAttendance",
  bench: "featureBench",
  teamBalancing: "featureTeamBalancing",
  momVoting: "featureMomVoting",
  playerRating: "featurePlayerRating",
  reminders: "featureReminders",
  statsQa: "featureStatsQa",
  paymentTracking: "paymentTrackingEnabled",
  paymentCollection: "paymentCollectionEnabled",
  payByBank: "payMethodPayByBank",
  payCard: "payMethodCard",
  payDirect: "payMethodDirect",
};

export async function setOrgFeature(
  orgId: string,
  feature: string,
  enabled: boolean,
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);

  const column = FEATURE_COLUMN[feature];
  if (!column) throw new Error(`Unknown feature: ${feature}`);

  await db.organisation.update({
    where: { id: orgId },
    data: { [column]: enabled },
  });
  revalidatePath("/admin/settings");
  return { feature, enabled };
}

/**
 * Org-admin override for the two team DISPLAY labels (index 0 = the
 * canonical RED slot, index 1 = YELLOW). Empty strings mean "use the
 * default" for that slot — the resolver (`resolveTeamLabels`) falls
 * back per-slot to the Sport's labels, then "Red"/"Yellow". Both
 * empty clears the override entirely.
 */
export async function setOrgTeamLabels(
  orgId: string,
  redLabel: string,
  yellowLabel: string,
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const { requireOrgAdmin } = await import("@/lib/org");
  await requireOrgAdmin(session.user.id, orgId);

  // Strip chars that would break WhatsApp markdown (we post `*${label}*`)
  // and keep names short enough for poll options / lineup posts.
  const clean = (s: string) => s.replace(/[*\n\r`]/g, "").trim().slice(0, 24);
  const red = clean(redLabel);
  const yellow = clean(yellowLabel);
  if (red && yellow && red.toLowerCase() === yellow.toLowerCase()) {
    throw new Error("The two team names must be different");
  }

  const teamLabels = !red && !yellow ? [] : [red, yellow];
  await db.organisation.update({
    where: { id: orgId },
    data: { teamLabels },
  });
  revalidatePath("/admin/settings");
  return { teamLabels };
}
