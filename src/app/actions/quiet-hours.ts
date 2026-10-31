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
import { QUIET_HOURS_SELECT, quietHoursOf, type QuietHours } from "@/lib/message-hours";
import { saveQuietHours } from "@/lib/quiet-hours-save";
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

/**
 * Off keeps the saved times, so switching back on restores them. Saving
 * also re-times the club's unsent messages the OLD quiet hours were holding
 * (2026-10-28), in the same transaction: the one core is `saveQuietHours`
 * (src/lib/quiet-hours-save.ts), which an organiser tagging MatchTime in
 * WhatsApp uses too (2026-10-31).
 */
export async function setQuietHours(
  orgId: string,
  input: { enabled: boolean; from?: string; to?: string },
): Promise<{ ok: true; value: QuietHours } | { ok: false; error: "bad-time" | "same-time" }> {
  await requireAdminOf(orgId);
  const r = await saveQuietHours({ orgId, input, now: new Date() });
  if (!r.ok) return r;
  revalidatePath("/admin/settings");
  return { ok: true, value: r.value };
}
