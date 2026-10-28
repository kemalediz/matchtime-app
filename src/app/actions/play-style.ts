"use server";

/**
 * "Style of play" on /admin/settings (pool slice L5b, 2026-10-24): the
 * club's own word for its games on a pool offer. OWNER or ADMIN of the club
 * only. Shown, and saved, only while the club may ask the player pool
 * (`playStyleShown`); the rule and the values are src/lib/pool/play-style.ts.
 */
import { auth } from "@/lib/auth";
import { requireOrgAdmin } from "@/lib/org";
import { db } from "@/lib/db";
import { parsePlayStyle, playStyleShown } from "@/lib/pool/play-style";
import type { PlayStyle } from "@/lib/pool/vocab";
import { revalidatePath } from "next/cache";
import { poolEnvForRequest } from "@/lib/pool/switch-env";

async function requireAdminOf(orgId: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
}

/** Null: the card is not shown for this club. */
export async function getPlayStyle(orgId: string): Promise<{ value: PlayStyle | null } | null> {
  await requireAdminOf(orgId);
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { featurePlayerPool: true, playStyle: true } });
  if (!playStyleShown(org, await poolEnvForRequest())) return null;
  const parsed = parsePlayStyle(org!.playStyle);
  return { value: parsed.ok ? parsed.value : null };
}

export async function setPlayStyle(orgId: string, input: unknown): Promise<{ ok: true; value: PlayStyle | null } | { ok: false }> {
  await requireAdminOf(orgId);
  const parsed = parsePlayStyle(input);
  if (!parsed.ok) return { ok: false };
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { featurePlayerPool: true } });
  if (!playStyleShown(org, await poolEnvForRequest())) return { ok: false };
  await db.organisation.update({ where: { id: orgId }, data: { playStyle: parsed.value } });
  revalidatePath("/admin/settings");
  return { ok: true, value: parsed.value };
}
