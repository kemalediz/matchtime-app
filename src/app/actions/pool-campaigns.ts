"use server";

/**
 * The owner's campaign codes (pool slice G1): create a code and switch one
 * on or off. SUPERADMIN ONLY, checked here on every call (the page's own
 * 404 is not a guard for a server action, which anyone can post to).
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { createPoolCampaign, setPoolCampaignActive, type CreateCampaignResult } from "@/lib/pool/campaigns";

const PAGE = "/admin/pool/campaigns";

async function owner(): Promise<boolean> {
  const userId = (await auth())?.user?.id;
  return !!userId && (await isSuperadmin(userId));
}

export async function createPoolCampaignAction(input: unknown): Promise<CreateCampaignResult | { ok: false; reason: "forbidden" }> {
  if (!(await owner())) return { ok: false, reason: "forbidden" };
  const res = await createPoolCampaign(input);
  if (res.ok) revalidatePath(PAGE);
  return res;
}

export async function setPoolCampaignActiveAction(code: unknown, active: unknown): Promise<{ ok: boolean }> {
  if (!(await owner()) || typeof code !== "string" || typeof active !== "boolean") return { ok: false };
  const ok = await setPoolCampaignActive(code, active);
  if (ok) revalidatePath(PAGE);
  return { ok };
}
