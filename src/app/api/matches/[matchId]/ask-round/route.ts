/**
 * POST /api/matches/<matchId>/ask-round (local player pool L5a,
 * 2026-10-24): the organisers' one-tap approval of a round, over HTTP. The
 * same call the match page's server action makes (`pool/ask-round.ts`),
 * for a client that is not the page (the sandboxed WhatsApp scenarios,
 * later the club's own tools). A signed-in OWNER or ADMIN of the match's
 * club only.
 *
 *   body  { partnershipIds?: string[], pool?: boolean, places: number }
 *   200   { partner: RoundResult | null, pool: PoolAskResult | null }
 *
 * TEST SEAMS, honoured only under MT_TEST_MODE=1: `x-test-now` (the clock)
 * and the pool switch (`pool/flags-request.ts`).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org";
import { requestAskRound } from "@/lib/pool/ask-round";
import { poolEnvForApiRequest } from "@/lib/pool/switch-env";

export const dynamic = "force-dynamic";

function nowOf(request: Request): Date {
  if (process.env.MT_TEST_MODE === "1") {
    const pinned = new Date(request.headers.get("x-test-now") ?? "");
    if (!Number.isNaN(pinned.getTime())) return pinned;
  }
  return new Date();
}

export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const match = await db.match.findUnique({ where: { id: matchId }, select: { activity: { select: { orgId: true } } } });
  if (!match) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await isOrgAdmin(session.user.id, match.activity.orgId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { partnershipIds?: unknown; pool?: unknown; places?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.partnershipIds) ? body.partnershipIds.filter((x): x is string => typeof x === "string") : [];
  const result = await requestAskRound({
    orgId: match.activity.orgId,
    matchId,
    partnershipIds: ids,
    pool: body.pool === true,
    places: Number(body.places),
    userId: session.user.id,
    now: nowOf(request),
    poolEnv: poolEnvForApiRequest(request),
  });
  return NextResponse.json(result);
}
