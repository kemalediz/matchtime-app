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
 *
 * TEST SEAMS (MT_TEST_MODE=1 only): `x-test-now` and `x-mt-test-pool-open`.
 */
import { claimGroupReplies } from "@/lib/group-reply-claims";
import { NextResponse } from "next/server";
import { handleAdminGroupMessage } from "@/lib/admin-group";
import { withMomRecordsScope } from "@/lib/mom-records-scope";
import { poolEnvForApiRequest } from "@/lib/pool/switch-env";
import { deletedAmong, enforceDeletes, withoutDeletedQuotes } from "@/lib/message-change";

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
  // A MESSAGE DELETED FOR EVERYONE (2026-11-15): one whose delete is
  // already recorded is not read, recorded or answered; a reply quoting one
  // carries no quote text, never the Pi's copy (`message-change.ts`).
  const inboundId = str(body.messageId);
  if (inboundId && (await deletedAmong(groupId, [{ id: inboundId, authorPhone: str(body.senderPhone) }])).has(inboundId)) {
    console.log(`[admin-group] ${groupId} ${inboundId}: deleted for everyone, not read`);
    return NextResponse.json({ ok: true, handled: false, ignored: "deleted", replyText: null });
  }
  const [quote] = await withoutDeletedQuotes(
    groupId,
    [{ quotedMessageId: str(body.quotedMessageId), quotedAuthorPhone: str(body.quotedAuthorPhone), quotedAuthorJid: str(body.quotedAuthorJid), quotedText: body.quotedText }],
    "quotedText",
  );
  body.quotedText = quote.quotedText;
  try {
    return await answerAdminGroup(request, body, groupId);
  } finally {
    // Its delete may have landed while this ran (the original and its
    // delete arriving together): whatever was written is cleared again.
    if (inboundId) await enforceDeletes(groupId, [inboundId]);
  }
}

async function answerAdminGroup(request: Request, body: Record<string, unknown>, groupId: string) {
  // TEST SEAMS, honoured only under MT_TEST_MODE=1: `x-test-now` (the
  // clock) and `x-mt-test-pool-open` (the pool switch, `pool/switch-env.ts`).
  let now: Date | undefined;
  if (process.env.MT_TEST_MODE === "1") {
    const pinned = new Date(request.headers.get("x-test-now") ?? "");
    if (!Number.isNaN(pinned.getTime())) now = pinned;
  }
  // Checked a string above; a closure does not keep that narrowing.
  const text: string = body.text;
  // One read of the club's Man of the Match records per message (`mom-records.ts`).
  const result = await withMomRecordsScope(async () => handleAdminGroupMessage({
    groupId,
    ...(now ? { now } : {}),
    poolEnv: await poolEnvForApiRequest(request),
    messageId: str(body.messageId),
    text,
    botMentioned: body?.botMentioned === true,
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
    // Every mentioned JID, raw (2026-11-09; Pi builds before it send none):
    // a tag the Pi could not name still counts ("@Match Time DM these people").
    ...(Array.isArray(body.mentions) ? { mentions: (body.mentions as unknown[]).filter((j): j is string => typeof j === "string").slice(0, 50) } : {}),
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
  }));
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
