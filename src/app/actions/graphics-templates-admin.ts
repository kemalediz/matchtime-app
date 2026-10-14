"use server";

/**
 * The platform owner shares a club's poster template with other clubs, or
 * stops sharing it (2026-10-14, /admin/clubs, "Poster designs").
 *
 * SUPERADMIN ONLY, checked here for real: the button is only on a page
 * that 404s for everybody else, but a server action is a public endpoint.
 * A shared template needs a display name that does not carry its club's
 * name (`displayNameProblem`): it is what other clubs see it called.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { setTemplateSharing } from "@/lib/club-graphics-store";
import { DISPLAY_NAME_MAX } from "@/lib/club-graphics-choice";

export interface TemplateSharingResult {
  ok: boolean;
  message: string;
}

const MESSAGES: Record<string, string> = {
  none: "That club has no poster template any more.",
  empty: "Give it a display name first: other clubs see this name.",
  "too-long": `Keep the display name to ${DISPLAY_NAME_MAX} characters.`,
  "names-club": "The display name must not carry the club's own name.",
  failed: "Could not save. Has the 20261014190000 migration been applied?",
};

export async function setTemplateSharingAction(orgId: string, shared: boolean, displayName: string): Promise<TemplateSharingResult> {
  const session = await auth();
  if (!session?.user?.id || !(await isSuperadmin(session.user.id))) throw new Error("Not allowed");
  const r = await setTemplateSharing(orgId, shared, displayName);
  revalidatePath("/admin/clubs");
  if (!r.ok) return { ok: false, message: MESSAGES[r.error] ?? "Could not save." };
  return { ok: true, message: shared ? "Shared with other clubs." : "No longer shared. Clubs that picked it are back on their own design or the default." };
}
