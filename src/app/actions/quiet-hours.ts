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
import { retimeQuietHoursHolds } from "@/lib/quiet-hours-retime";
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
 * Off keeps the saved times, so switching back on restores them.
 *
 * Saving also re-times the club's unsent messages the OLD quiet hours were
 * holding (2026-10-28), in the same transaction: the rule and how a hold is
 * told apart from a deliberate schedule are in src/lib/quiet-hours-retime.ts.
 * Each update is guarded on the club, unsent, and the time read, so a job
 * the Pi sends meanwhile is never touched. Logs ids only.
 */
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
  const now = new Date();
  const { row, retimed } = await db.$transaction(async (tx) => {
    const before = await tx.organisation.findUnique({ where: { id: orgId }, select: QUIET_HOURS_SELECT });
    const row = await tx.organisation.update({ where: { id: orgId }, data, select: QUIET_HOURS_SELECT });
    const jobs = await tx.botJob.findMany({
      where: { orgId, sentAt: null, sendAfter: { gt: now } },
      select: { id: true, createdAt: true, sendAfter: true },
    });
    const changes = retimeQuietHoursHolds({ jobs, oldQuiet: quietHoursOf(before), newQuiet: quietHoursOf(row), now });
    const retimed: string[] = [];
    for (const c of changes) {
      const old = jobs.find((j) => j.id === c.id)!.sendAfter;
      const r = await tx.botJob.updateMany({
        where: { id: c.id, orgId, sentAt: null, sendAfter: old },
        data: { sendAfter: c.sendAfter },
      });
      if (r.count > 0) retimed.push(c.id);
    }
    return { row, retimed };
  });
  if (retimed.length) console.log(`[quiet-hours] org=${orgId} re-timed ${retimed.length} held job(s): ${retimed.join(",")}`);
  revalidatePath("/admin/settings");
  return { ok: true, value: quietHoursOf(row) };
}
