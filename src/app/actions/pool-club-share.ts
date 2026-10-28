"use server";

/**
 * "Tell your players about the player pool" on /admin/settings (growth
 * slice G3, 2026-10-24): the club's ONE share post. OWNER or ADMIN of the
 * club only. Shown, and sent, only while the club has the player pool
 * (`clubShareShown`). The organiser's tap is the approval; the rules are
 * src/lib/pool/club-share-rules.ts, the I/O src/lib/pool/club-share.ts.
 */
import { auth } from "@/lib/auth";
import { requireOrgAdmin } from "@/lib/org";
import { clubShareHeldLabel, loadClubShare, sendClubShare, type ClubShareCard } from "@/lib/pool/club-share";
import { revalidatePath } from "next/cache";
import { poolEnvForRequest } from "@/lib/pool/switch-env";

async function requireAdminOf(orgId: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
}

/** Null: the card is not shown for this club. */
export async function getClubShare(orgId: string): Promise<ClubShareCard | null> {
  await requireAdminOf(orgId);
  return loadClubShare(orgId, await poolEnvForRequest());
}

export type SendClubShareActionResult =
  | { ok: true; card: ClubShareCard | null; heldUntil: string | null }
  | { ok: false; reason: "not-shown" | "no-group" | "already-sent" | "no-code"; card: ClubShareCard | null };

export async function sendClubSharePost(orgId: string): Promise<SendClubShareActionResult> {
  await requireAdminOf(orgId);
  const env = await poolEnvForRequest();
  const res = await sendClubShare(orgId, new Date(), env);
  const card = await loadClubShare(orgId, env);
  if (!res.ok) return { ok: false, reason: res.reason, card };
  revalidatePath("/admin/settings");
  return { ok: true, card, heldUntil: res.sendAfter && card ? clubShareHeldLabel(card.language, res.sendAfter) : null };
}
