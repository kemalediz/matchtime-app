"use server";

/**
 * "Ask the player pool automatically" on /admin/settings (pool slice L9,
 * 2026-10-24): `Organisation.poolAutoAsk`, off by default. OWNER or ADMIN
 * of the club only. Shown, and saved, only while the club may ask the
 * player pool (`poolAutoAskShown`); the rule that uses it is
 * src/lib/pool/auto-ask-rules.ts.
 */
import { auth } from "@/lib/auth";
import { requireOrgAdmin } from "@/lib/org";
import { db } from "@/lib/db";
import { parsePoolAutoAsk, poolAutoAskShown } from "@/lib/pool/auto-ask-rules";
import { revalidatePath } from "next/cache";
import { poolEnvForRequest } from "@/lib/pool/switch-env";

async function requireAdminOf(orgId: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
}

/** Null: the card is not shown for this club. */
export async function getPoolAutoAsk(orgId: string): Promise<{ on: boolean } | null> {
  await requireAdminOf(orgId);
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { featurePlayerPool: true, poolAutoAsk: true } });
  if (!poolAutoAskShown(org, await poolEnvForRequest())) return null;
  return { on: org!.poolAutoAsk === true };
}

export async function setPoolAutoAsk(orgId: string, input: unknown): Promise<{ ok: true; on: boolean } | { ok: false }> {
  await requireAdminOf(orgId);
  const parsed = parsePoolAutoAsk(input);
  if (!parsed.ok) return { ok: false };
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { featurePlayerPool: true } });
  if (!poolAutoAskShown(org, await poolEnvForRequest())) return { ok: false };
  await db.organisation.update({ where: { id: orgId }, data: { poolAutoAsk: parsed.value } });
  revalidatePath("/admin/settings");
  return { ok: true, on: parsed.value };
}
