/**
 * WHO A GROUP MESSAGE TAGGED, KEPT FOR "DM THE PEOPLE ABOVE" (2026-11-09).
 *
 * The thin store behind `named-invite-rules.ts`. The analyze route (the
 * players' group) and `admin-group.ts` (HQ) remember, for every message they
 * are shown that tags anyone but MatchTime, the mentions the Pi forwarded
 * with it. "@Match Time DM them", quoting that message, finds it by the
 * quoted stanza id; "@Match Time DM the people above" finds the latest
 * earlier one in the same group. Nothing here reads words.
 *
 * BEST-EFFORT, BOTH WAYS. A failed write (the table not yet migrated, a
 * blip) loses only this feature for that message, never the message: every
 * function here catches and logs, and a failed read is "nobody found".
 * Logs carry ids and counts only.
 *
 * KEPT 7 DAYS, then deleted by the daily cron (`purgeOldMentions` below,
 * `MESSAGE_MENTIONS_RETENTION_DAYS`): the rows hold WhatsApp ids, phones and
 * names, and nothing reads them after the request they were kept for.
 */
import { db } from "./db";
import { bareWhatsAppId } from "./quoted-message";
import {
  NAMED_ABOVE_LOOKBACK_MS,
  mentionsPurgeBefore,
  storedMentionsOf,
  taggedAnyone,
  taggedPeopleOf,
  type TaggedSource,
} from "./named-invite-rules";

export interface MentionSource {
  waMessageId: string;
  /** WhatsApp's time for the message (ISO or Date); now when unreadable. */
  timestamp?: string | Date | null;
  mentions?: unknown;
  mentionNames?: unknown;
  botMentioned?: unknown;
  senderUserId?: string | null;
  /** The sender's WhatsApp name, for "From Shane's message" when MatchTime
   *  does not know the sender as a member. */
  authorName?: string | null;
}

/** A stored message's tags, with when it was sent. */
export type StoredTags = TaggedSource & { sentAt: Date };

const asDate = (v: string | Date | null | undefined, fallback: Date): Date => {
  const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : fallback;
};

/** The row kept for one message, or null when it tagged nobody. Exported for
 *  the route's same-flush "above", which reads the batch without the table. */
export function storedTagsOf(m: MentionSource, now: Date): StoredTags | null {
  const t = taggedPeopleOf(m);
  if (!taggedAnyone(t)) return null;
  const name = typeof m.authorName === "string" && m.authorName.trim() ? m.authorName.trim().slice(0, 60) : null;
  return { ...t, senderName: name, sentAt: asDate(m.timestamp, now) };
}

/**
 * Remember who each message tagged. Messages that tagged nobody are
 * skipped; a message that tagged only people the Pi could not name is kept
 * (`unidentified`), so "the people above" stops at it (review #1).
 */
export async function rememberMentions(args: { orgId: string; chatId: string; messages: MentionSource[]; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  const rows = args.messages
    .filter((m) => typeof m.waMessageId === "string" && m.waMessageId)
    .map((m) => ({ m, tags: storedTagsOf(m, now) }))
    .filter((x): x is { m: MentionSource; tags: StoredTags } => x.tags !== null)
    .map(({ m, tags }) => ({
      orgId: args.orgId,
      chatId: args.chatId,
      waMessageId: m.waMessageId,
      waStanzaId: bareWhatsAppId(m.waMessageId),
      senderUserId: m.senderUserId ?? null,
      senderName: tags.senderName,
      mentions: tags.mentions as unknown as object,
      unidentified: tags.unidentified,
      sentAt: tags.sentAt,
    }));
  if (rows.length === 0) return;
  try {
    await db.messageMentions.createMany({ data: rows, skipDuplicates: true });
  } catch (err) {
    console.error(`[group-mentions] ${args.orgId}: could not remember the mentions of ${rows.length} message(s):`, err instanceof Error ? err.message : err);
  }
}

/**
 * RETENTION (2026-11-09): delete who was tagged once the message is
 * MESSAGE_MENTIONS_RETENTION_DAYS (7) old. Run by the daily 06:00 cron
 * (`api/cron/close-ratings`). Total: a failure is logged and counted as 0,
 * so the cron's other housekeeping still runs.
 */
export async function purgeOldMentions(now: Date = new Date()): Promise<number> {
  try {
    const r = await db.messageMentions.deleteMany({ where: { sentAt: { lt: mentionsPurgeBefore(now) } } });
    if (r.count) console.log(`[group-mentions] deleted ${r.count} row(s) older than the retention`);
    return r.count;
  } catch (err) {
    console.error("[group-mentions] the retention sweep failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

type Row = { mentions: unknown; unidentified: number; senderUserId: string | null; senderName: string | null; sentAt: Date; orgId: string };
const ROW_SELECT = { mentions: true, unidentified: true, senderUserId: true, senderName: true, sentAt: true, orgId: true } as const;

/** A row as tags; the sender named by this club's name for them when they
 *  are a current member, else by the WhatsApp name kept with the row. */
async function toTags(row: Row): Promise<StoredTags> {
  let senderName = row.senderName;
  if (row.senderUserId) {
    const m = await db.membership
      .findFirst({ where: { orgId: row.orgId, userId: row.senderUserId, leftAt: null }, select: { user: { select: { name: true } } } })
      .catch(() => null);
    if (m?.user.name?.trim()) senderName = m.user.name.trim();
  }
  return { mentions: storedMentionsOf({ mentionNames: row.mentions }), unidentified: Math.max(0, row.unidentified ?? 0), senderName, sentAt: row.sentAt };
}

/** The people tagged in the message a reply quotes, or null when MatchTime
 *  holds no record of it. */
export async function mentionsOfQuoted(orgId: string, quotedMessageId: string): Promise<StoredTags | null> {
  const bare = bareWhatsAppId(quotedMessageId);
  if (!bare) return null;
  try {
    const row = await db.messageMentions.findFirst({
      where: { orgId, OR: [{ waStanzaId: bare }, { waMessageId: quotedMessageId }] },
      orderBy: { sentAt: "desc" },
      select: ROW_SELECT,
    });
    return row ? await toTags(row) : null;
  } catch (err) {
    console.error(`[group-mentions] ${orgId}: the quoted message's mentions could not be read:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** The latest stored message in this group that tagged anyone, sent
 *  STRICTLY before `before` (review #5) and within NAMED_ABOVE_LOOKBACK_MS,
 *  or null. The request's own flush is read by the caller (`pickAbove`). */
export async function mentionsAbove(args: { orgId: string; chatId: string; before: Date; excludeWaMessageIds: string[] }): Promise<StoredTags | null> {
  try {
    const row = await db.messageMentions.findFirst({
      where: {
        orgId: args.orgId,
        chatId: args.chatId,
        waMessageId: { notIn: args.excludeWaMessageIds },
        sentAt: { lt: args.before, gte: new Date(args.before.getTime() - NAMED_ABOVE_LOOKBACK_MS) },
      },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      select: ROW_SELECT,
    });
    return row ? await toTags(row) : null;
  } catch (err) {
    console.error(`[group-mentions] ${args.orgId}: the earlier message's mentions could not be read:`, err instanceof Error ? err.message : err);
    return null;
  }
}
