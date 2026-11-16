/**
 * POST /api/whatsapp/message-change (2026-11-15).
 *
 * The Pi saw a group message deleted for everyone, or edited
 * (whatsapp-bot/src/message-change.ts). Body:
 *
 *   { kind: "revoke", chatId, messageId }
 *   { kind: "edit", chatId, messageId, text, senderJids?, senderPhone? }
 *
 * `messageId` is the BARE WhatsApp id; `chatId` the group. The stores are
 * changed by `applyMessageChange` (src/lib/message-change.ts), which says
 * what each one keeps. HOUSEKEEPING ONLY: nothing is analysed, replied,
 * reacted or sent, and the answer is counts, never words.
 *
 * Auth via WHATSAPP_API_KEY, like the rest of /api/whatsapp/*.
 */
import { NextResponse } from "next/server";
import { applyMessageChange, parseMessageChangeInput } from "@/lib/message-change";

export async function POST(request: Request) {
  if (request.headers.get("x-api-key") !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const input = parseMessageChangeInput(await request.json().catch(() => null));
  if (!input) {
    return NextResponse.json({ error: "kind, a group chatId and messageId required (and text for an edit)" }, { status: 400 });
  }
  try {
    const r = await applyMessageChange(input);
    console.log(
      `[message-change] ${input.kind} ${input.chatId} ${input.messageId}: analyzed=${r.analyzed} archived=${r.archived} ` +
        `hq=${r.hq} mentions=${r.mentions} editsRefused=${r.editsRefused}`,
    );
    return NextResponse.json({ ok: true, kind: input.kind, ...r });
  } catch (err) {
    console.error(`[message-change] ${input.kind} ${input.chatId} ${input.messageId}: not applied:`, err instanceof Error ? err.message : "failed");
    return NextResponse.json({ ok: false, error: "not applied" }, { status: 500 });
  }
}
