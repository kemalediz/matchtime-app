/**
 * POST /api/whatsapp/bot-removed (self-join slice 6, 2026-09-29).
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, section 5.7.
 *
 * The Pi saw MatchTime itself removed from a group in its silent set:
 *   { groupId }
 * A club waiting for approval goes back to draft (the organiser's card
 * offers the button again; the owner's pending item reads "removed"), and
 * an unsolicited group is marked left. No DMs to anyone.
 *
 * Only ever about silent groups: the Pi forwards nothing for a group a
 * live club owns, and the handler only reads requests whose club is
 * PENDING, so an approved club (Sutton FC) cannot be moved from here.
 *
 * Behind SELF_JOIN_ENABLED. A Pi built before slice 6 never calls it; a
 * server built before it answers 404, which the Pi logs and ignores.
 */
import { NextResponse } from "next/server";
import { handleBotRemoved } from "@/lib/group-add";
import { selfJoinEnabledForApiRequest } from "@/lib/self-join-flag";

export async function POST(request: Request) {
  if (request.headers.get("x-api-key") !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { groupId?: unknown } | null;
  const groupId = typeof body?.groupId === "string" && body.groupId.endsWith("@g.us") ? body.groupId : null;
  if (!groupId) return NextResponse.json({ error: "groupId required" }, { status: 400 });
  if (!selfJoinEnabledForApiRequest(request)) {
    return NextResponse.json({ ok: true, ignored: "self-join-disabled" });
  }
  const result = await handleBotRemoved(groupId);
  return NextResponse.json({ ok: true, ...result });
}
