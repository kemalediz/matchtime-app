/**
 * POST /api/whatsapp/admin-group (slice 2a, 2026-09-30).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.5 and 2.8.
 *
 * Every message in a club's linked admin group, forwarded by the Pi at
 * once and flagged `channel: "admin-group"`:
 *
 *   { channel, groupId, messageId, text, mentionNames, senderPhone,
 *     senderLid, senderAltPhone, timestamp,
 *     quotedMessageId?, quotedText?, quotedFromMatchTime? }
 *
 * Never mixed into the players' group's analysis history or batch. An
 * owner's or admin's message is read by the same pipeline as the players'
 * group, with the organisers' group context (`src/lib/admin-group.ts`).
 */
import { claimGroupReplies } from "@/lib/group-reply-claims";
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
    mentionNames: Array.isArray(body.mentionNames)
      ? (body.mentionNames as unknown[])
          .filter((m): m is { jid: string; name?: string; phone?: string } => !!m && typeof (m as { jid?: unknown }).jid === "string")
          .map((m) => ({
            jid: m.jid,
            ...(typeof m.name === "string" ? { name: m.name } : {}),
            ...(typeof m.phone === "string" ? { phone: m.phone } : {}),
          }))
      : undefined,
    // A WhatsApp reply (2026-10-16): what it quotes, and whether the Pi saw
    // that the quoted message was MatchTime's own. Older Pis send none.
    quoted:
      str(body.quotedMessageId) || str(body.quotedText) || body.quotedFromMatchTime === true
        ? {
            messageId: str(body.quotedMessageId),
            text: typeof body.quotedText === "string" ? body.quotedText.slice(0, 2000) : null,
            fromMatchTime: body.quotedFromMatchTime === true,
            // Who wrote it, from the Pi's contact lookup (slice S4): unverified.
            authorName: str(body.quotedAuthorName),
            authorPhone: str(body.quotedAuthorPhone),
          }
        : null,
  });
  // MatchTime's HQ reply is claimed like its other posts (review of #341,
  // finding 3): the Pi acks it with `replyKey`, the ack stamps the stanza
  // id on the claim and on the HQ log line with the same words, and a YES
  // quoting it is then decided by its id.
  const orgId = (result as { orgId?: string }).orgId;
  const replyText = (result as { replyText?: string | null }).replyText;
  const messageId = str(body.messageId);
  let replyKey: string | undefined;
  if (orgId && messageId && typeof replyText === "string" && replyText.trim()) {
    const keys = await claimGroupReplies({ orgId, door: "hq", replies: [{ inboundId: messageId, text: replyText, matchId: null }] }).catch(
      () => new Map<string, string>(),
    );
    replyKey = keys.get(messageId);
  }
  return NextResponse.json({ ok: true, ...result, ...(replyKey ? { replyKey } : {}) });
}
