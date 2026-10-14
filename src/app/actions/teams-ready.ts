"use server";

/**
 * "Teams ready" on /admin/settings (2026-10-14): when MatchTime proposes
 * the teams in the club's admin group on match day, as a London time
 * ("HH:MM") or "off". Not set: 10:00 when the club's organisers announce
 * the list and teams, else off. OWNER/ADMIN of the club only. The
 * behaviour lives in src/lib/team-proposal.ts.
 */
import { auth } from "@/lib/auth";
import { requireOrgAdmin } from "@/lib/org";
import { db } from "@/lib/db";
import { effectiveTeamsReadyTime, normaliseTeamsReadyTime } from "@/lib/team-proposal-rules";
import { organisersAnnounce } from "@/lib/list-announcer";
import { revalidatePath } from "next/cache";

async function requireAdminOf(orgId: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
}

export interface TeamsReadyStatus {
  /** "HH:MM" or "off": the time in force. */
  value: string;
  /** Not set by an organiser: the default for who announces (10:00 when
   *  the organisers announce, else off). */
  isDefault: boolean;
  /** The setting only does anything with an admin group linked. */
  adminGroupLinked: boolean;
  /** ...and for a weekly club. */
  weekly: boolean;
}

export async function getTeamsReady(orgId: string): Promise<TeamsReadyStatus | null> {
  await requireAdminOf(orgId);
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { teamsReadyTime: true, listAnnouncer: true, adminGroupId: true, squadMode: true },
  });
  if (!org) return null;
  return {
    value: effectiveTeamsReadyTime(org.teamsReadyTime, organisersAnnounce(org)),
    isDefault: org.teamsReadyTime == null,
    adminGroupLinked: !!org.adminGroupId,
    weekly: org.squadMode !== "monthly",
  };
}

export async function setTeamsReady(
  orgId: string,
  value: string,
): Promise<{ ok: true; value: string } | { ok: false; error: "bad-time" }> {
  await requireAdminOf(orgId);
  const next = normaliseTeamsReadyTime(value);
  if (!next) return { ok: false, error: "bad-time" };
  await db.organisation.update({ where: { id: orgId }, data: { teamsReadyTime: next } });
  revalidatePath("/admin/settings");
  return { ok: true, value: next };
}
