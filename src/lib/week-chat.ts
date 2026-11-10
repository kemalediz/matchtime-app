/**
 * A GROUP'S CHAT OF THE LAST WEEK, IN ONE PLACE (Kemal, 2026-11-10:
 * "recent chat should be all messages since last 1 week").
 *
 * Two readers, one loader:
 *
 *   - the rating adjuster (`team-generation.ts` `runRatingAdjuster`): the
 *     players' group's members, the week before kickoff, to read form
 *     ("pulled my hamstring this morning");
 *   - the open answer (`pipeline/open-answer.ts`): everything said in THE
 *     GROUP THE QUESTION WAS ASKED IN over the last 7 days, MatchTime's own
 *     lines included, so "what did Ali say about parking on Monday?" and
 *     "who's been the most active this week?" can be answered.
 *
 * WHERE EACH LINE LIVES (checked against prod, read only, 2026-11-10):
 *
 *   players' group, a member   `AnalyzedMessage` (this club, this group)
 *   players' group, MatchTime  not in `AnalyzedMessage` (the analyze
 *                              route records inbound messages only; none of
 *                              prod's last week was MatchTime's). Its
 *                              sends: a reply
 *                              (`SentNotification` kind `group-reply`, key
 *                              `greply:<orgId>:`), a scheduler post
 *                              (`group-message`, `group-poll`,
 *                              `bench-prompt` on one of this club's
 *                              matches, or keyed `org-<orgId>:`), and a
 *                              queued post (`BotJob` kind `group`,
 *                              `group-poll`). The words are the ones handed
 *                              to the Pi at claim time.
 *   HQ, a member               `AdminGroupMessage` (never the players'
 *                              group's rows kept in the same table)
 *   HQ, MatchTime              `AdminGroupMessage` `fromMatchTime` (its
 *                              logged questions), its replies
 *                              (`admin-group-reply`, `hqreply:<orgId>:`),
 *                              its scheduled posts (`admin-group-message`)
 *                              and queued posts (`BotJob` `admin-group`).
 *
 * THE TWO GROUPS NEVER MIX: the channel picks the tables, so an HQ line
 * cannot reach a players' group answer, or the other way round.
 *
 * The same words logged twice (HQ's log row and the send it records, a
 * second claim of one post) are shown once: MatchTime lines with the same
 * words within two minutes of each other. Our own two copies of one
 * string, never a person's words.
 *
 * NEWEST `WEEK_CHAT_MAX_LINES` OF THE WEEK, OLDEST FIRST: a busy group
 * keeps the lines that matter most (the match-day ones), as the adjuster
 * has since 2026-10-20.
 *
 * WHO WROTE IT: the member's roster name (`User.name`), never the WhatsApp
 * pushname a member chose; a line whose author the server never resolved
 * has no user. Phone numbers are scrubbed by the reader that shows the
 * lines to a model (`open-answer.ts`), never here.
 */
import { db } from "./db";
import { memberLabel, groupReplyKey, hqReplyKey, GROUP_REPLY_KIND, HQ_REPLY_KIND } from "./reply-context";
import { NOT_GROUP_ROWS } from "./admin-group-log";

import { WEEK_CHAT_MAX_LINES, WEEK_CHAT_MS } from "./week-chat-window";

export { WEEK_CHAT_DAYS, WEEK_CHAT_MAX_LINES, WEEK_CHAT_MS } from "./week-chat-window";
/** Two copies of MatchTime's words this close together are one line. */
const SAME_SEND_MS = 2 * 60 * 1000;
const COMPARE_CHARS = 500;

export type ChatChannel = "group" | "hq";

/** One line of a group's week, as stored. */
export interface WeekChatLine {
  /** The member who wrote it, when the server resolved them; null for
   *  MatchTime's lines and for an unresolved author. */
  user: { id: string; name: string | null } | null;
  fromMatchTime: boolean;
  body: string;
  at: Date;
}

/** The SentNotification kinds that are MatchTime's own posts in each group. */
const SEND_KINDS: Record<ChatChannel, string[]> = {
  group: ["group-message", "group-poll", "bench-prompt", GROUP_REPLY_KIND],
  hq: ["admin-group-message", HQ_REPLY_KIND],
};
/** The BotJob kinds that post in each group. */
const JOB_KINDS: Record<ChatChannel, string[]> = {
  group: ["group", "group-poll"],
  hq: ["admin-group"],
};

/**
 * THE LOADER. A group's lines since `since`, the newest `limit`, oldest
 * first. `includeMatchTime: false` is the members only (the adjuster).
 * `groupId` narrows the players' group to one WhatsApp group; `excludeIds`
 * leaves out messages the caller shows itself (this request's batch).
 */
export async function loadWeekChat(args: {
  orgId: string;
  channel: ChatChannel;
  since: Date;
  includeMatchTime: boolean;
  groupId?: string;
  excludeIds?: string[];
  limit?: number;
}): Promise<WeekChatLine[]> {
  const { orgId, channel, since } = args;
  const limit = args.limit ?? WEEK_CHAT_MAX_LINES;
  const exclude = args.excludeIds?.length ? { waMessageId: { notIn: args.excludeIds } } : {};

  const said: Array<{ userId: string | null; fromMatchTime: boolean; body: string; at: Date }> =
    channel === "group"
      ? (
          await db.analyzedMessage.findMany({
            where: { orgId, ...(args.groupId ? { groupId: args.groupId } : {}), createdAt: { gte: since }, body: { not: null }, ...exclude },
            orderBy: { createdAt: "desc" },
            take: limit,
            select: { authorUserId: true, body: true, createdAt: true },
          })
        ).map((r) => ({ userId: r.authorUserId, fromMatchTime: false, body: r.body ?? "", at: r.createdAt }))
      : (
          await db.adminGroupMessage.findMany({
            where: {
              orgId,
              createdAt: { gte: since },
              ...NOT_GROUP_ROWS,
              ...(args.includeMatchTime ? {} : { fromMatchTime: false }),
              ...exclude,
            },
            orderBy: { createdAt: "desc" },
            take: limit,
            select: { senderUserId: true, fromMatchTime: true, text: true, createdAt: true },
          })
        ).map((r) => ({ userId: r.fromMatchTime ? null : r.senderUserId, fromMatchTime: r.fromMatchTime, body: r.text ?? "", at: r.createdAt }));

  const sent = args.includeMatchTime ? await loadMatchTimeSends({ orgId, channel, since, limit }) : [];

  const ids = [...new Set(said.map((r) => r.userId).filter((x): x is string => !!x))];
  const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const userById = new Map(users.map((u) => [u.id, { id: u.id, name: u.name ?? null }]));

  const lines: WeekChatLine[] = [
    ...said.map((r) => ({ user: r.userId ? (userById.get(r.userId) ?? null) : null, fromMatchTime: r.fromMatchTime, body: r.body, at: r.at })),
    ...sent.map((s) => ({ user: null, fromMatchTime: true, body: s.body, at: s.at })),
  ];
  return newestOldestFirst(onceEach(lines), limit);
}

/** MatchTime's own posts in one club's group since `since`, newest `limit`. */
async function loadMatchTimeSends(args: { orgId: string; channel: ChatChannel; since: Date; limit: number }): Promise<Array<{ body: string; at: Date }>> {
  const { orgId, channel, since, limit } = args;
  const ownKey = channel === "group" ? groupReplyKey(orgId, "") : hqReplyKey(orgId, "");
  const [notes, jobs] = await Promise.all([
    db.sentNotification.findMany({
      where: {
        createdAt: { gte: since },
        kind: { in: SEND_KINDS[channel] },
        text: { not: null },
        // A queued post is read from its BotJob below, once.
        NOT: { key: { startsWith: "botjob-" } },
        OR: [{ key: { startsWith: ownKey } }, { key: { startsWith: `org-${orgId}:` } }, { match: { activity: { orgId } } }],
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { text: true, createdAt: true },
    }),
    db.botJob.findMany({
      where: { orgId, kind: { in: JOB_KINDS[channel] }, sentAt: { gte: since } },
      orderBy: { sentAt: "desc" },
      take: limit,
      select: { text: true, sentAt: true },
    }),
  ]);
  return [
    ...notes.map((n) => ({ body: n.text ?? "", at: n.createdAt })),
    ...jobs.map((j) => ({ body: j.text, at: j.sentAt as Date })),
  ];
}

const sameWords = (a: string, b: string) => a.trim().slice(0, COMPARE_CHARS).trim() === b.trim().slice(0, COMPARE_CHARS).trim();

/** PURE. MatchTime's same words logged twice within minutes: one line.
 *  Empty lines go too. */
export function onceEach(lines: WeekChatLine[]): WeekChatLine[] {
  const kept: WeekChatLine[] = [];
  const sorted = sortLines(lines.filter((l) => l.body.trim().length > 0));
  for (const l of sorted) {
    if (
      l.fromMatchTime &&
      kept.some((k) => k.fromMatchTime && Math.abs(k.at.getTime() - l.at.getTime()) <= SAME_SEND_MS && sameWords(k.body, l.body))
    ) {
      continue;
    }
    kept.push(l);
  }
  return kept;
}

/** Oldest first; at one instant a member's line before MatchTime's
 *  (MatchTime only ever speaks to what it has read), as HQ's log orders. */
function sortLines(lines: WeekChatLine[]): WeekChatLine[] {
  return [...lines].sort((a, b) => a.at.getTime() - b.at.getTime() || Number(a.fromMatchTime) - Number(b.fromMatchTime));
}

/** PURE. The newest `limit`, oldest first. */
export function newestOldestFirst(lines: WeekChatLine[], limit: number): WeekChatLine[] {
  return sortLines(lines).slice(-limit);
}

/** A line as the open answer shows it: MatchTime's as "MatchTime", a
 *  member's under the roster label, an unresolved author as null. */
export interface TimedChatLine {
  author: string | null;
  body: string;
  at: Date | null;
}

export function asChatLines(lines: WeekChatLine[]): TimedChatLine[] {
  return lines.map((l) => ({ author: l.fromMatchTime ? "MatchTime" : memberLabel(l.user?.name), body: l.body, at: l.at }));
}

/**
 * THE PLAYERS' GROUP'S WEEK for one analyze request: the stored week of
 * this group, then this request's own messages not yet stored (they are
 * written after the answer), under the label and words the route gives
 * them, so the open answer's own-line filter finds the question. The
 * newest `WEEK_CHAT_MAX_LINES` in all.
 */
export async function playersWeekChat(args: {
  orgId: string;
  groupId: string;
  now: Date;
  batch: Array<{ waMessageId: string; author: string | null; body: string; timestamp: string; stored: boolean }>;
}): Promise<TimedChatLine[]> {
  const fresh = args.batch.filter((m) => !m.stored);
  const stored = await loadWeekChat({
    orgId: args.orgId,
    channel: "group",
    groupId: args.groupId,
    since: new Date(args.now.getTime() - WEEK_CHAT_MS),
    includeMatchTime: true,
    excludeIds: fresh.map((m) => m.waMessageId),
  });
  const batch = fresh
    .filter((m) => m.body.trim().length > 0)
    .map((m) => {
      const t = Date.parse(m.timestamp);
      return { author: m.author, body: m.body, at: Number.isFinite(t) ? new Date(t) : args.now };
    });
  return [...asChatLines(stored), ...batch].slice(-WEEK_CHAT_MAX_LINES);
}

/** THE ADMIN GROUP'S WEEK (HQ): its log, MatchTime's lines included. The
 *  message being answered is already logged; it is left out here (it is
 *  shown once, last, as THE MESSAGE), as HQ's recent lines leave it out. */
export async function hqWeekChat(args: { orgId: string; now: Date; messageId: string }): Promise<TimedChatLine[]> {
  return asChatLines(
    await loadWeekChat({
      orgId: args.orgId,
      channel: "hq",
      since: new Date(args.now.getTime() - WEEK_CHAT_MS),
      includeMatchTime: true,
      excludeIds: [args.messageId],
    }),
  );
}
