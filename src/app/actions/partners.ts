"use server";

/**
 * Partner clubs on /admin/settings and /admin/clubs (cross-club ask,
 * slice S1, 2026-10-16). Plan: MDs/cross-club-player-ask-plan-2026-10-16.md,
 * sections 3.1 and 3.2.
 *
 * Every action proves who is asking here, for real (a server action is a
 * public endpoint): the club's OWNER or ADMIN for the settings page (the
 * pure rules then allow accept, decline and remove to OWNERS only), the
 * platform owner (superadmin) for its pause, resume and end override
 * (partner discovery P5: it no longer pairs clubs). The writes are
 * `src/lib/club-partnership.ts`, and the home venue
 * `src/lib/venue-location.ts`.
 *
 * Partner discovery (slice P1, 2026-10-22): the section is shown to every
 * club, with the two discovery switches and the club venue.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isSuperadmin, requireOrgAdmin } from "@/lib/org";
import {
  actOnPartnership,
  loadClubVenueStatus,
  loadDiscoverySettings,
  loadPartnerAskSettings,
  loadPartnershipsForOrg,
  platformActOnPartnership,
  saveDiscoverySettings,
  savePartnerAskSettings,
  setPartnerApproval,
  type ClubVenueStatus,
  type DiscoverySettings,
  type PartnerAskSettings,
  type PartnershipView,
} from "@/lib/club-partnership";
import { parsePlatformAction, type ClubRole, type PartnerApproval, type PartnershipAction, type PlatformAction } from "@/lib/club-partnership-rules";
import { setClubHomeVenueToPick } from "@/lib/venue-location";
import { parseVenuePick } from "@/lib/venue-suggest-rules";

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
  /** Partner discovery (P1): the two switches. */
  discovery: DiscoverySettings;
  /** Partner discovery (P1): the club's venue, for the prompt and the lookup. */
  venue: ClubVenueStatus;
}

/** The section's data, for every club (partner discovery, P1); null only
 *  when the club does not exist. Owners and admins only. */
export async function getPartnerClubs(orgId: string): Promise<PartnerClubsData | null> {
  const userId = await sessionUserId();
  const role = await roleIn(userId, orgId);
  const [partnerships, settings, discovery, venue] = await Promise.all([
    loadPartnershipsForOrg(orgId),
    loadPartnerAskSettings(orgId),
    loadDiscoverySettings(orgId),
    loadClubVenueStatus(orgId),
  ]);
  if (!settings || !discovery || !venue) return null;
  return { isOwner: role === "OWNER", partnerships, settings, discovery, venue };
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

/**
 * "Let nearby clubs find us and send requests" and "Accept partner
 * requests automatically" (P1). An owner or an admin; the writer checks the
 * role again and refuses anything that is not a real on or off.
 */
export async function saveDiscoverySettingsAction(
  orgId: string,
  patch: { discoverable?: boolean; autoAccept?: boolean },
): Promise<{ ok: true; settings: DiscoverySettings } | { ok: false; refusal: string }> {
  const userId = await sessionUserId();
  const role = await roleIn(userId, orgId);
  const r = await saveDiscoverySettings({ orgId, userId, role, patch });
  revalidatePath("/admin/settings");
  return r;
}

/**
 * The club venue (P1), ONLY from a place picked from the suggestions: the
 * pick's place id and session token are all that is read from the
 * browser, and the server asks Google what the place is. With no usable
 * pick nothing is looked up ("no-pick"): there is no postcode or town
 * entry (Kemal, 2026-10-22).
 */
export async function setClubHomeVenueAction(
  orgId: string,
  venuePick: { placeId: string; sessionToken?: string | null } | null,
): Promise<{ status: "found" | "capped" | "unresolved" | "no-pick" | "error" }> {
  const userId = await sessionUserId();
  await roleIn(userId, orgId);
  const pick = parseVenuePick(venuePick);
  if (!pick) return { status: "no-pick" };
  try {
    const r = await setClubHomeVenueToPick(orgId, userId, pick);
    revalidatePath("/admin/settings");
    return { status: r.status };
  } catch (err) {
    console.error(`[geocode] org=${orgId} home venue failed (${(err as Error)?.name ?? "error"})`);
    return { status: "error" };
  }
}

/** The platform owner's override on /admin/clubs/partners (P5): pause,
 *  resume or end any pairing. Superadmin only. */
export async function platformPartnershipAction(partnershipId: string, action: PlatformAction): Promise<{ ok: boolean; refusal?: string }> {
  const userId = await sessionUserId();
  if (!(await isSuperadmin(userId))) throw new Error("Not allowed");
  const parsed = parsePlatformAction(action);
  if (!parsed || typeof partnershipId !== "string") return { ok: false, refusal: "bad-action" };
  const r = await platformActOnPartnership({ partnershipId, action: parsed });
  revalidatePath("/admin/clubs/partners");
  return r.ok ? { ok: true } : { ok: false, refusal: r.refusal };
}
