"use server";

/**
 * Partner clubs on /admin/settings and /admin/clubs (cross-club ask,
 * slice S1, 2026-10-16). Plan: MDs/cross-club-player-ask-plan-2026-10-16.md,
 * sections 3.1 and 3.2.
 *
 * Every action proves who is asking here, for real (a server action is a
 * public endpoint): the club's OWNER or ADMIN for the settings page (the
 * pure rules then allow accept, decline and remove to OWNERS only), the
 * platform owner (superadmin) for pairing two clubs. The writes are
 * `src/lib/club-partnership.ts`.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isSuperadmin, requireOrgAdmin } from "@/lib/org";
import {
  actOnPartnership,
  createPartnership,
  loadPartnerAskSettings,
  loadPartnershipsForOrg,
  savePartnerAskSettings,
  setPartnerApproval,
  type PartnerAskSettings,
  type PartnershipView,
} from "@/lib/club-partnership";
import type { ClubRole, PartnerApproval, PartnershipAction } from "@/lib/club-partnership-rules";

async function sessionUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  return session.user.id;
}

/** The caller's role in the club, after proving they are an owner or admin
 *  (a superadmin with no membership reads as ADMIN, as everywhere). */
async function roleIn(userId: string, orgId: string): Promise<ClubRole> {
  await requireOrgAdmin(userId, orgId);
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { role: true, leftAt: true } });
  return m && !m.leftAt && m.role === "OWNER" ? "OWNER" : "ADMIN";
}

export interface PartnerClubsData {
  /** Accept, decline and remove are the owner's. */
  isOwner: boolean;
  partnerships: PartnershipView[];
  settings: PartnerAskSettings;
}

/** The section's data, or null when the club has no partner clubs (the
 *  section is then not shown at all). */
export async function getPartnerClubs(orgId: string): Promise<PartnerClubsData | null> {
  const userId = await sessionUserId();
  const role = await roleIn(userId, orgId);
  const [partnerships, settings] = await Promise.all([loadPartnershipsForOrg(orgId), loadPartnerAskSettings(orgId)]);
  if (partnerships.length === 0 || !settings) return null;
  return { isOwner: role === "OWNER", partnerships, settings };
}

export async function actOnPartnershipAction(
  orgId: string,
  partnershipId: string,
  action: PartnershipAction,
): Promise<{ ok: boolean; refusal?: string }> {
  const userId = await sessionUserId();
  const role = await roleIn(userId, orgId);
  const r = await actOnPartnership({ partnershipId, orgId, userId, role, action });
  revalidatePath("/admin/settings");
  return r.ok ? { ok: true } : { ok: false, refusal: r.refusal };
}

export async function setPartnerApprovalAction(
  orgId: string,
  partnershipId: string,
  value: PartnerApproval,
): Promise<{ ok: boolean }> {
  const userId = await sessionUserId();
  await roleIn(userId, orgId);
  const r = await setPartnerApproval({ partnershipId, orgId, value });
  revalidatePath("/admin/settings");
  return { ok: r.ok };
}

export async function savePartnerAskSettingsAction(
  orgId: string,
  patch: { when?: string; time?: string; cutoffHours?: number },
): Promise<{ ok: true; settings: PartnerAskSettings } | { ok: false; refusal: string }> {
  const userId = await sessionUserId();
  await roleIn(userId, orgId);
  const r = await savePartnerAskSettings(orgId, patch);
  revalidatePath("/admin/settings");
  return r;
}

const CREATE_MESSAGES: Record<string, string> = {
  "same-club": "A club cannot be its own partner.",
  exists: "Those two clubs are already paired in that direction.",
  "no-club": "One of those clubs no longer exists.",
};

/** The platform owner pairs two clubs, one direction (D1, D2). */
export async function createPartnershipAction(askerOrgId: string, partnerOrgId: string): Promise<{ ok: boolean; message: string }> {
  const userId = await sessionUserId();
  if (!(await isSuperadmin(userId))) throw new Error("Not allowed");
  const r = await createPartnership({ creatorUserId: userId, askerOrgId, partnerOrgId });
  revalidatePath("/admin/clubs/partners");
  if (!r.ok) return { ok: false, message: CREATE_MESSAGES[r.refusal] ?? "Could not pair them." };
  return {
    ok: true,
    message: r.reopened ? "Paired again. Both owners have been asked to accept." : "Paired. Both owners have been asked to accept.",
  };
}
