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
 * The dm-reply route resolves the quote ONCE (and logs ids, topic, match,
 * resolved yes/no; never text) and hands it to every DM classifier.
 *
 * WHAT A DM CLASSIFIER IS TOLD (slice S2, 2026-10-20; replaces
 * `last-bot-dm.ts`, which showed only "MatchTime's last message"):
 *
 *   - always the time now, in the club's time (London: every club plays
 *     there and `london-time.ts` is hardcoded to it; Organisation has no
 *     timezone setting). "can't tomorrow sorry" was read as unclear because
 *     the model did not know which day "tomorrow" was;
 *   - a swipe-reply to a MatchTime message: ONLY that message. The quote is
 *     a fact WhatsApp gives us; listing other asks beside it invites the
 *     model to override it;
 *   - otherwise MatchTime's last 3 DMs to them from the last 72 hours,
 *     oldest first, or, with none, the latest within 14 days, dated.
 *
 * Each message carries its time, what it was about (from its key, in code
 * made words, with its match) and its words, capped. `renderReplyContext`
 * is the one block every caller shows, in the same wording; the group and
 * HQ slices reuse it.
 *
 * DB-free: the client is an argument (a structural type Prisma satisfies),
 * so the classifier modules and their dry runs can import it without
 * importing Prisma.
 */
import { topicOfDueKey, type DueKeyTopic } from "./due-key-feature";
import { botJobIdOfKey } from "./dispatch-claim";
import { dayCommaTimeLabel } from "./i18n/dates";
import { formatLondon } from "./london-time";
import { e164Digits } from "./phone";
import { bareWhatsAppId, sameWhatsAppMessage } from "./quoted-message";

/** How far back a MatchTime DM still counts: quoted, or as the last one. */
export const DM_LOOKBACK_MS = 14 * 24 * 3600 * 1000;

/** How far back a quoted MatchTime message is still looked up. */
export const QUOTE_LOOKBACK_MS = DM_LOOKBACK_MS;

/** A non-reply is shown MatchTime's DMs from this window... */
export const RECENT_WINDOW_MS = 72 * 3600 * 1000;

/** ...at most this many of them. */
export const RECENT_MAX = 3;

/** The most of one message's words the model is shown. */
export const MESSAGE_WORDS_MAX = 300;

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
    // A stored message that is NOT a DM to this person (a group post they
    // replied to privately, somebody else's DM) is never their quote, and
    // the Pi's "it was MatchTime's" does not make it one: its match may be
    // another club's (review of #336).
    let foundNotTheirs = false;
    for (const row of rows) {
      if (!sameWhatsAppMessage(bare, row.waStanzaId ?? row.waMessageId)) continue;
      const jobId = botJobIdOfKey(row.key);
      if (jobId) {
        const job = await db.botJob.findUnique({
          where: { id: jobId },
          select: { kind: true, phone: true, text: true, sentAt: true, createdAt: true },
        });
        if (!job || job.kind !== "dm" || !isTheirs(job.phone, theirs)) {
          foundNotTheirs = true;
          continue;
        }
        return {
          key: row.key,
          sentAt: job.sentAt ?? row.createdAt,
          text: row.text ?? job.text ?? quote.text,
          topic: topicOfDueKey(row.key),
          matchId: row.matchId,
        };
      }
      const user = row.targetUser
        ? await db.user.findUnique({ where: { id: row.targetUser }, select: { phoneNumber: true } })
        : null;
      if (!isTheirs(user?.phoneNumber, theirs)) {
        foundNotTheirs = true;
        continue;
      }
      return {
        key: row.key,
        sentAt: row.createdAt,
        text: row.text ?? quote.text,
        topic: topicOfDueKey(row.key),
        matchId: row.matchId,
      };
    }
    if (foundNotTheirs) return null;
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

// ── Slice S2: the chat context every DM classifier reads ──────────────

/** One MatchTime message as the model is told about it. `match` is the
 *  match it was about, already written ("Tuesday 7-a-side, Tue 20 Oct,
 *  20:00"); `at` is null only for a quote the Pi alone knew. */
export interface ContextMessage {
  at: Date | null;
  text: string | null;
  topic: DueKeyTopic | null;
  match: string | null;
  /** Who wrote it, for a group reply (slice S4): absent or null when it
   *  was MatchTime; `{ name: null }` for a member whose name is not known. */
  author?: { name: string | null } | null;
}

/** What a reply is read against. `quoted` set: that message alone, and
 *  `recent`/`earlier` are not shown. Else `recent` (oldest first), or with
 *  none, `earlier`. */
export interface ReplyContext {
  now: Date;
  quoted: ContextMessage | null;
  recent: ContextMessage[];
  earlier: ContextMessage | null;
  /** The Pi says they quoted a MatchTime message, but it is not one we can
   *  name (an inline reply, or a send with no stored id). Shown flagged,
   *  BESIDE the recent messages, never as "they are replying to". */
  unidentifiedQuote?: { text: string | null } | null;
}

/**
 * The quote a path may read when it acts on `matchId`: kept when it names
 * that match or none, dropped when it names another. A reply is never read
 * against one match's message while acting on a different match (review of
 * #336: "paid" to match A's chase landed on match B).
 */
export function quoteForMatch<Q extends { matchId: string | null }>(quoted: Q | null | undefined, matchId: string): Q | null {
  if (!quoted) return null;
  if (quoted.matchId && quoted.matchId !== matchId) return null;
  return quoted;
}

/** Nothing known but the time. */
export function noReplyContext(now: Date = new Date()): ReplyContext {
  return { now, quoted: null, recent: [], earlier: null };
}

/** The match a message was about, as the model reads it. */
export function contextMatchLabel(name: string, date: Date): string {
  return `${name}, ${dayCommaTimeLabel("en", date)}`;
}

/** Which of MatchTime's DMs a non-reply is shown: the last `RECENT_MAX`
 *  from the last 72 hours, oldest first; with none, the latest within
 *  14 days as `earlier`. */
export function pickRecentBotMessages(
  all: ContextMessage[],
  now: Date,
): { recent: ContextMessage[]; earlier: ContextMessage | null } {
  const t = now.getTime();
  const dated = all
    .filter((m): m is ContextMessage & { at: Date } => m.at !== null && t - m.at.getTime() <= DM_LOOKBACK_MS)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const recent = dated.filter((m) => t - m.at.getTime() <= RECENT_WINDOW_MS).slice(-RECENT_MAX);
  if (recent.length > 0) return { recent, earlier: null };
  return { recent: [], earlier: dated.at(-1) ?? null };
}

/** What a message was about, in plain words, from its key's topic. */
function aboutOf(topic: DueKeyTopic | null, match: string | null): string | null {
  switch (topic) {
    case "tentativeFollowup":
      return `asking whether they can play in ${match ?? "a match"}`;
    case "paymentCollection":
    case "paymentTracking":
      return match ? `paying the match fee for ${match}` : "paying the match fee they owe";
    case "playerRating":
      return `rating their teammates after ${match ?? "the last match"}`;
    case "momVoting":
      return `the Man of the Match vote for ${match ?? "the last match"}`;
    case "attendance":
    case "bench":
      return `who is playing in ${match ?? "a match"}`;
    case "teamBalancing":
      return `the final score of ${match ?? "the last match"}`;
    case "badgeAnnouncements":
      return "badges players have earned";
    default:
      return null;
  }
}

const words = (text: string | null, max: number = MESSAGE_WORDS_MAX): string =>
  text && text.trim() ? JSON.stringify(text.trim().slice(0, max)) : "(its words are not known)";

/** "Mon 19 Oct, 17:30 (about: ...)", the head of a message line. */
function headOf(m: ContextMessage & { at: Date }): string {
  const about = aboutOf(m.topic, m.match);
  return `${dayCommaTimeLabel("en", m.at)}${about ? ` (about: ${about})` : ""}`;
}

/** The block's first line: the time now, in the club's time. */
export function nowLine(now: Date): string {
  return `NOW: ${formatLondon(now, "EEEE d MMMM yyyy, HH:mm")} (club time, London)`;
}

/**
 * The two lines naming the message a reply quotes: whose it is, when, what
 * it was about, then its words (capped at `max`). MatchTime's or, in a
 * group (slice S4), a member's. The one wording every caller shows.
 */
export function quotedLines(quoted: ContextMessage, max: number = MESSAGE_WORDS_MAX): string[] {
  const member = quoted.author ?? null;
  const whose = member ? (member.name ? `${member.name}'s message` : "another member's message") : "MatchTime's message";
  const head = quoted.at
    ? `THEY ARE REPLYING TO ${whose} of ${headOf({ ...quoted, at: quoted.at })}:`
    : member
      ? `THEY ARE REPLYING TO ${whose} (when it was sent is not known):`
      : "THEY ARE REPLYING TO a MatchTime message (when it was sent is not known):";
  return [head, words(quoted.text, max)];
}

const RECENT_HEADER = "MATCHTIME'S RECENT MESSAGES TO THEM";
const days = (ms: number) => Math.round(ms / (24 * 3600 * 1000));

/**
 * THE block: one plain piece of the user turn, the same wording for every
 * caller. Model-facing, so English whatever the club's language (the
 * prompts are English); the words of each message are as sent.
 */
export function renderReplyContext(ctx: ReplyContext): string {
  const lines = [nowLine(ctx.now)];
  const { quoted } = ctx;
  const unidentified = !quoted ? ctx.unidentifiedQuote : null;
  if (unidentified) {
    lines.push(
      unidentified.text && unidentified.text.trim()
        ? `THEY QUOTED a MatchTime message that could not be identified as one of its DMs to them (it may be a group post): ${words(unidentified.text)}`
        : "THEY QUOTED a MatchTime message that could not be identified, and its words are not known.",
    );
  }
  if (quoted) {
    lines.push(...quotedLines(quoted));
  } else if (ctx.recent.length > 0) {
    lines.push(`${RECENT_HEADER} (oldest first${unidentified ? "" : "; their DM is not a reply to one"}):`);
    for (const m of ctx.recent) lines.push(`- ${m.at ? headOf({ ...m, at: m.at }) : "(time not known)"}: ${words(m.text)}`);
  } else if (ctx.earlier?.at) {
    lines.push(
      `${RECENT_HEADER}: none in the last ${days(RECENT_WINDOW_MS)} days. ` +
        `The last was on ${headOf({ ...ctx.earlier, at: ctx.earlier.at })}: ${words(ctx.earlier.text)}`,
    );
  } else {
    lines.push(`${RECENT_HEADER}: none in the last ${days(DM_LOOKBACK_MS)} days.`);
  }
  return lines.join("\n");
}

/** The reads `loadDmReplyContext` makes, as a structural type so a test
 *  can hand in a fake. Prisma's client satisfies it. */
export interface DmReplyContextDb {
  sentNotification: {
    findMany(args: {
      where: { kind: "dm"; targetUser: string; createdAt: { gte: Date }; waMessageId: { not: null } };
      orderBy: { createdAt: "desc" };
      take: number;
      select: { key: true; matchId: true; text: true; createdAt: true };
    }): Promise<Array<{ key: string; matchId: string | null; text: string | null; createdAt: Date }>>;
  };
  botJob: {
    findMany(args: {
      where: { kind: "dm"; phone: string; createdAt: { gte: Date }; sentAt: { not: null } };
      orderBy: { createdAt: "desc" };
      take: number;
      select: { text: true; sentAt: true; createdAt: true };
    }): Promise<Array<{ text: string; sentAt: Date | null; createdAt: Date }>>;
  };
  match: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; date: true; activity: { select: { name: true } } };
    }): Promise<Array<{ id: string; date: Date; activity: { name: string } }>>;
  };
}

/** Enough rows from each side to fill the recent list after merging. */
const RECENT_READ = 10;

/**
 * The chat context for a DM, loaded once. `quoted` is what the route
 * resolved (`resolveQuotedBotMessage`): when set it is the whole context.
 * Otherwise MatchTime's DMs to this person from both places they are
 * recorded: a queued `BotJob` (its words, by `phone`, the BotJob's form
 * with no "+"; null skips that side) and a scheduler DM handed out by
 * /due-posts (a `SentNotification` by `targetUser`: its key's topic, its
 * match, and since S0 its words).
 */
export async function loadDmReplyContext(
  db: DmReplyContextDb,
  input: { userId: string; phone: string | null; quoted: QuotedBotMessage | null; now?: Date },
): Promise<ReplyContext> {
  const now = input.now ?? new Date();
  try {
    return await readDmReplyContext(db, { ...input, now });
  } catch (err) {
    // TOTAL: a failed read never drops the reply. The classifier still
    // runs, told the time now and that nothing is known.
    console.error(
      `[reply-context] chat context for user=${input.userId} could not be read: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return noReplyContext(now);
  }
}

async function readDmReplyContext(
  db: DmReplyContextDb,
  input: { userId: string; phone: string | null; quoted: QuotedBotMessage | null; now: Date },
): Promise<ReplyContext> {
  const { now } = input;
  const labels = async (ids: Array<string | null>): Promise<Map<string, string>> => {
    const want = [...new Set(ids.filter((id): id is string => !!id))];
    if (want.length === 0) return new Map();
    const rows = await db.match.findMany({
      where: { id: { in: want } },
      select: { id: true, date: true, activity: { select: { name: true } } },
    });
    return new Map(rows.map((r) => [r.id, contextMatchLabel(r.activity.name, r.date)]));
  };

  // A quote we found among our DMs to them is the whole context.
  if (input.quoted?.key) {
    const q = input.quoted;
    const match = q.matchId ? ((await labels([q.matchId])).get(q.matchId) ?? null) : null;
    return { now, quoted: { at: q.sentAt, text: q.text, topic: q.topic, match }, recent: [], earlier: null };
  }

  // Only messages actually SENT: a scheduler claim the Pi acked with an id,
  // a BotJob the Pi marked sent. A queued or failed one never reached them.
  const since = new Date(now.getTime() - DM_LOOKBACK_MS);
  const [scheduled, queued] = await Promise.all([
    db.sentNotification.findMany({
      where: { kind: "dm", targetUser: input.userId, createdAt: { gte: since }, waMessageId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: RECENT_READ,
      select: { key: true, matchId: true, text: true, createdAt: true },
    }),
    input.phone
      ? db.botJob.findMany({
          where: { kind: "dm", phone: input.phone, createdAt: { gte: since }, sentAt: { not: null } },
          orderBy: { createdAt: "desc" },
          take: RECENT_READ,
          select: { text: true, sentAt: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);
  // A BotJob's own ack row is that job, already read from the job.
  const sched = scheduled.filter((r) => !botJobIdOfKey(r.key));
  const names = await labels(sched.map((r) => r.matchId));
  const all: ContextMessage[] = [
    ...sched.map((r) => ({
      at: r.createdAt,
      text: r.text,
      topic: topicOfDueKey(r.key),
      match: r.matchId ? (names.get(r.matchId) ?? null) : null,
    })),
    ...queued.map((j) => ({ at: j.sentAt ?? j.createdAt, text: j.text, topic: null, match: null })),
  ];
  const picked = pickRecentBotMessages(all, now);
  // The Pi's word that they quoted MatchTime, with nothing we can name:
  // flagged beside the recent messages, never instead of them.
  return input.quoted ? { now, quoted: null, ...picked, unidentifiedQuote: { text: input.quoted.text } } : { now, quoted: null, ...picked };
}

// ── Slice S4: a reply in a group (the players' group or HQ) ───────────
//
// A WhatsApp reply in a group carries the message it quotes, WHOEVER
// wrote it: MatchTime's own post, or a member's message ("same" to Ali's
// "IN"). The router and every group extractor are shown it in the DM
// block's wording (`renderGroupReplyContext`), with no recent-DM list: a
// group extractor already has RECENT CHAT and MATCHTIME'S LAST POST.
//
// Resolution, by the quoted stanza id first (a structured fact, never
// a reading of words), then what the Pi saw:
//   1. a message in THIS batch (the commonest case: "IN", then "same"
//      seconds later): its sender and words;
//   2. MatchTime's own send: a SentNotification of a group post with that
//      stanza id, from the last 14 days, on THIS club (a BotJob's own
//      `orgId`; a scheduler post's match): its stored words (else the
//      BotJob's, else the Pi's), time, topic and match;
//   3. a member's earlier message: `AnalyzedMessage` (players' group) or
//      `AdminGroupMessage` (HQ) of this club, with their roster name;
//   4. nothing found: the Pi's text, MatchTime's when the Pi says so,
//      else the member the Pi's contact lookup names (their phone on the
//      roster first, then their WhatsApp name), time not known.

/** How much of a quoted group message an extractor is shown. More than a
 *  DM's: a squad post with its names is the thing a reply is about. */
export const GROUP_QUOTE_WORDS_MAX = 1000;

/** A group reply's quote as the Pi forwards it. The author fields are
 *  UNVERIFIED (the quoted author's own WhatsApp name and phone, from the
 *  Pi's contact lookup) and absent from Pi builds before slice S4. */
export interface GroupQuote {
  id: string | null;
  text: string | null;
  fromMatchTime: boolean;
  authorName?: string | null;
  authorPhone?: string | null;
}

/** The message a group reply quotes, resolved. `author` null: MatchTime. */
export interface QuotedGroupMessage extends ContextMessage {
  author: { name: string | null } | null;
  matchId: string | null;
}

const strOrNull = (v: unknown, max = QUOTED_TEXT_MAX): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** The quote fields of a group message, in either door's names (the
 *  analyze route's `quotedBody`, HQ's `quotedText`), or null when it is
 *  not a reply. */
export function parseGroupQuote(m: {
  quotedMessageId?: unknown;
  quotedBody?: unknown;
  quotedText?: unknown;
  quotedFromMatchTime?: unknown;
  quotedAuthorName?: unknown;
  quotedAuthorPhone?: unknown;
}): GroupQuote | null {
  const id = strOrNull(m.quotedMessageId, 200);
  const text = strOrNull(m.quotedBody) ?? strOrNull(m.quotedText);
  if (!id && !text) return null;
  return {
    id,
    text,
    fromMatchTime: m.quotedFromMatchTime === true,
    authorName: strOrNull(m.quotedAuthorName, 100),
    authorPhone: strOrNull(m.quotedAuthorPhone, 40),
  };
}

/** The reads `loadGroupReplyContexts` makes, as a structural type so a
 *  test can hand in a fake. Prisma's client satisfies it. */
export interface GroupReplyContextDb {
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
      select: { key: true; kind: true; matchId: true; waMessageId: true; waStanzaId: true; text: true; createdAt: true };
    }): Promise<
      Array<{ key: string; kind: string; matchId: string | null; waMessageId: string | null; waStanzaId: string | null; text: string | null; createdAt: Date }>
    >;
  };
  botJob: {
    findUnique(args: {
      where: { id: string };
      select: { orgId: true; kind: true; text: true; sentAt: true; createdAt: true };
    }): Promise<{ orgId: string; kind: string; text: string; sentAt: Date | null; createdAt: Date } | null>;
  };
  match: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; date: true; activity: { select: { name: true; orgId: true } } };
    }): Promise<Array<{ id: string; date: Date; activity: { name: string; orgId: string } }>>;
  };
  analyzedMessage: {
    findMany(args: {
      where: { orgId: string; createdAt: { gte: Date }; waMessageId: { contains: string } };
      orderBy: { createdAt: "desc" };
      take: number;
      select: { waMessageId: true; authorUserId: true; authorName: true; body: true; createdAt: true };
    }): Promise<Array<{ waMessageId: string; authorUserId: string | null; authorName: string | null; body: string | null; createdAt: Date }>>;
  };
  adminGroupMessage: {
    findMany(args: {
      where: { orgId: string; createdAt: { gte: Date }; waMessageId: { contains: string } };
      orderBy: { createdAt: "desc" };
      take: number;
      select: { waMessageId: true; senderUserId: true; text: true; createdAt: true };
    }): Promise<Array<{ waMessageId: string; senderUserId: string | null; text: string; createdAt: Date }>>;
  };
  user: {
    findMany(args: { where: { id: { in: string[] } }; select: { id: true; name: true } }): Promise<Array<{ id: string; name: string | null }>>;
  };
}

/** One message of the batch being read, for a reply to it in the same batch. */
export interface GroupBatchMessage {
  waMessageId: string;
  /** Its sender's name as the route resolved it (the roster's, else WhatsApp's). */
  authorName: string | null;
  body: string;
  sentAt: Date | null;
}

/** A quote known only from what the Pi saw (nothing found by its id).
 *  Exported for the live checks, which build production's turns. */
export const quoteFromPi = (quote: GroupQuote, name: string | null = null): QuotedGroupMessage => piOnly(quote, name);

const piOnly = (quote: GroupQuote, name: string | null): QuotedGroupMessage => ({
  author: quote.fromMatchTime ? null : { name: name ?? quote.authorName ?? null },
  at: null,
  text: quote.text,
  topic: null,
  matchId: null,
  match: null,
});

/**
 * The message each group reply quotes, keyed by the reply's id. A message
 * that is not a reply has no entry. TOTAL: a failed read keeps what the
 * Pi said, so a reply is never dropped for want of a lookup.
 *
 * `authorByPhone`: the roster name behind the Pi's quoted-author phone,
 * when the caller can resolve one (the analyze route's sender resolution).
 */
export async function loadGroupReplyContexts(
  db: GroupReplyContextDb,
  input: {
    orgId: string;
    channel: "group" | "hq";
    now: Date;
    messages: Array<{ id: string; quote: GroupQuote | null }>;
    batch: GroupBatchMessage[];
    authorByPhone?: (phone: string) => Promise<string | null>;
  },
): Promise<Map<string, QuotedGroupMessage>> {
  const out = new Map<string, QuotedGroupMessage>();
  for (const m of input.messages) {
    if (!m.quote) continue;
    try {
      out.set(m.id, await resolveGroupQuote(db, { ...input, quote: m.quote }));
    } catch (err) {
      console.error(
        `[reply-context] group quote msg=${m.id} quoted=${m.quote.id ?? "-"} could not be resolved: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      out.set(m.id, piOnly(m.quote, null));
    }
  }
  return out;
}

async function resolveGroupQuote(
  db: GroupReplyContextDb,
  input: {
    orgId: string;
    channel: "group" | "hq";
    now: Date;
    quote: GroupQuote;
    batch: GroupBatchMessage[];
    authorByPhone?: (phone: string) => Promise<string | null>;
  },
): Promise<QuotedGroupMessage> {
  const { quote, orgId } = input;
  const bare = bareWhatsAppId(quote.id);
  const since = new Date(input.now.getTime() - QUOTE_LOOKBACK_MS);
  const member = (name: string | null, at: Date | null, text: string | null): QuotedGroupMessage => ({
    author: { name },
    at,
    text: text ?? quote.text,
    topic: null,
    matchId: null,
    match: null,
  });

  if (bare) {
    // 1. A message in this same batch.
    const inBatch = input.batch.find((b) => sameWhatsAppMessage(bare, b.waMessageId));
    if (inBatch) return member(inBatch.authorName, inBatch.sentAt, inBatch.body);

    // 2. MatchTime's own post in this club's group.
    const rows = await db.sentNotification.findMany({
      where: {
        createdAt: { gte: since },
        OR: [{ waStanzaId: bare }, { waStanzaId: null, waMessageId: bare }, { waStanzaId: null, waMessageId: { contains: `_${bare}` } }],
      },
      orderBy: { createdAt: "desc" },
      take: CANDIDATES,
      select: { key: true, kind: true, matchId: true, waMessageId: true, waStanzaId: true, text: true, createdAt: true },
    });
    for (const row of rows) {
      if (!sameWhatsAppMessage(bare, row.waStanzaId ?? row.waMessageId)) continue;
      const jobId = botJobIdOfKey(row.key);
      if (jobId) {
        const job = await db.botJob.findUnique({
          where: { id: jobId },
          select: { orgId: true, kind: true, text: true, sentAt: true, createdAt: true },
        });
        if (!job || job.orgId !== orgId || job.kind === "dm") continue;
        return { author: null, at: job.sentAt ?? row.createdAt, text: row.text ?? job.text ?? quote.text, topic: null, matchId: null, match: null };
      }
      if (row.kind === "dm") continue;
      let match: string | null = null;
      if (row.matchId) {
        const [m] = await db.match.findMany({
          where: { id: { in: [row.matchId] } },
          select: { id: true, date: true, activity: { select: { name: true, orgId: true } } },
        });
        if (!m || m.activity.orgId !== orgId) continue;
        match = contextMatchLabel(m.activity.name, m.date);
      }
      return { author: null, at: row.createdAt, text: row.text ?? quote.text, topic: topicOfDueKey(row.key), matchId: row.matchId, match };
    }

    // 3. A member's earlier message, from this club's own record of them.
    const said =
      input.channel === "group"
        ? (
            await db.analyzedMessage.findMany({
              where: { orgId, createdAt: { gte: since }, waMessageId: { contains: `_${bare}` } },
              orderBy: { createdAt: "desc" },
              take: CANDIDATES,
              select: { waMessageId: true, authorUserId: true, authorName: true, body: true, createdAt: true },
            })
          ).map((r) => ({ id: r.waMessageId, userId: r.authorUserId, name: r.authorName, text: r.body, at: r.createdAt }))
        : (
            await db.adminGroupMessage.findMany({
              where: { orgId, createdAt: { gte: since }, waMessageId: { contains: `_${bare}` } },
              orderBy: { createdAt: "desc" },
              take: CANDIDATES,
              select: { waMessageId: true, senderUserId: true, text: true, createdAt: true },
            })
          ).map((r) => ({ id: r.waMessageId, userId: r.senderUserId, name: null as string | null, text: r.text as string | null, at: r.createdAt }));
    const hit = said.find((r) => sameWhatsAppMessage(bare, r.id));
    if (hit) {
      const [user] = hit.userId
        ? await db.user.findMany({ where: { id: { in: [hit.userId] } }, select: { id: true, name: true } })
        : [];
      return member(user?.name ?? hit.name ?? quote.authorName ?? null, hit.at, hit.text);
    }
  }

  // 4. Only what the Pi saw.
  const rosterName =
    !quote.fromMatchTime && quote.authorPhone && input.authorByPhone ? await input.authorByPhone(quote.authorPhone) : null;
  return piOnly(quote, rosterName);
}

/** The group block: the time now, then the message the reply quotes. */
export function renderGroupReplyContext(
  ctx: { now: Date; quoted: ContextMessage | null },
  opts: { wordsMax?: number } = {},
): string {
  const lines = [nowLine(ctx.now)];
  if (ctx.quoted) lines.push(...quotedLines(ctx.quoted, opts.wordsMax ?? GROUP_QUOTE_WORDS_MAX));
  return lines.join("\n");
}
