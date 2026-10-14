/**
 * WHO MAY USE THE POSTERS CARD (2026-10-14): its state, its previews,
 * choosing a design, uploading or removing a background.
 *
 * The OWNER or ADMIN of the club the request is operating in (`getUserOrg`,
 * the same club /admin/settings shows), and the platform superadmin
 * (`seesAdminFields`). Anyone else signed in is 403; nobody signed in 401;
 * signed in with no club, 404. The routes under /api/org/graphics call this
 * first and act only on the club it returns, never on an id from the
 * request.
 */
import { auth } from "@/lib/auth";
import { getUserOrg } from "@/lib/org";
import { seesAdminFields } from "@/lib/admin-view";

export type ClubGraphicsAccess =
  | { ok: true; userId: string; orgId: string; clubName: string; lang: string | null }
  | { ok: false; status: 401 | 403 | 404 };

export async function clubGraphicsAccess(): Promise<ClubGraphicsAccess> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, status: 401 };
  const membership = await getUserOrg(userId);
  if (!membership) return { ok: false, status: 404 };
  if (!(await seesAdminFields(userId, membership.role))) return { ok: false, status: 403 };
  return { ok: true, userId, orgId: membership.orgId, clubName: membership.org.name, lang: membership.org.language ?? null };
}
