/**
 * POST /api/whatsapp/admin-group (slice 2a, 2026-09-30).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.5 and 2.8.
 *
 * Every message in a club's linked admin group, forwarded by the Pi at
 * once and flagged `channel: "admin-group"`:
 *
 *   { channel, groupId, messageId, text, mentionNames, senderPhone,
 *     senderLid, senderAltPhone, timestamp }
 *
 * Never analysed, never a model call: this route imports no model path
 * (`src/lib/__tests__/admin-group-no-model.source.test.ts`). In slice 2a
 * nothing is open to act on, so the answer is always "ignored" with no
 * reply; slice 2b reads the organisers' picks here.
 */
import { NextResponse } from "next/server";
import { handleAdminGroupMessage } from "@/lib/admin-group";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function POST(request: Request) {
  if (request.headers.get("x-api-key") !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const groupId = str(body?.groupId);
  if (!groupId || !groupId.endsWith("@g.us") || typeof body?.text !== "string") {
    return NextResponse.json({ error: "groupId and text required" }, { status: 400 });
  }
  const result = await handleAdminGroupMessage({
    groupId,
    messageId: str(body.messageId),
    text: body.text,
    senderPhone: str(body.senderPhone),
    senderLid: str(body.senderLid),
    senderAltPhone: str(body.senderAltPhone),
    timestamp: str(body.timestamp),
  });
  return NextResponse.json({ ok: true, ...result });
}
