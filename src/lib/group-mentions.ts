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
import { NAMED_ABOVE_LOOKBACK_MS, mentionsPurgeBefore, storedMentionsOf, type StoredMention } from "./named-invite-rules";

export interface MentionSource {
  waMessageId: string;
  /** WhatsApp's time for the message (ISO or Date); now when unreadable. */
  timestamp?: string | Date | null;
  mentions?: unknown;
  mentionNames?: unknown;
  botMentioned?: unknown;
  senderUserId?: string | null;
}

const asDate = (v: string | Date | null | undefined, fallback: Date): Date => {
  const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : fallback;
};

/** Remember who each message tagged. Messages that tagged nobody are skipped. */
export async function rememberMentions(args: { orgId: string; chatId: string; messages: MentionSource[]; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  const rows = args.messages
    .map((m) => ({ m, mentions: storedMentionsOf(m) }))
    .filter((x) => x.mentions.length > 0 && typeof x.m.waMessageId === "string" && x.m.waMessageId)
    .map(({ m, mentions }) => ({
      orgId: args.orgId,
      chatId: args.chatId,
      waMessageId: m.waMessageId,
      waStanzaId: bareWhatsAppId(m.waMessageId),
      senderUserId: m.senderUserId ?? null,
      mentions: mentions as unknown as object,
      sentAt: asDate(m.timestamp, now),
    }));
  if (rows.length === 0) return;
  try {
    await db.messageMentions.createMany({ data: rows, skipDuplicates: true });
  } catch (err) {
    console.error(`[group-mentions] ${args.orgId}: could not remember the mentions of ${rows.length} message(s):`, err instanceof Error ? err.message : err);
  }
}

const parse = (raw: unknown): StoredMention[] => storedMentionsOf({ mentionNames: raw });

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

/** The people tagged in the message a reply quotes, or null when MatchTime
 *  holds no record of it. */
export async function mentionsOfQuoted(orgId: string, quotedMessageId: string): Promise<StoredMention[] | null> {
  const bare = bareWhatsAppId(quotedMessageId);
  if (!bare) return null;
  try {
    const row = await db.messageMentions.findFirst({
      where: { orgId, OR: [{ waStanzaId: bare }, { waMessageId: quotedMessageId }] },
      orderBy: { sentAt: "desc" },
      select: { mentions: true },
    });
    return row ? parse(row.mentions) : null;
  } catch (err) {
    console.error(`[group-mentions] ${orgId}: the quoted message's mentions could not be read:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** The people tagged in the latest earlier message in this group that
 *  tagged anyone, within `NAMED_ABOVE_LOOKBACK_MS`, or null. */
export async function mentionsAbove(args: { orgId: string; chatId: string; before: Date; excludeWaMessageId: string }): Promise<StoredMention[] | null> {
  try {
    const row = await db.messageMentions.findFirst({
      where: {
        orgId: args.orgId,
        chatId: args.chatId,
        waMessageId: { not: args.excludeWaMessageId },
        sentAt: { lte: args.before, gte: new Date(args.before.getTime() - NAMED_ABOVE_LOOKBACK_MS) },
      },
      orderBy: { sentAt: "desc" },
      select: { mentions: true },
    });
    return row ? parse(row.mentions) : null;
  } catch (err) {
    console.error(`[group-mentions] ${args.orgId}: the earlier message's mentions could not be read:`, err instanceof Error ? err.message : err);
    return null;
  }
}
