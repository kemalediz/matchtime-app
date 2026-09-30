/**
 * POST /api/whatsapp/admin-group-link (slice 2a, 2026-09-30).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.3 and 2.5.
 *
 * The Pi forwards a message shaped like "@Match Time admin group CODE"
 * from a group that is not a live club's group and not an admin group
 * (including a SILENT group: this is the one narrow exception to the
 * silence rail), and from a club's own group (so it can be refused with
 * L3 instead of reaching the model):
 *
 *   { groupId, messageId, text, botMentioned, senderPhone, senderAltPhone,
 *     senderLid, groupSubject?, timestamp }
 *
 * The server decides everything (`linkAdminGroup`). The answer:
 *   { ok, outcome, replyText, adminGroup? }
 * `replyText` is posted in the group by the Pi; `adminGroup` tells the Pi
 * to treat the group as an admin group at once, not at its next /orgs
 * refresh. Anyone who is not an owner or admin of an approved club gets
 * `replyText: null` whatever they sent.
 *
 * No model anywhere on this path. A server built before slice 2a answers
 * 404, which the Pi logs; nothing is posted.
 */
import { NextResponse } from "next/server";
import { linkAdminGroup } from "@/lib/admin-group-link";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function POST(request: Request) {
  if (request.headers.get("x-api-key") !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const groupId = str(body?.groupId);
  const text = typeof body?.text === "string" ? body.text : null;
  if (!groupId || !groupId.endsWith("@g.us") || text === null) {
    return NextResponse.json({ error: "groupId and text required" }, { status: 400 });
  }
  const result = await linkAdminGroup({
    groupId,
    text,
    botMentioned: body?.botMentioned === true,
    senderPhone: str(body?.senderPhone),
    senderAltPhone: str(body?.senderAltPhone),
    senderLid: str(body?.senderLid),
    groupSubject: str(body?.groupSubject),
  });
  console.log(`[admin-group-link] ${groupId}: ${result.outcome}${"reason" in result ? ` (${result.reason})` : ""}`);
  return NextResponse.json({ ok: true, ...result });
}
