"use server";

/**
 * "Submit to Meta" on the owner's WhatsApp templates page
 * (/admin/whatsapp-templates). SUPERADMIN ONLY, checked here on every call:
 * the page's own 404 is not a guard for a server action, which anyone can
 * post to. Takes no input; the token stays on the server
 * (`lib/cloud-api/template-sync-admin.ts`).
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { submitCloudTemplates, type TemplateSubmit } from "@/lib/cloud-api/template-sync-admin";

const PAGE = "/admin/whatsapp-templates";

export async function submitCloudTemplatesAction(): Promise<TemplateSubmit | { state: "forbidden" }> {
  const userId = (await auth())?.user?.id;
  if (!userId || !(await isSuperadmin(userId))) return { state: "forbidden" };
  const r = await submitCloudTemplates();
  revalidatePath(PAGE);
  return r;
}
