"use server";

/**
 * The player pool's manage page actions (slice L2). Every one acts on the
 * SIGNED-IN person's own profile (the session's user id; nothing in the
 * request names whose), through src/lib/pool/manage.ts. The person reached
 * the page through his own signed link from MatchTime's WhatsApp reply.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { applyManageAction, deletePoolProfile, savePoolFields, setShowRecognition } from "@/lib/pool/manage";
import type { ManageAction } from "@/lib/pool/manage-rules";
import { POOL_MANAGE_PATH } from "@/lib/pool/paths";
import { validatePoolFields, type PoolFieldErrors } from "@/lib/pool/profile-fields";

type Result = { ok: true } | { ok: false; reason: string; errors?: PoolFieldErrors };

async function me(): Promise<string | null> {
  return (await auth())?.user?.id ?? null;
}

export async function savePoolProfileAction(payload: unknown): Promise<Result> {
  const userId = await me();
  if (!userId) return { ok: false, reason: "signed-out" };
  const valid = validatePoolFields(payload);
  if (!valid.ok) return { ok: false, reason: "invalid", errors: valid.errors };
  const res = await savePoolFields(userId, valid.value);
  revalidatePath(POOL_MANAGE_PATH);
  return res;
}

export async function poolManageAction(action: ManageAction, consent?: boolean): Promise<Result> {
  const userId = await me();
  if (!userId) return { ok: false, reason: "signed-out" };
  if (!["pause", "resume", "stop", "restart"].includes(action)) return { ok: false, reason: "invalid" };
  const res = await applyManageAction(userId, action, { consent: consent === true });
  revalidatePath(POOL_MANAGE_PATH);
  return res;
}

export async function setPoolRecognitionAction(show: boolean): Promise<Result> {
  const userId = await me();
  if (!userId) return { ok: false, reason: "signed-out" };
  const res = await setShowRecognition(userId, show === true);
  revalidatePath(POOL_MANAGE_PATH);
  return res;
}

export async function deletePoolProfileAction(): Promise<{ ok: true; userErased: boolean } | { ok: false; reason: string }> {
  const userId = await me();
  if (!userId) return { ok: false, reason: "signed-out" };
  return deletePoolProfile(userId);
}
