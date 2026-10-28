/**
 * The player pool banner on every signed-in page (2026-10-28), through
 * `src/lib/pool/banner.ts`. Both are for the SIGNED-IN person (the
 * session's user id; nothing in the request names whose).
 *
 *   GET   his banner for this request, or null. The platform switch is
 *         resolved per request (`poolEnvForRequest`), never cached.
 *   POST  {"kind":"join"|"share"}: "Not interested", for good.
 *
 * Plain route handlers rather than server actions: the banner sits in the
 * app shell and is read on every page change, and a fetch never touches
 * the router, so it cannot interfere with the navigation it runs beside.
 */
import { auth } from "@/lib/auth";
import { getUserOrg } from "@/lib/org";
import { dismissPoolBanner, loadPoolBanner } from "@/lib/pool/banner";
import { poolEnvForRequest } from "@/lib/pool/switch-env";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  const userId = (await auth())?.user?.id;
  if (!userId) return Response.json(null, { headers: NO_STORE });
  try {
    const [env, current] = await Promise.all([poolEnvForRequest(), getUserOrg(userId)]);
    return Response.json(await loadPoolBanner(userId, { env, currentOrgId: current?.orgId ?? null }), { headers: NO_STORE });
  } catch (err) {
    // The banner is never worth breaking a page for.
    console.warn(`[pool-banner] load failed: ${(err as Error).message?.split("\n")[0]}`);
    return Response.json(null, { headers: NO_STORE });
  }
}

export async function POST(request: Request): Promise<Response> {
  const userId = (await auth())?.user?.id;
  if (!userId) return Response.json({ ok: false, reason: "signed-out" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { kind?: unknown } | null;
  const kind = body && typeof body === "object" && !Array.isArray(body) ? body.kind : undefined;
  if (kind !== "join" && kind !== "share") return Response.json({ ok: false, reason: "bad-request" }, { status: 400 });
  const res = await dismissPoolBanner(userId, kind);
  return Response.json(res, { status: res.ok ? 200 : 503 });
}
