/**
 * THE SAFE-YES RULE IN A CLUB'S ADMIN GROUP (Kemal, 2026-10-16).
 *
 * "A bare YES must not approve something it may not be about." In a busy
 * HQ a YES may be to another organiser. The shared router says only that
 * a message reads as approval (`approve`); WHO it was for is decided here,
 * from facts, never by the model:
 *
 *   1. A WhatsApp reply that quotes MatchTime's question about an item
 *      still waiting approves that item. A reply quoting another
 *      organiser is their conversation: nothing, and no reply.
 *   2. Otherwise the YES approves the item MatchTime asked about last
 *      when it is the NEXT message in HQ after that question (nobody else
 *      spoke in between) and arrives within CONFIRM_WINDOW_MS of it.
 *   3. Otherwise MatchTime asks once, briefly ("Is that YES to the
 *      proposed teams for Fri 16 Oct?"); two items waiting: it asks which,
 *      and to reply to that message. The answer is then the next message
 *      after MatchTime's question, so rule 2 applies to it.
 *   Asked once: a second unclear YES within the window gets no second ask.
 *
 * WHY 15 MINUTES. MatchTime's questions in HQ are answered at once when
 * they are answered at all (the teams arrive at the club's "teams ready"
 * time and an organiser is waiting for them; a pasted list is answered by
 * the organiser who pasted it). Fifteen minutes covers a reply typed after
 * reading the teams through on a phone, and is half the pasted list's own
 * 30 minute life (`PASTE_PROPOSAL_TTL_MS`), so a list is never approved by
 * a YES from the far end of its life without a check. Later than that, a
 * YES is as likely to be about whatever the organisers are discussing by
 * then, and one short question costs less than wrong final teams.
 *
 * Pure. No database, no model.
 */
import type { HqLogRow } from "./admin-group-log";
import { sameWhatsAppMessage } from "./quoted-message";

export const CONFIRM_WINDOW_MS = 15 * 60 * 1000;

export interface PendingItem {
  /** `teamsAskRef(matchId)`, `listAskRef(pasteMessageId)`,
   *  `partnerAskRef(askId)` (a partner club's ask for a player, cross-club
   *  ask slice S2), `feeAskRef(proposalId)` (a free place, 2026-10-16) or
   *  `pairingNoticeKey(pairing, club)` (a partner-club pairing waiting for
   *  the owner's answer, 2026-10-21). */
  ref: string;
  kind: "teams" | "list" | "partner-ask" | "fee" | "pairing";
  /** When it was (last) asked: a quote of an older post about it is stale. */
  askedAt?: Date;
}

export interface QuotedMessage {
  /** The Pi saw the quoted message was MatchTime's own. */
  fromMatchTime?: boolean;
  text?: string | null;
  /** The quoted message's WhatsApp id (kept since slice S4). */
  messageId?: string | null;
  /** Who wrote it, from the Pi's contact lookup: unverified. */
  authorName?: string | null;
  authorPhone?: string | null;
  /** The quoted id was found in the club's own records (a send, a logged
   *  line, an organiser's message). Then its WORDS are never matched
   *  against the log: the id decides (review of #341, finding 5). */
  found?: boolean;
}

export type ApprovalDecision =
  | { kind: "approve"; item: PendingItem; why: "quoted" | "next-message" }
  | { kind: "ask"; item: PendingItem }
  | { kind: "ask-which"; items: PendingItem[] }
  | { kind: "nothing-waiting" }
  | { kind: "silent"; why: "nothing-waiting" | "reply-to-organiser" | "asked-already" };

/** A logged question is recorded a moment before or after the proposal
 *  row it is about; older than that by this much, it is an earlier post. */
const STALE_SLACK_MS = 60 * 1000;

/** Whitespace-folded, for comparing a quote with what MatchTime posted. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Did MatchTime post this quoted text? WhatsApp quotes the whole message
 * and the log holds its first 500 characters. The quote must agree with
 * the WHOLE logged line (up to the shorter of the two), not its opening
 * words: a reposted proposal begins with the same header as the one it
 * replaced (review of #341, finding 4). The text fallback, for a quote
 * with no id the log knows.
 */
export function matchQuoted(quoted: string, rows: HqLogRow[]): HqLogRow | null {
  const q = flat(quoted);
  if (!q) return null;
  const hits = rows.filter((r) => {
    if (!r.fromMatchTime) return false;
    const t = flat(r.text);
    const n = Math.min(q.length, t.length);
    return n >= 8 && q.slice(0, n) === t.slice(0, n);
  });
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * The logged line an HQ reply quotes: BY ITS ID first (MatchTime's line
 * carries its send's stanza id once acked; an organiser's carries its own
 * WhatsApp id), and only for a quote whose id the club does not know, by
 * its words. `by` says which.
 */
export function quotedLogRow(quoted: QuotedMessage | null, log: HqLogRow[]): { row: HqLogRow | null; by: "id" | "text" | null } {
  if (!quoted) return { row: null, by: null };
  const id = quoted.messageId ?? null;
  if (id) {
    const row = [...log].reverse().find((r) => (!!r.waStanzaId && sameWhatsAppMessage(id, r.waStanzaId)) || sameWhatsAppMessage(id, r.waMessageId));
    if (row) return { row, by: "id" };
  }
  if (quoted.found) return { row: null, by: "id" };
  const row = quoted.text ? matchQuoted(quoted.text, log) : null;
  return { row, by: row ? "text" : null };
}

/**
 * @param log HQ rows since a day ago, oldest first, NOT including the
 *            message being decided.
 */
export function decideApproval(p: {
  pending: PendingItem[];
  quoted: QuotedMessage | null;
  log: HqLogRow[];
  now: Date;
  windowMs?: number;
}): ApprovalDecision {
  const windowMs = p.windowMs ?? CONFIRM_WINDOW_MS;
  const byRef = new Map(p.pending.map((i) => [i.ref, i]));

  // 1. A WhatsApp reply, decided by the line it quotes.
  if (p.quoted && (p.quoted.text || p.quoted.fromMatchTime || p.quoted.messageId)) {
    const { row: asked } = quotedLogRow(p.quoted, p.log);
    if (asked && !asked.fromMatchTime) return { kind: "silent", why: "reply-to-organiser" };
    if (!asked && !p.quoted.fromMatchTime) return { kind: "silent", why: "reply-to-organiser" };
    if (p.pending.length === 0) return { kind: "nothing-waiting" };
    const item = asked?.askRef ? byRef.get(asked.askRef) : undefined;
    // An OLDER post about the same thing (the teams proposed, then changed
    // and proposed again) is not a YES to what is waiting now: ask.
    const stale = !!item?.askedAt && !!asked && asked.createdAt.getTime() < item.askedAt.getTime() - STALE_SLACK_MS;
    if (item && !stale) return { kind: "approve", item, why: "quoted" };
    // MatchTime's, but not a question about anything still waiting.
    return ask(p.pending, p.log, p.now, windowMs);
  }

  if (p.pending.length === 0) return { kind: "silent", why: "nothing-waiting" };

  // 2. The next message after MatchTime's last question, within the window.
  const questions = p.log.filter((r) => r.fromMatchTime && r.askRef);
  const last = questions[questions.length - 1];
  if (last) {
    const fresh = p.now.getTime() - last.createdAt.getTime() <= windowMs;
    // Strictly after: the message that made MatchTime ask ("swap Ali and
    // Can", a pasted list) is recorded at the same instant as the question
    // it caused, and is not conversation in between.
    const quiet = !p.log.some((r) => !r.fromMatchTime && r.createdAt.getTime() > last.createdAt.getTime());
    const item = byRef.get(last.askRef!);
    if (fresh && quiet && item) return { kind: "approve", item, why: "next-message" };
  }

  // 3. Ask.
  return ask(p.pending, p.log, p.now, windowMs);
}

/** The ask ref of "Which one is that YES for?". */
export const WHICH_ASK_REF = "which";

function ask(pending: PendingItem[], log: HqLogRow[], now: Date, windowMs: number): ApprovalDecision {
  const ref = pending.length === 1 ? pending[0].ref : WHICH_ASK_REF;
  const recentAsk = log.some(
    (r) => r.fromMatchTime && r.askRef === ref && r.waMessageId.startsWith("mt:ask:") && now.getTime() - r.createdAt.getTime() <= windowMs,
  );
  if (recentAsk) return { kind: "silent", why: "asked-already" };
  return pending.length === 1 ? { kind: "ask", item: pending[0] } : { kind: "ask-which", items: pending };
}
