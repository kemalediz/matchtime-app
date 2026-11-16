/**
 * POST /api/whatsapp/message-change (2026-11-15).
 *
 * The Pi saw a group message deleted for everyone, or edited by its author
 * after it was sent for analysis (whatsapp-bot/src/message-change.ts). Body:
 *
 *   { kind: "revoke", chatId, messageId, byAdmin, senderJids, senderPhone }
 *   { kind: "edit",   chatId, messageId, senderJids, senderPhone }
 *
 * An edit carries NO words, old or new (any sent are dropped): it is a
 * purge of the original. `messageId` is the BARE WhatsApp id; `chatId` the
 * group (only a group linked to a club is recorded). The stores are changed
 * by `applyMessageChange` (src/lib/message-change.ts), which says what each
 * one keeps. HOUSEKEEPING ONLY: nothing is analysed, replied, reacted or
 * sent, and the answer is counts, never words.
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
    return NextResponse.json({ error: "kind (revoke or edit), a group chatId and messageId required" }, { status: 400 });
  }
  try {
    const r = await applyMessageChange(input);
    console.log(
      `[message-change] ${input.kind} ${input.chatId} ${input.messageId}: analyzed=${r.analyzed} archived=${r.archived} ` +
        `hq=${r.hq} mentions=${r.mentions} notes=${r.notes} refused=${r.refused}`,
    );
    return NextResponse.json({ ok: true, kind: input.kind, ...r });
  } catch (err) {
    console.error(`[message-change] ${input.kind} ${input.chatId} ${input.messageId}: not applied:`, err instanceof Error ? err.message : "failed");
    return NextResponse.json({ ok: false, error: "not applied" }, { status: 500 });
  }
}
