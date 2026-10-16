"use server";

/**
 * "Quiet hours" on /admin/settings (2026-10-16): whether MatchTime holds
 * the club's messages overnight, and from when to when (London). OWNER or
 * ADMIN of the club only. The behaviour is `quietHoursOf` and the gates
 * listed in src/lib/message-hours.ts.
 */
import { auth } from "@/lib/auth";
import { requireOrgAdmin } from "@/lib/org";
import { db } from "@/lib/db";
import { QUIET_HOURS_SELECT, quietHoursOf, validateQuietHours, type QuietHours } from "@/lib/message-hours";
import { revalidatePath } from "next/cache";

async function requireAdminOf(orgId: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
}

export async function getQuietHours(orgId: string): Promise<QuietHours | null> {
  await requireAdminOf(orgId);
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: QUIET_HOURS_SELECT });
  return org ? quietHoursOf(org) : null;
}

/** Off keeps the saved times, so switching back on restores them. */
export async function setQuietHours(
  orgId: string,
  input: { enabled: boolean; from?: string; to?: string },
): Promise<{ ok: true; value: QuietHours } | { ok: false; error: "bad-time" | "same-time" }> {
  await requireAdminOf(orgId);
  const v = validateQuietHours(input);
  if (!v.ok) return v;
  const data = v.value.enabled
    ? { quietHoursEnabled: true, quietHoursFrom: v.value.from, quietHoursTo: v.value.to }
    : { quietHoursEnabled: false };
  const row = await db.organisation.update({ where: { id: orgId }, data, select: QUIET_HOURS_SELECT });
  revalidatePath("/admin/settings");
  return { ok: true, value: quietHoursOf(row) };
}
