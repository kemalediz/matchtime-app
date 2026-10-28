"use server";

/**
 * A club's own "Player pool" switch on /admin/settings (2026-10-28,
 * decision log P.2; until then the platform owner switched it per club).
 *
 * OWNER or ADMIN of the club only (`requireOrgAdmin`), checked here: a
 * server action is a public endpoint. Shown, and saved, only while the
 * platform switch is on (`platform-switch.ts`, as this request resolves
 * it). The write, what OFF closes and the once-ever message to the admin
 * team are `setClubPlayerPool` (src/lib/pool/club-switch.ts).
 *
 * "use server" modules may export async functions only.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { requireOrgAdmin } from "@/lib/org";
import { db } from "@/lib/db";
import { setClubPlayerPool } from "@/lib/pool/club-switch";
import { isPoolOffersEnabled } from "@/lib/pool/flags";
import { poolEnvForRequest } from "@/lib/pool/switch-env";

async function requireAdminOf(orgId: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
}

/** Null: the card is not shown (the platform switch is off). */
export async function getClubPlayerPool(orgId: string): Promise<{ on: boolean } | null> {
  await requireAdminOf(orgId);
  if (!isPoolOffersEnabled(await poolEnvForRequest())) return null;
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { featurePlayerPool: true } });
  if (!org) return null;
  return { on: org.featurePlayerPool === true };
}

export type ClubPlayerPoolActionResult = { ok: true; on: boolean; closedAsks: number } | { ok: false; reason: "hidden" | "not-found" };

export async function setClubPlayerPoolAction(orgId: string, on: boolean): Promise<ClubPlayerPoolActionResult> {
  if (typeof orgId !== "string" || typeof on !== "boolean") throw new Error("Bad request");
  await requireAdminOf(orgId);
  if (!isPoolOffersEnabled(await poolEnvForRequest())) return { ok: false, reason: "hidden" };
  const r = await setClubPlayerPool(orgId, on);
  if (!r.ok) return { ok: false, reason: "not-found" };
  revalidatePath("/admin/settings");
  return { ok: true, on: r.on, closedAsks: r.closedAsks };
}
