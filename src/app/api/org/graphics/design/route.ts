/**
 * CHOOSE THE CLUB'S POSTER DESIGN (2026-10-14).
 *
 *   POST /api/org/graphics/design   { "design": "matchtime" | "own" | "shared:<id>" }
 *
 * Owner or admin of the club only (403 otherwise). Only an option the
 * club's gallery offers is stored (`selectClubDesign`): 400 for anything
 * else, so another club's private template cannot be picked by its id.
 */
import { NextResponse } from "next/server";
import { clubGraphicsAccess } from "@/lib/club-graphics-access";
import { selectClubDesign } from "@/lib/club-graphics-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const access = await clubGraphicsAccess();
  if (!access.ok) return NextResponse.json({ ok: false, error: "not-allowed" }, { status: access.status });

  const body = (await req.json().catch(() => null)) as { design?: unknown } | null;
  const r = await selectClubDesign(access.orgId, body?.design, access.userId);
  if (!r.ok) return NextResponse.json(r, { status: r.error === "unavailable" ? 400 : 503 });
  return NextResponse.json(r);
}
