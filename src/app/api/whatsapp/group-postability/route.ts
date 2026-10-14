/**
 * POST /api/whatsapp/group-postability (2026-10-14).
 *
 * The Pi says whether MatchTime can post in a group, as it last read it
 * from WhatsApp (whatsapp-bot/src/postability-report.ts): a group's first
 * reading in each process and every change of it. Body:
 *   { groupId, announce, communityAnnounce, botIsAdmin, canPost? }
 * `canPost` is the Pi's own conclusion and is NOT trusted: the server
 * decides from the three settings with the same rule
 * (group-postability-rules.ts). What the reading then does (a health
 * condition and one notice for a live club's group, the admin-notice
 * fallback for an admin group, finishing a held connect add) is
 * `recordGroupPostability` in src/lib/group-postability.ts.
 *
 * Auth via WHATSAPP_API_KEY, like the rest of /api/whatsapp/*.
 */
import { NextResponse } from "next/server";
import { parsePostabilityInput } from "@/lib/group-postability-rules";
import { recordGroupPostability } from "@/lib/group-postability";

export async function POST(request: Request) {
  if (request.headers.get("x-api-key") !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const groupId = typeof body?.groupId === "string" && body.groupId.endsWith("@g.us") ? body.groupId : null;
  const input = parsePostabilityInput(body);
  if (!groupId || !input) {
    return NextResponse.json({ error: "groupId, announce, communityAnnounce and botIsAdmin required" }, { status: 400 });
  }
  const r = await recordGroupPostability({ groupId, input });
  return NextResponse.json({
    ok: true,
    canPost: r.canPost,
    reason: r.reason,
    stored: r.stored,
    clubs: r.liveOrgs,
    adminGroups: r.adminOrgs,
    notices: r.noticesQueued,
    ...(r.resumed ? { resumed: r.resumed } : {}),
  });
}
