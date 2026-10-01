/**
 * A MESSAGE IN A CLUB'S ADMIN GROUP (slice 2a 2026-09-30, picks in 2b
 * 2026-10-01). Plan: MDs/friday-group-features-plan-2026-09-30.md,
 * sections 2.5 and 2.8.
 *
 * The Pi forwards every message in a linked admin group here at once,
 * flagged `channel: "admin-group"`, and never into the analysis history or
 * the analyze batch. MatchTime reads exactly one thing in an admin group:
 * an admin's reply to an open pick round (numbers, names, @tags, ALL,
 * NONE, YES to a pending question), and only as a WHOLE message. Anything
 * else is ignored with no reply:
 *
 *   - no open pick round for the club: ignored, whatever it says, tags
 *     included;
 *   - the sender (by phone, or a LID pair the server stored itself; never
 *     the pushname) is not an owner or admin of the club: ignored;
 *   - chat ("Wasim played well last week"): ignored.
 *
 * The answer, when there is one, goes back as `replyText`, which the Pi
 * posts in the same group. Idempotent per WhatsApp message id
 * (`admin-group-msg:<messageId>`), so a Pi retry never applies a pick
 * twice.
 *
 * NO MODEL, EVER. This module and its route import nothing that can reach
 * a model; `admin-group-no-model.source.test.ts` follows every import and
 * pins that.
 */
import { db } from "./db";
import { resolveSenderUserIds } from "./admin-group-link";
import { handlePickReply } from "./organiser-pick";
import { PICK_RACE_WINDOW_MS } from "./organiser-pick-rules";

export interface AdminGroupMessage {
  groupId: string;
  messageId?: string | null;
  text: string;
  senderPhone?: string | null;
  senderLid?: string | null;
  senderAltPhone?: string | null;
  timestamp?: string | null;
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
  now?: Date;
}

export type AdminGroupMessageResult =
  | { handled: false; ignored: "not-an-admin-group"; replyText: null }
  | {
      handled: false;
      ignored: "no-open-pick" | "not-an-admin" | "not-a-pick" | "duplicate";
      orgId: string;
      replyText: null;
    }
  | { handled: true; orgId: string; outcome: string | null; replyText: string | null };

function parseTimestamp(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const n = Number(ts);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function handleAdminGroupMessage(msg: AdminGroupMessage): Promise<AdminGroupMessageResult> {
  const now = msg.now ?? new Date();
  const org = await db.organisation.findFirst({ where: { adminGroupId: msg.groupId }, select: { id: true } });
  if (!org) return { handled: false, ignored: "not-an-admin-group", replyText: null };

  // Nothing open (or just filled, for the "Already filled" answer): the
  // group is the admins' own conversation, and it stays theirs.
  const round = await db.organiserPickRound.findFirst({
    where: {
      orgId: org.id,
      channel: "admin-group",
      OR: [{ resolvedAt: null }, { outcome: "filled", resolvedAt: { gte: new Date(now.getTime() - PICK_RACE_WINDOW_MS) } }],
    },
    select: { id: true },
  });
  if (!round) return { handled: false, ignored: "no-open-pick", orgId: org.id, replyText: null };

  const senderIds = await resolveSenderUserIds({
    phones: [msg.senderPhone, msg.senderAltPhone],
    lid: msg.senderLid ?? null,
  });
  const admin = senderIds.length
    ? await db.membership.findFirst({
        where: { orgId: org.id, userId: { in: senderIds }, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
        select: { userId: true },
      })
    : null;
  if (!admin) return { handled: false, ignored: "not-an-admin", orgId: org.id, replyText: null };

  if (msg.messageId) {
    try {
      await db.sentNotification.create({ data: { key: `admin-group-msg:${msg.messageId}`, kind: "admin-notice" } });
    } catch {
      return { handled: false, ignored: "duplicate", orgId: org.id, replyText: null };
    }
  }

  const outcome = await handlePickReply({
    orgId: org.id,
    door: "admin-group",
    senderUserId: admin.userId,
    text: msg.text,
    mentionNames: msg.mentionNames,
    sentAt: parseTimestamp(msg.timestamp),
    now,
  });
  if (!outcome.handled) return { handled: false, ignored: "not-a-pick", orgId: org.id, replyText: null };
  return { handled: true, orgId: org.id, outcome: outcome.outcome ?? null, replyText: outcome.replyText };
}
