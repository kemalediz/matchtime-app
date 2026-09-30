"use server";

/**
 * The "Admin messages go to" section of /admin/settings (slice 2a,
 * 2026-09-30). Plan: MDs/friday-group-features-plan-2026-09-30.md,
 * sections 2.3 and 5. OWNER/ADMIN of the club only (`requireOrgAdmin`).
 * The choice itself is saved through `setWeeklyRoutine` (key
 * `adminChannel`) like every other weekly-routine setting; these are the
 * two flows around it (the link code, Unlink) and the status it polls.
 * The rules live in src/lib/admin-channel.ts and src/lib/admin-group-link.ts.
 */
import { auth } from "@/lib/auth";
import { requireOrgAdmin } from "@/lib/org";
import { loadAdminChannelStatus, type AdminChannelStatus } from "@/lib/admin-channel";
import { createAdminGroupLinkCode, unlinkAdminGroup } from "@/lib/admin-group-link";
import { revalidatePath } from "next/cache";

async function requireAdminOf(orgId: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
}

/** What the section shows. Polled while a code is on screen. */
export async function getAdminChannelStatusAction(orgId: string): Promise<AdminChannelStatus | null> {
  await requireAdminOf(orgId);
  return loadAdminChannelStatus(orgId);
}

/** "Link admin group": a new single-use code, valid 48 hours. */
export async function createAdminGroupLinkCodeAction(orgId: string): Promise<{ code: string; expiresAt: string }> {
  await requireAdminOf(orgId);
  const { code, expiresAt } = await createAdminGroupLinkCode(orgId);
  return { code, expiresAt: expiresAt.toISOString() };
}

/** "Unlink": clear the group, back to the owner by DM, and leave it. */
export async function unlinkAdminGroupAction(orgId: string): Promise<{ unlinked: boolean }> {
  await requireAdminOf(orgId);
  const r = await unlinkAdminGroup(orgId);
  revalidatePath("/admin/settings");
  return { unlinked: r.unlinked };
}
