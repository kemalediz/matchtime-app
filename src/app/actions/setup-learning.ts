"use server";

/**
 * F3, learned setup (2026-10-05): the /admin/settings panel's data and its
 * one-tap Undo. OWNER/ADMIN of the club only (`requireOrgAdmin`). The
 * rules are in src/lib/setup-learning/view.ts.
 */
import { auth } from "@/lib/auth";
import { requireOrgAdmin } from "@/lib/org";
import { loadLearnedSetupView, undoLearnedSetting, type LearnedSetupView, type UndoResult } from "@/lib/setup-learning/view";
import { revalidatePath } from "next/cache";

async function requireAdminOf(orgId: string): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  await requireOrgAdmin(session.user.id, orgId);
}

export async function getLearnedSetupAction(orgId: string): Promise<LearnedSetupView | null> {
  await requireAdminOf(orgId);
  return loadLearnedSetupView(orgId);
}

export async function undoLearnedSettingAction(orgId: string, key: string): Promise<UndoResult> {
  await requireAdminOf(orgId);
  const r = await undoLearnedSetting(orgId, key);
  if (r.ok) revalidatePath("/admin/settings");
  return r;
}
