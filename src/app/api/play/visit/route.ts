/**
 * POST /api/play/visit: the /play page's funnel beacon (visits 2026-11-03,
 * steps 2026-11-04). Public, as the rest of /api/play/. Answers 204 at once,
 * whatever it is sent, and counts AFTER the answer (`after`), so it never
 * slows the page.
 *
 * Body: `{ src, ref, step }`, `src` and `ref` as the page's own URL carried
 * them, read exactly as the page reads them (`readSignupSource`). `step` is
 * "opened" (or missing) or "started", the two only the browser sees; "sent"
 * and "confirmed" are counted by the server where they happen, so a body
 * naming them counts nothing (`readPoolPageStep`). The user agent decides
 * whether this is a link preview fetcher (`recordPoolVisit`) and is written
 * to the server log once per beacon to identify scanners (2026-11-06); it
 * is never stored.
 *
 * OUR OWN STAFF (2026-11-12): a beacon carrying the staff cookie, or a
 * session for an owner or admin, gets the same 204 and counts nothing
 * (`isPoolStaffVisit`). The session is looked up after the answer, and
 * only when there is no cookie; a lookup that fails counts the visit.
 */
import { after } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { getUserOrg, isOrgAdmin } from "@/lib/org";
import { readSignupSource } from "@/lib/pool/profile-fields";
import { POOL_STAFF_COOKIE, isPoolStaffVisit, readPoolPageStep } from "@/lib/pool/visit-rules";
import { recordPoolVisit } from "@/lib/pool/visits";

/** Would the admin pages let this request's session in? Their own check
 *  (`src/app/admin/layout.tsx`): the user's club, and an owner or admin of
 *  it; a superadmin passes both. */
async function adminSession(): Promise<boolean> {
  try {
    const userId = (await auth())?.user?.id;
    if (!userId) return false;
    const membership = await getUserOrg(userId);
    return !!membership && (await isOrgAdmin(userId, membership.orgId));
  } catch (err) {
    console.warn("[pool-funnel] staff check failed, counting:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function POST(request: Request) {
  const text = await request.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: plain /play.
  }
  const step = readPoolPageStep(body.step);
  if (!step) return new Response(null, { status: 204 });
  const source = readSignupSource(body);
  const userAgent = request.headers.get("user-agent");
  const now = new Date();
  const staffCookie = (await cookies()).get(POOL_STAFF_COOKIE)?.value ?? null;
  after(async () => {
    // The cookie decides without a database read; the session only without it.
    const staff = isPoolStaffVisit({ staffCookie, adminSession: false }) || isPoolStaffVisit({ staffCookie, adminSession: await adminSession() });
    if (staff) {
      console.info(`[pool-funnel] skipped staff visit step=${step} code=${source.campaignCode ?? "-"} ref=${source.referralCode ? "yes" : "no"}`);
      return;
    }
    await recordPoolVisit({ source, userAgent, now, step });
  });
  return new Response(null, { status: 204 });
}
