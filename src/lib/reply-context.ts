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
 * HQ slices reuse it. Slice S3 (2026-10-20) gave it to the other four DM
 * classifiers: fee-confirm, roster-survey, dm-intent and dm-qa.
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
      select: { kind: true; phone: true; text: true; sentAt: true; createdAt: true; matchId: true; aboutKey: true };
    }): Promise<{
      kind: string;
      phone: string | null;
      text: string;
      sentAt: Date | null;
      createdAt: Date;
      matchId: string | null;
      aboutKey: string | null;
    } | null>;
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
          select: { kind: true, phone: true, text: true, sentAt: true, createdAt: true, matchId: true, aboutKey: true },
        });
        if (!job || job.kind !== "dm" || !isTheirs(job.phone, theirs)) {
          foundNotTheirs = true;
          continue;
        }
        // What the job is about, when the code that queued it said so
        // (`BotJob.aboutKey`, `matchId`; review of #339): the collector's
        // fee question resolves to its match and topic like a scheduler DM.
        return {
          key: row.key,
          sentAt: job.sentAt ?? row.createdAt,
          text: row.text ?? job.text ?? quote.text,
          topic: job.aboutKey ? topicOfDueKey(job.aboutKey) : topicOfDueKey(row.key),
          matchId: row.matchId ?? job.matchId,
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
   *  was MatchTime. A member is NAMED only when they were resolved to a
   *  club member, by their ROSTER name; `{ name: null }` is a member who
   *  was not identified (a WhatsApp profile name is never shown). */
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

/**
 * The same rule for a path that acts on a CLUB rather than on one match
 * (the admin's DM commands, the scoped Q&A; slice S3). `quotedOrgId` is the
 * club of the quote's match. The quote is kept when it names no match, or
 * a match of one of `orgIds` (the clubs this path may act on), and then
 * that club is the one to act on (`orgId`). A quote whose match is another
 * club's is dropped, and `orgId` is null: the path picks its club as it
 * always did.
 */
export function quoteForClubs(
  quoted: QuotedBotMessage | null | undefined,
  quotedOrgId: string | null | undefined,
  orgIds: readonly string[],
): { quoted: QuotedBotMessage | null; orgId: string | null } {
  if (!quoted) return { quoted: null, orgId: null };
  if (!quoted.matchId) return { quoted, orgId: null };
  if (quotedOrgId && orgIds.includes(quotedOrgId)) return { quoted, orgId: quotedOrgId };
  return { quoted: null, orgId: null };
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
    case "feeQuestion":
      return `the match fee to charge for ${match ?? "a match"}`;
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
  const name = member ? memberLabel(member.name) : null;
  const whose = member ? (name ? `${name}'s message` : "a message from a member (not identified)") : "MatchTime's message";
  const head = quoted.at
    ? `THEY ARE REPLYING TO ${whose} of ${headOf({ ...quoted, at: quoted.at })}:`
    : member
      ? `THEY ARE REPLYING TO ${whose} (when it was sent is not known):`
      : "THEY ARE REPLYING TO a MatchTime message (when it was sent is not known):";
  return [head, words(quoted.text, max)];
}

/**
 * A member's roster name as the reply line may show it: one line, no
 * quotes, colons or brackets, at most 60 characters. Null when nothing is
 * left, or when it reads as MatchTime itself (only the Pi's flag or one of
 * MatchTime's own sends may label a message MatchTime's).
 */
export function memberLabel(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const clean = name
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/["'`:\[\]{}<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  if (!clean) return null;
  if (/^(?:@?\s*match\s*time|@?mt|whatsapp|system)$/i.test(clean)) return null;
  return clean;
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
      where: {
        kind: "dm";
        targetUser: string;
        createdAt: { gte: Date };
        waMessageId: { not: null };
        match?: { activity: { orgId: { in: string[] } } };
      };
      orderBy: { createdAt: "desc" };
      take: number;
      select: { key: true; matchId: true; text: true; createdAt: true };
    }): Promise<Array<{ key: string; matchId: string | null; text: string | null; createdAt: Date }>>;
  };
  botJob: {
    findMany(args: {
      where: { kind: "dm"; phone: string; createdAt: { gte: Date }; sentAt: { not: null }; orgId?: { in: string[] } };
      orderBy: { createdAt: "desc" };
      take: number;
      select: { text: true; sentAt: true; createdAt: true; matchId: true; aboutKey: true };
    }): Promise<Array<{ text: string; sentAt: Date | null; createdAt: Date; matchId: string | null; aboutKey: string | null }>>;
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
  input: {
    userId: string;
    phone: string | null;
    quoted: QuotedBotMessage | null;
    now?: Date;
    /** Only MatchTime's DMs about these clubs (review of #339, M1): a path
     *  that acts on a club (dm-intent, dm-qa) never shows the model another
     *  club's messages. A scheduler DM counts by its match's club, a queued
     *  one by its own. Absent: every club, as before. */
    orgIds?: readonly string[];
  },
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
  input: { userId: string; phone: string | null; quoted: QuotedBotMessage | null; now: Date; orgIds?: readonly string[] },
): Promise<ReplyContext> {
  const { now } = input;
  const inClubs = input.orgIds ? { in: [...input.orgIds] } : null;
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
      where: {
        kind: "dm",
        targetUser: input.userId,
        createdAt: { gte: since },
        waMessageId: { not: null },
        ...(inClubs ? { match: { activity: { orgId: inClubs } } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: RECENT_READ,
      select: { key: true, matchId: true, text: true, createdAt: true },
    }),
    input.phone
      ? db.botJob.findMany({
          where: {
            kind: "dm",
            phone: input.phone,
            createdAt: { gte: since },
            sentAt: { not: null },
            ...(inClubs ? { orgId: inClubs } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: RECENT_READ,
          select: { text: true, sentAt: true, createdAt: true, matchId: true, aboutKey: true },
        })
      : Promise.resolve([]),
  ]);
  // A BotJob's own ack row is that job, already read from the job.
  const sched = scheduled.filter((r) => !botJobIdOfKey(r.key));
  const names = await labels([...sched.map((r) => r.matchId), ...queued.map((j) => j.matchId)]);
  const all: ContextMessage[] = [
    ...sched.map((r) => ({
      at: r.createdAt,
      text: r.text,
      topic: topicOfDueKey(r.key),
      match: r.matchId ? (names.get(r.matchId) ?? null) : null,
    })),
    ...queued.map((j) => ({
      at: j.sentAt ?? j.createdAt,
      text: j.text,
      topic: j.aboutKey ? topicOfDueKey(j.aboutKey) : null,
      match: j.matchId ? (names.get(j.matchId) ?? null) : null,
    })),
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
// Resolution, by the quoted stanza id first (a structured fact, never a
// reading of words), ONE query per table for the whole batch:
//   1. a message in THIS batch ("IN", then "same" seconds later);
//   2. MatchTime's own send on THIS club: a SentNotification with that
//      stanza id (a scheduler post on one of this club's matches, MatchTime's
//      in-group reply claimed under this club's key, or this club's group
//      BotJob), from the last 14 days, with its words, time, topic, match;
//   3. a member's earlier message: `AnalyzedMessage` (players' group) or
//      `AdminGroupMessage` (HQ, where MatchTime's own lines carry their
//      stanza id once acked);
//   4. nothing found: what the Pi saw, time not known.
//
// WHO WROTE IT (review of #341, finding 1). A member is NAMED only when
// they resolve to a club member: the batch's resolved sender, the stored
// row's user id, or the Pi's phone on the roster. Then they are named by
// their ROSTER name, with their user id beside it for code. A WhatsApp
// profile name is never shown: anyone can call themselves "Ali Khan". An
// unresolved author is "a member (not identified)". MatchTime is named
// only from the Pi's flag or one of its own sends.

/** How much of a quoted group message an extractor is shown. More than a
 *  DM's: a squad post with its names is the thing a reply is about. */
export const GROUP_QUOTE_WORDS_MAX = 1000;

/** The key MatchTime's in-group reply to `inboundId` is claimed under, so
 *  the Pi's ack gives it a stanza id and a reply to it resolves. */
export const groupReplyKey = (orgId: string, inboundId: string): string => `greply:${orgId}:${inboundId}`;
/** The same for a reply in the club's admin group (HQ). */
export const hqReplyKey = (orgId: string, inboundId: string): string => `hqreply:${orgId}:${inboundId}`;
export const GROUP_REPLY_KIND = "group-reply";
export const HQ_REPLY_KIND = "admin-group-reply";

/** The SentNotification kinds that are MatchTime's own posts in a group. */
const GROUP_SEND_KINDS: ReadonlySet<string> = new Set([
  "group-message",
  "group-poll",
  "bench-prompt",
  "admin-group-message",
  GROUP_REPLY_KIND,
  HQ_REPLY_KIND,
]);
/** The BotJob kinds that post in a group. */
const GROUP_JOB_KINDS: ReadonlySet<string> = new Set(["group", "group-poll", "admin-group"]);

/** A group reply's quote as the Pi forwards it. The author fields are the
 *  quoted author's phone (from their JID, or the contact the Pi was told)
 *  and their own WhatsApp name: the name is NEVER shown (finding 1). */
export interface GroupQuote {
  id: string | null;
  text: string | null;
  fromMatchTime: boolean;
  authorName?: string | null;
  authorPhone?: string | null;
}

/** The message a group reply quotes, resolved. `author` null: MatchTime. */
export interface QuotedGroupMessage extends ContextMessage {
  /** `userId` set and `name` the roster name: a resolved member. Both null:
   *  a member not identified. */
  author: { name: string | null; userId: string | null } | null;
  matchId: string | null;
  /** Found by its WhatsApp id in this club's own records. */
  found: boolean;
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

type GSentRow = { key: string; kind: string; matchId: string | null; waStanzaId: string | null; waMessageId: string | null; text: string | null; createdAt: Date };
type GJobRow = { id: string; orgId: string; kind: string; text: string; sentAt: Date | null; createdAt: Date; matchId: string | null; aboutKey: string | null };
type GMatchRow = { id: string; date: Date; activity: { name: string; orgId: string } };
type GAnalyzedRow = { waMessageId: string; authorUserId: string | null; body: string | null; createdAt: Date };
type GHqRow = { waMessageId: string; waStanzaId: string | null; fromMatchTime: boolean; senderUserId: string | null; text: string; createdAt: Date };

/** The reads `loadGroupReplyContexts` makes, as a structural type so a
 *  test can hand in a fake. Prisma's client satisfies it. Each is ONE
 *  query for the whole batch. */
export interface GroupReplyContextDb {
  sentNotification: {
    findMany(args: {
      where: { createdAt: { gte: Date }; waStanzaId: { in: string[] } };
      take: number;
      select: { key: true; kind: true; matchId: true; waStanzaId: true; waMessageId: true; text: true; createdAt: true };
    }): Promise<GSentRow[]>;
  };
  botJob: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; orgId: true; kind: true; text: true; sentAt: true; createdAt: true; matchId: true; aboutKey: true };
    }): Promise<GJobRow[]>;
  };
  match: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; date: true; activity: { select: { name: true; orgId: true } } };
    }): Promise<GMatchRow[]>;
  };
  analyzedMessage: {
    findMany(args: {
      where: { orgId: string; createdAt: { gte: Date }; OR: Array<{ waMessageId: { in: string[] } } | { waMessageId: { contains: string } }> };
      take: number;
      select: { waMessageId: true; authorUserId: true; body: true; createdAt: true };
    }): Promise<GAnalyzedRow[]>;
  };
  adminGroupMessage: {
    findMany(args: {
      where: {
        orgId: string;
        createdAt: { gte: Date };
        OR: Array<{ waStanzaId: { in: string[] } } | { waMessageId: { contains: string } }>;
      };
      take: number;
      select: { waMessageId: true; waStanzaId: true; fromMatchTime: true; senderUserId: true; text: true; createdAt: true };
    }): Promise<GHqRow[]>;
  };
  user: {
    findMany(args: { where: { id: { in: string[] } }; select: { id: true; name: true } }): Promise<Array<{ id: string; name: string | null }>>;
  };
}

/** One message of the batch being read, for a reply to it in the same batch. */
export interface GroupBatchMessage {
  waMessageId: string;
  /** Its sender, when the route resolved them to a member; null otherwise. */
  userId: string | null;
  /** That member's ROSTER name. Read only when `userId` is set. */
  rosterName: string | null;
  body: string;
  sentAt: Date | null;
}

const unidentified = { name: null, userId: null } as const;
const memberOf = (userId: string | null, rosterName: string | null): QuotedGroupMessage["author"] =>
  userId ? { userId, name: memberLabel(rosterName) } : { ...unidentified };

/** A quote known only from what the Pi saw (nothing found by its id).
 *  Exported for the live checks, which build production's turns. The Pi's
 *  author NAME is never used; `member` is the roster member its phone
 *  resolved to, if any. */
export function quoteFromPi(quote: GroupQuote, member: { userId: string; name: string | null } | null = null): QuotedGroupMessage {
  return {
    author: quote.fromMatchTime ? null : member ? memberOf(member.userId, member.name) : { ...unidentified },
    at: null,
    text: quote.text,
    topic: null,
    matchId: null,
    match: null,
    found: false,
  };
}

/** The candidates a stanza id can name per table, across the batch. */
const PER_ID = 5;

/**
 * The message each group reply quotes, keyed by the reply's id. A message
 * that is not a reply has no entry. TOTAL: a failed read keeps what the
 * Pi said, so a reply is never dropped for want of a lookup.
 *
 * `memberByPhone`: the club member behind the Pi's quoted-author phone
 * (read-only roster lookup), when the caller can resolve one.
 */
export async function loadGroupReplyContexts(
  db: GroupReplyContextDb,
  input: {
    orgId: string;
    channel: "group" | "hq";
    now: Date;
    messages: Array<{ id: string; quote: GroupQuote | null }>;
    batch: GroupBatchMessage[];
    memberByPhone?: (phone: string) => Promise<{ userId: string; name: string | null } | null>;
  },
): Promise<Map<string, QuotedGroupMessage>> {
  const wanted = input.messages.filter((m): m is { id: string; quote: GroupQuote } => !!m.quote);
  const out = new Map<string, QuotedGroupMessage>();
  if (wanted.length === 0) return out;
  let found = new Map<string, QuotedGroupMessage>();
  try {
    found = await findByIds(db, input, [...new Set(wanted.map((m) => bareWhatsAppId(m.quote.id)).filter((b): b is string => !!b))]);
  } catch (err) {
    console.error(
      `[reply-context] group quotes of ${wanted.length} message(s) could not be resolved: ` + (err instanceof Error ? err.message : String(err)),
    );
  }
  for (const m of wanted) {
    const bare = bareWhatsAppId(m.quote.id);
    const hit = bare ? found.get(bare) : undefined;
    if (hit) {
      out.set(m.id, hit);
      continue;
    }
    let member: { userId: string; name: string | null } | null = null;
    if (!m.quote.fromMatchTime && m.quote.authorPhone && input.memberByPhone) {
      member = await input.memberByPhone(m.quote.authorPhone).catch(() => null);
    }
    out.set(m.id, quoteFromPi(m.quote, member));
  }
  return out;
}

async function findByIds(
  db: GroupReplyContextDb,
  input: { orgId: string; channel: "group" | "hq"; now: Date; batch: GroupBatchMessage[] },
  bares: string[],
): Promise<Map<string, QuotedGroupMessage>> {
  const { orgId } = input;
  const out = new Map<string, QuotedGroupMessage>();
  const since = new Date(input.now.getTime() - QUOTE_LOOKBACK_MS);

  // 1. A message in this same batch.
  for (const bare of bares) {
    const b = input.batch.find((x) => sameWhatsAppMessage(bare, x.waMessageId));
    if (b) out.set(bare, { author: memberOf(b.userId, b.rosterName), at: b.sentAt, text: b.body, topic: null, matchId: null, match: null, found: true });
  }
  let left = bares.filter((b) => !out.has(b));
  if (left.length === 0) return out;

  // 2. MatchTime's own sends, by the indexed stanza id. (Rows acked before
  // the column existed were backfilled by the S0 migration.)
  const rows = await db.sentNotification.findMany({
    where: { createdAt: { gte: since }, waStanzaId: { in: left } },
    take: left.length * PER_ID,
    select: { key: true, kind: true, matchId: true, waStanzaId: true, waMessageId: true, text: true, createdAt: true },
  });
  const jobIds = [...new Set(rows.map((r) => botJobIdOfKey(r.key)).filter((x): x is string => !!x))];
  const jobs = jobIds.length
    ? await db.botJob.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, orgId: true, kind: true, text: true, sentAt: true, createdAt: true, matchId: true, aboutKey: true },
      })
    : [];
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const matchIds = [...new Set([...rows.map((r) => r.matchId), ...jobs.map((j) => j.matchId)].filter((x): x is string => !!x))];
  const matches = matchIds.length
    ? await db.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, date: true, activity: { select: { name: true, orgId: true } } } })
    : [];
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const ourMatch = (id: string | null): { ok: boolean; label: string | null } => {
    if (!id) return { ok: true, label: null };
    const m = matchById.get(id);
    return m && m.activity.orgId === orgId ? { ok: true, label: contextMatchLabel(m.activity.name, m.date) } : { ok: false, label: null };
  };
  const ourKey = (key: string) => key.startsWith(`${groupReplyKey(orgId, "")}`) || key.startsWith(`${hqReplyKey(orgId, "")}`);
  for (const bare of left) {
    for (const row of rows) {
      if (!sameWhatsAppMessage(bare, row.waStanzaId ?? row.waMessageId) || !GROUP_SEND_KINDS.has(row.kind)) continue;
      const jobId = botJobIdOfKey(row.key);
      if (jobId) {
        const job = jobById.get(jobId);
        if (!job || job.orgId !== orgId || !GROUP_JOB_KINDS.has(job.kind)) continue;
        const m = ourMatch(job.matchId);
        if (!m.ok) continue;
        out.set(bare, {
          author: null,
          at: job.sentAt ?? row.createdAt,
          text: row.text ?? job.text,
          topic: job.aboutKey ? topicOfDueKey(job.aboutKey) : null,
          matchId: job.matchId,
          match: m.label,
          found: true,
        });
        break;
      }
      // A scheduler post: this club's only when its match is, or when it is
      // MatchTime's reply claimed under this club's own key.
      const m = ourMatch(row.matchId);
      if (!m.ok || (!row.matchId && !ourKey(row.key))) continue;
      out.set(bare, { author: null, at: row.createdAt, text: row.text, topic: topicOfDueKey(row.key), matchId: row.matchId, match: m.label, found: true });
      break;
    }
  }
  left = left.filter((b) => !out.has(b));
  if (left.length === 0) return out;

  // 3. A member's earlier message (and, in HQ, MatchTime's own logged line).
  const said: Array<{ id: string; stanza: string | null; userId: string | null; text: string | null; at: Date; matchTime: boolean }> =
    input.channel === "group"
      ? (
          await db.analyzedMessage.findMany({
            // The unique id itself (a bare id) or the serialised form
            // `false_<group>_<stanza>_<participant>`, bounded by the
            // (orgId, createdAt) index to this club's last 14 days.
            where: { orgId, createdAt: { gte: since }, OR: [{ waMessageId: { in: left } }, ...left.map((b) => ({ waMessageId: { contains: `_${b}` } }))] },
            take: left.length * PER_ID,
            select: { waMessageId: true, authorUserId: true, body: true, createdAt: true },
          })
        ).map((r) => ({ id: r.waMessageId, stanza: null, userId: r.authorUserId, text: r.body, at: r.createdAt, matchTime: false }))
      : (
          await db.adminGroupMessage.findMany({
            where: { orgId, createdAt: { gte: since }, OR: [{ waStanzaId: { in: left } }, ...left.map((b) => ({ waMessageId: { contains: `_${b}` } }))] },
            take: left.length * PER_ID,
            select: { waMessageId: true, waStanzaId: true, fromMatchTime: true, senderUserId: true, text: true, createdAt: true },
          })
        ).map((r) => ({ id: r.waMessageId, stanza: r.waStanzaId, userId: r.senderUserId, text: r.text as string | null, at: r.createdAt, matchTime: r.fromMatchTime }));
  const userIds = [...new Set(said.map((r) => r.userId).filter((x): x is string => !!x))];
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  for (const bare of left) {
    const hit = said.find((r) => (r.stanza !== null && r.stanza === bare) || sameWhatsAppMessage(bare, r.id));
    if (!hit) continue;
    out.set(bare, {
      author: hit.matchTime ? null : memberOf(hit.userId && nameOf.has(hit.userId) ? hit.userId : null, hit.userId ? (nameOf.get(hit.userId) ?? null) : null),
      at: hit.at,
      text: hit.text,
      topic: null,
      matchId: null,
      match: null,
      found: true,
    });
  }
  return out;
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

/**
 * Does a reply quote MatchTime's post about ANOTHER match than the one an
 * owner acts on (review of #341, finding 8)? Then the owner writes nothing
 * to its own match: the quote stays visible, and the message is left for a
 * person to restate. A quote naming no match, or this match, is not.
 */
export function quotesAnotherMatch(reply: QuotedGroupMessage | null | undefined, matchId: string | null): boolean {
  return !!reply && reply.author === null && !!reply.matchId && reply.matchId !== matchId;
}
