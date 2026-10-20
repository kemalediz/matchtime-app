/**
 * WHICH MATCHTIME MESSAGE A REPLY QUOTES (quoted-reply context, slices S0
 * and S1, 2026-10-20; Kemal approved the direction that day).
 *
 * When a player swipe-replies to one of MatchTime's DMs, the Pi forwards
 * three structured facts WhatsApp gives it (never a reading of words): the
 * quoted message's bare stanza id ("3EB0..."), its text, and whether it was
 * MatchTime's own (`quotedMessageId`, `quotedText`, `quotedFromMatchTime`,
 * the same fields the group doors carry). This module turns them into the
 * message we sent: when, its words, what it was about and its match.
 *
 * Resolution:
 *   1. A SentNotification whose stanza id is the quoted one, from the last
 *      14 days, sent to THIS person (a scheduler DM's `targetUser` has their
 *      phone; a BotJob DM's own `phone` is theirs). `waStanzaId` is indexed;
 *      a row from before it was filled is found on its serialised
 *      `waMessageId` and compared on the stanza id (`sameWhatsAppMessage`).
 *   2. Its words: the claim's stored `text`, else the BotJob's `text`, else
 *      the Pi's quoted text. Its topic: `topicOfDueKey(key)`.
 *   3. Nothing stored, but the Pi says it was MatchTime's: the Pi's text,
 *      with time, topic and match unknown (an inline reply is never acked,
 *      so it has no row).
 *
 * S0/S1 change no behaviour: the dm-reply route only LOGS what this
 * resolves (ids, topic, match, resolved yes/no, never text). Slice S2 adds
 * the renderer and hands the result to the DM classifiers.
 *
 * DB-free: the client is an argument (a structural type Prisma satisfies),
 * so the classifier modules and their dry runs can import it without
 * importing Prisma.
 */
import { topicOfDueKey, type DueKeyTopic } from "./due-key-feature";
import { botJobIdOfKey } from "./dispatch-claim";
import { LAST_DM_LOOKBACK_MS } from "./last-bot-dm";
import { e164Digits } from "./phone";
import { bareWhatsAppId, sameWhatsAppMessage } from "./quoted-message";

/** How far back a quoted MatchTime message is still looked up. */
export const QUOTE_LOOKBACK_MS = LAST_DM_LOOKBACK_MS;

/** The most of the Pi's quoted text the server keeps (the Pi caps at the same). */
export const QUOTED_TEXT_MAX = 2000;

/** A reply's quote as the Pi forwards it. */
export interface DmQuote {
  /** The quoted message's bare WhatsApp id, when the Pi had one. */
  id: string | null;
  /** The quoted message's text, as WhatsApp carried it. */
  text: string | null;
  /** The Pi saw it was MatchTime's own message. */
  fromMatchTime: boolean;
}

/** The MatchTime message a reply quotes. `key` is null when it was not
 *  found among our sends (the Pi's word and text only). */
export interface QuotedBotMessage {
  key: string | null;
  sentAt: Date | null;
  text: string | null;
  topic: DueKeyTopic | null;
  matchId: string | null;
}

/** The quote fields on a dm-reply body, or null when the DM is not a
 *  reply. An older Pi sends none of them, so it always gets null. */
export function parseDmQuote(body: unknown): DmQuote | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { quotedMessageId?: unknown; quotedText?: unknown; quotedFromMatchTime?: unknown };
  const id = typeof b.quotedMessageId === "string" && b.quotedMessageId.trim() ? b.quotedMessageId.trim() : null;
  const text = typeof b.quotedText === "string" && b.quotedText.trim() ? b.quotedText.trim().slice(0, QUOTED_TEXT_MAX) : null;
  const hasFlag = typeof b.quotedFromMatchTime === "boolean";
  if (!id && !text && !hasFlag) return null;
  return { id, text, fromMatchTime: b.quotedFromMatchTime === true };
}

interface SentRow {
  key: string;
  matchId: string | null;
  targetUser: string | null;
  waMessageId: string | null;
  waStanzaId: string | null;
  text: string | null;
  createdAt: Date;
}

/** The reads the resolver makes, as a structural type so a test can hand
 *  in a fake. Prisma's client satisfies it. */
export interface ReplyContextDb {
  sentNotification: {
    findMany(args: {
      where: {
        createdAt: { gte: Date };
        OR: Array<
          | { waStanzaId: string }
          | { waStanzaId: null; waMessageId: string }
          | { waStanzaId: null; waMessageId: { contains: string } }
        >;
      };
      orderBy: { createdAt: "desc" };
      take: number;
      select: {
        key: true;
        matchId: true;
        targetUser: true;
        waMessageId: true;
        waStanzaId: true;
        text: true;
        createdAt: true;
      };
    }): Promise<SentRow[]>;
  };
  botJob: {
    findUnique(args: {
      where: { id: string };
      select: { kind: true; phone: true; text: true; sentAt: true; createdAt: true };
    }): Promise<{ kind: string; phone: string | null; text: string; sentAt: Date | null; createdAt: Date } | null>;
  };
  user: {
    findUnique(args: { where: { id: string }; select: { phoneNumber: true } }): Promise<{ phoneNumber: string | null } | null>;
  };
}

/** The candidates a stanza id can name. More than one only if a stanza id
 *  were ever reused; the newest of this person's wins. */
const CANDIDATES = 5;

function digitSet(phones: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const p of phones) {
    const d = typeof p === "string" && p.trim() ? e164Digits(p.trim()) : null;
    if (d) out.add(d);
  }
  return out;
}

const isTheirs = (phone: string | null | undefined, theirs: Set<string>): boolean => {
  const d = typeof phone === "string" ? e164Digits(phone) : null;
  return d !== null && theirs.has(d);
};

/**
 * The MatchTime message a DM reply quotes, or null when it quotes none we
 * can name. `phones` are the sender's (the Pi's phone, the envelope's alt
 * phone), in any written form; a stored message counts only when it went
 * to one of them.
 */
export async function resolveQuotedBotMessage(
  db: ReplyContextDb,
  input: { quote: DmQuote; phones: Array<string | null | undefined>; now?: Date },
): Promise<QuotedBotMessage | null> {
  const { quote } = input;
  const now = input.now ?? new Date();
  const theirs = digitSet(input.phones);
  const bare = bareWhatsAppId(quote.id);

  if (bare && theirs.size > 0) {
    const rows = await db.sentNotification.findMany({
      where: {
        createdAt: { gte: new Date(now.getTime() - QUOTE_LOOKBACK_MS) },
        OR: [
          { waStanzaId: bare },
          // Rows acked before `waStanzaId` was filled (and not backfilled).
          { waStanzaId: null, waMessageId: bare },
          { waStanzaId: null, waMessageId: { contains: `_${bare}` } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: CANDIDATES,
      select: { key: true, matchId: true, targetUser: true, waMessageId: true, waStanzaId: true, text: true, createdAt: true },
    });
    for (const row of rows) {
      if (!sameWhatsAppMessage(bare, row.waStanzaId ?? row.waMessageId)) continue;
      const jobId = botJobIdOfKey(row.key);
      if (jobId) {
        const job = await db.botJob.findUnique({
          where: { id: jobId },
          select: { kind: true, phone: true, text: true, sentAt: true, createdAt: true },
        });
        if (!job || job.kind !== "dm" || !isTheirs(job.phone, theirs)) continue;
        return {
          key: row.key,
          sentAt: job.sentAt ?? row.createdAt,
          text: row.text ?? job.text ?? quote.text,
          topic: topicOfDueKey(row.key),
          matchId: row.matchId,
        };
      }
      if (!row.targetUser) continue;
      const user = await db.user.findUnique({ where: { id: row.targetUser }, select: { phoneNumber: true } });
      if (!isTheirs(user?.phoneNumber, theirs)) continue;
      return {
        key: row.key,
        sentAt: row.createdAt,
        text: row.text ?? quote.text,
        topic: topicOfDueKey(row.key),
        matchId: row.matchId,
      };
    }
  }

  if (!quote.fromMatchTime) return null;
  return { key: null, sentAt: null, text: quote.text, topic: null, matchId: null };
}

/** The S1 log line: ids, topic, match and resolved yes/no. Never the
 *  words of either message (logs keep ids, not text). */
export function quoteLogLine(input: { waMessageId: string; quote: DmQuote; resolved: QuotedBotMessage | null }): string {
  const { waMessageId, quote, resolved } = input;
  return (
    `[dm-reply] quote msg=${waMessageId} quoted=${quote.id ?? "-"} ` +
    `fromMatchTime=${quote.fromMatchTime ? "yes" : "no"} resolved=${resolved?.key ? "yes" : "no"}` +
    (resolved?.key ? ` key=${resolved.key}` : "") +
    ` topic=${resolved?.topic ?? "-"} match=${resolved?.matchId ?? "-"}`
  );
}

/**
 * The dm-reply route's one call (S1): read the quote off the body, resolve
 * it, log one line. Total: a failed read is logged and the DM carries on
 * exactly as it would have. Returns what it resolved, for the tests.
 */
export async function logDmQuote(
  db: ReplyContextDb,
  input: {
    body: unknown;
    waMessageId: string;
    phones: Array<string | null | undefined>;
    now?: Date;
    log?: (line: string) => void;
    error?: (line: string) => void;
  },
): Promise<QuotedBotMessage | null> {
  const quote = parseDmQuote(input.body);
  if (!quote) return null;
  const log = input.log ?? ((line: string) => console.log(line));
  const error = input.error ?? ((line: string) => console.error(line));
  try {
    const resolved = await resolveQuotedBotMessage(db, { quote, phones: input.phones, now: input.now });
    log(quoteLogLine({ waMessageId: input.waMessageId, quote, resolved }));
    return resolved;
  } catch (err) {
    error(
      `[dm-reply] quote msg=${input.waMessageId} quoted=${quote.id ?? "-"} could not be resolved: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}
