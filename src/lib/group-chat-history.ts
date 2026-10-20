/**
 * THE RECENT CHAT THE EXTRACTORS READ, BUILT FROM WHAT THE SERVER STORED
 * (Kemal, 2026-10-20).
 *
 * Until now the players' group's RECENT CHAT was the Pi's in-memory
 * buffer (`whatsapp-bot/src/smart-analysis.ts`, the last 15 lines per
 * group), sent with every batch. A Pi restart empties it: after the
 * 10:26:59 UTC restart on 2026-10-20 FNF's buffer held two lines when
 * Naim's "@Match Time out" was read. The server already stores every
 * message it analysed (`AnalyzedMessage`), so it builds the history
 * itself and the Pi's copy only fills what the server cannot know.
 *
 * WHAT A LINE IS:
 *   - a stored row of this group (the newest `GROUP_HISTORY_LINES`), in
 *     the words the pipeline read (mentions already named);
 *   - then this batch's own messages, in the order they arrived, so each
 *     is context for the OTHER messages of the batch. Every extractor
 *     drops the sender's own line by author AND body ("THE MESSAGE IS
 *     NOT ITS OWN CONTEXT", `extractForRoute`), so the route hands the
 *     extractor the same author label and body this line carries.
 *   - a line of the Pi's that matches neither: a message the server never
 *     stored. Kept as the Pi sent it, because the server has nothing
 *     better (the sim harness's seeded chat is exactly this).
 *
 * WHO WROTE IT: the member's ROSTER name, cleaned by `memberLabel` (the
 * quoted-reply rule from #341), never the WhatsApp pushname a member
 * chose for himself. A line whose author the server never resolved has no
 * name. Only a Pi line the server cannot vouch for keeps the Pi's label.
 *
 * NO LINE TWICE: a Pi line is the batch message with the same author and
 * the same WhatsApp second (the identity #343 introduced, both sides read
 * `messageTimestamp`), or the stored row with the same author (pushname,
 * as stored), the same words once each "@<digits>" token is allowed to be
 * the name it became, written within minutes after it. Each row matches
 * one line at most.
 *
 * Same size as before: 15 lines, the batch included, which is the Pi's
 * `HISTORY_PER_GROUP`; the extractor still shows the last 8 of them.
 * Nothing here changes the static prompt prefix: it is the user turn only.
 */
import { db } from "./db";
import { memberLabel } from "./reply-context";

/** The Pi's `HISTORY_PER_GROUP`, unchanged. */
export const GROUP_HISTORY_LINES = 15;

/** A stored row written this long BEFORE the Pi's timestamp is not that
 *  line (clock skew between the Pi and the server is seconds). */
const ROW_BEFORE_LINE_MS = 2 * 60 * 1000;
/** ...nor one written this long after it (a flush, a retry, a catch-up). */
const ROW_AFTER_LINE_MS = 6 * 60 * 60 * 1000;

/** One line of the extractors' RECENT CHAT. */
export interface ChatLine {
  author: string | null;
  body: string;
}

/** A line of the Pi's in-memory buffer, as it sends it. */
export interface PiHistoryLine {
  authorName: string | null;
  body: string;
  timestamp: string;
}

/** An `AnalyzedMessage` row of this group. */
export interface StoredChatLine {
  /** The pushname the row was stored with: only for matching a Pi line. */
  authorName: string | null;
  /** The roster label shown to the model. */
  author: string | null;
  body: string;
  at: Date;
}

/** A message of this batch. */
export interface BatchChatLine {
  /** Pushname and WhatsApp timestamp: only for matching the Pi's line. */
  authorName: string | null;
  timestamp: string;
  /** The roster label shown to the model (`chatAuthorOf`). */
  author: string | null;
  body: string;
  /** The server already has its row (a replay): the row is the line. */
  stored: boolean;
}

/** The author label of a resolved sender: the roster name, never a pushname. */
export function chatAuthorOf(sender: { userId: string | null; name: string | null } | null | undefined): string | null {
  return sender?.userId ? memberLabel(sender.name) : null;
}

function secondOf(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The Pi's line for this batch message (same author, same second). */
function isLineOf(line: PiHistoryLine, m: BatchChatLine): boolean {
  const s = secondOf(line.timestamp);
  return s !== null && (line.authorName ?? null) === (m.authorName ?? null) && secondOf(m.timestamp) === s;
}

const RAW_MENTION = /@\d{5,}/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The stored words are the Pi's words with each raw "@<digits>" named. */
function sameWords(piBody: string, storedBody: string): boolean {
  if (piBody === storedBody) return true;
  const parts = piBody.split(RAW_MENTION);
  if (parts.length === 1) return false;
  return new RegExp(`^${parts.map(escapeRe).join("[\\s\\S]*?")}$`).test(storedBody);
}

export function mergeGroupChatHistory(input: {
  pi: PiHistoryLine[];
  /** Oldest first. */
  stored: StoredChatLine[];
  /** In arrival order. */
  batch: BatchChatLine[];
  limit?: number;
}): ChatLine[] {
  const limit = input.limit ?? GROUP_HISTORY_LINES;
  const used = new Set<number>();
  const earlier: Array<ChatLine & { at: number }> = [];

  for (const line of input.pi) {
    if (input.batch.some((m) => isLineOf(line, m))) continue;
    const ts = Date.parse(line.timestamp);
    const t = Number.isFinite(ts) ? ts : 0;
    const i = input.stored.findIndex(
      (s, idx) =>
        !used.has(idx) &&
        (s.authorName ?? null) === (line.authorName ?? null) &&
        s.at.getTime() >= t - ROW_BEFORE_LINE_MS &&
        s.at.getTime() <= t + ROW_AFTER_LINE_MS &&
        sameWords(line.body, s.body),
    );
    if (i >= 0) {
      used.add(i);
      earlier.push({ at: t, author: input.stored[i].author, body: input.stored[i].body });
    } else {
      earlier.push({ at: t, author: line.authorName ?? null, body: line.body });
    }
  }
  input.stored.forEach((s, idx) => {
    if (!used.has(idx)) earlier.push({ at: s.at.getTime(), author: s.author, body: s.body });
  });
  // Stable: lines at the same instant keep the order they were added in.
  earlier.sort((a, b) => a.at - b.at);

  const lines: ChatLine[] = [
    ...earlier.map(({ author, body }) => ({ author, body })),
    ...input.batch.filter((m) => !m.stored).map(({ author, body }) => ({ author, body })),
  ].filter((l) => l.body.trim().length > 0);
  return lines.slice(-limit);
}

/** Roster labels for these users, one query. */
export async function rosterLabels(userIds: Array<string | null | undefined>): Promise<Map<string, string | null>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, memberLabel(u.name)]));
}

/** The group's newest stored lines, oldest first, leaving out `exclude`. */
export async function loadStoredGroupLines(args: {
  orgId: string;
  groupId: string;
  exclude: string[];
  limit?: number;
}): Promise<StoredChatLine[]> {
  const rows = await db.analyzedMessage.findMany({
    where: {
      orgId: args.orgId,
      groupId: args.groupId,
      ...(args.exclude.length ? { waMessageId: { notIn: args.exclude } } : {}),
      NOT: [{ body: null }, { body: "" }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: args.limit ?? GROUP_HISTORY_LINES,
    select: { authorUserId: true, authorName: true, body: true, createdAt: true },
  });
  rows.reverse();
  const labels = await rosterLabels(rows.map((r) => r.authorUserId));
  return rows.map((r) => ({
    authorName: r.authorName,
    author: r.authorUserId ? (labels.get(r.authorUserId) ?? null) : null,
    body: r.body ?? "",
    at: r.createdAt,
  }));
}

/**
 * The players' group's RECENT CHAT for one analyze request. A failed read
 * of the stored lines leaves the Pi's lines and the batch (what the
 * extractors had before), and is logged.
 */
export async function groupChatHistory(args: {
  orgId: string;
  groupId: string;
  pi: PiHistoryLine[];
  batch: Array<BatchChatLine & { waMessageId: string }>;
}): Promise<ChatLine[]> {
  let stored: StoredChatLine[] = [];
  try {
    stored = await loadStoredGroupLines({
      orgId: args.orgId,
      groupId: args.groupId,
      exclude: args.batch.filter((m) => !m.stored).map((m) => m.waMessageId),
    });
  } catch (err) {
    console.error(`[analyze] ${args.groupId}: stored chat not read, using the Pi's:`, err instanceof Error ? err.message : "failed");
  }
  return mergeGroupChatHistory({ pi: args.pi, stored, batch: args.batch });
}
