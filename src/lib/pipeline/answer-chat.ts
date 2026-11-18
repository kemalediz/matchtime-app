/**
 * THE CHAT AS THE UNIFIED ANSWER READS IT (2026-11-10; moved here from the
 * open answer, `open-answer.ts`, when that was deleted on 2026-11-18).
 *
 * Pure text helpers for what the model is shown: the group's week of chat,
 * one line per message with its day and time, and phone numbers scrubbed
 * from every line. No database access.
 */
import { formatLondon } from "../london-time";
import { WEEK_CHAT_MAX_LINES } from "../week-chat-window";

/** The chat lines shown: the group's week, newest 300 (`week-chat.ts`;
 *  Kemal 2026-11-10, "all messages since last 1 week"). */
export const ANSWER_CHAT_MAX_LINES = WEEK_CHAT_MAX_LINES;
/** The input budget for the chat, in characters (about 15k tokens at the
 *  measured 2.6 characters a token): past it the OLDEST lines go, so a
 *  week of long posts cannot run the call's cost up. */
export const ANSWER_CHAT_MAX_CHARS = 40_000;
/** One line's words, at most: a long post is cut, not dropped. */
const CHAT_LINE_MAX_CHARS = 600;

/** A run of nine or more digits, with the spaces, dots, dashes and
 *  brackets people write in phone numbers, and an optional "+" or "@". */
const PHONE_RUN = /[+@]?\(?\d[\d\s().-]{7,}\d/g;
const HIDDEN = "[number hidden]";

/** PURE. Phone numbers out of any text the model is shown. */
export function scrubPhones(text: string): string {
  return text.replace(PHONE_RUN, (m) => (m.replace(/\D/g, "").length >= 9 ? HIDDEN : m));
}

/** PURE. An author as the model may see them: a name, or "a member" when
 *  there is none or it is a phone number. */
export function scrubAuthor(author: string | null): string {
  if (!author) return "a member";
  const a = author.trim();
  if (!/\p{L}/u.test(a) || scrubPhones(a) !== a) return "a member";
  return a;
}

/**
 * PURE. The chat as the model reads it: "[Mon 9 Nov 19:33] Ali Kaya: ..."
 * (London), MatchTime's lines as MatchTime, an author that is a phone
 * number or no name as "a member", a long post's later lines indented
 * under it and its words cut at `CHAT_LINE_MAX_CHARS`. The newest
 * `ANSWER_CHAT_MAX_LINES` that fit `ANSWER_CHAT_MAX_CHARS`.
 */
export function chatLines(
  history: Array<{ author: string | null; body: string; at?: Date | null }>,
): Array<{ body: string; line: string; who: string }> {
  const out: Array<{ body: string; line: string; who: string }> = [];
  let chars = 0;
  for (const h of history.slice(-ANSWER_CHAT_MAX_LINES).reverse()) {
    const who = (h.author ?? "").toLowerCase() === "matchtime" ? "MatchTime" : scrubAuthor(h.author);
    const words = h.body.trim().length > CHAT_LINE_MAX_CHARS ? `${h.body.trim().slice(0, CHAT_LINE_MAX_CHARS)}...` : h.body.trim();
    const when = h.at ? `[${formatLondon(h.at, "EEE d MMM HH:mm")}] ` : "";
    const line = `  ${when}${who}: ${words.replace(/\n/g, "\n    ")}`;
    if (chars + line.length + 1 > ANSWER_CHAT_MAX_CHARS) break;
    chars += line.length + 1;
    out.push({ body: h.body, line, who });
  }
  return out.reverse();
}
