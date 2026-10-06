/**
 * "WHICH TEAM WON?": the question the bot asks about a scoreline, and
 * how its answer is recognised (2026-10-07, narrowed after the second
 * review of PR #214). Pure: no DB, no clock, no model.
 *
 * The first version asked "10 - 7 to which team?" and forgot it had
 * asked, so a reply of "Yellow" went nowhere. The second remembered,
 * for a day, and took a bare team name from anybody, including about a
 * match that already had a result: a conversation about bibs hours later
 * could record or overwrite a score. This is the third, and every rule
 * below makes it narrower.
 *
 * ── THE QUESTION ─────────────────────────────────────────────────────
 * Asked ONLY about a match with NO recorded result, and valid only
 * while that stays true: every loader drops it once the match has a
 * score, and `setMatchScore` deletes the row whoever writes the score.
 *
 * One `SentNotification` row per match, kind `SCORE_ASK_KIND`. The KEY
 * carries the two numbers (`<matchId>:score-ask:<first>-<second>`) and
 * `targetUser` carries who posted the scoreline, when WhatsApp told us.
 * Asking about a different pair replaces the row.
 *
 * ── THE ANSWER, AND WHO MAY GIVE IT ──────────────────────────────────
 * A short message that is nothing but one of that match's team names
 * ("Yellow", "yellows won", "sarılar kazandı"), never a question
 * ("Yellow?"), and EITHER
 *
 *   (a) it tags the bot, while the question is open (`SCORE_ASK_TTL_MS`,
 *       two hours), OR
 *   (b) it comes from the person who posted the scoreline, or from an
 *       identified admin, within `SCORE_ANSWER_UNTAGGED_MS` (thirty
 *       minutes) of the question.
 *
 * A sender WhatsApp did not identify can only use (a): there is no
 * identity to match against the one the question recorded. Whether the
 * answerer may report a result at all is the engine's check, as for any
 * first result.
 *
 * `isScoreAnswer` is that rule, in one place. The analyze route uses it
 * to send the message to the score route (deterministically: it does not
 * depend on what the router model said, or on the router having answered
 * at all), the score runner uses it to read the answer without a model,
 * and the engine applies it again before anything is written.
 */
import { resolveTeamRef, type TeamSide } from "./score-teams";

export const SCORE_ASK_KIND = "score-ask";

/** How long a question stays open, for an answer that TAGS the bot. The
 *  answer normally comes inside a minute. Two hours covers the walk
 *  home; it was a day, and a day is long enough for an unrelated
 *  conversation to wander into it. */
export const SCORE_ASK_TTL_MS = 2 * 60 * 60 * 1000;

/** How long an UNTAGGED answer is accepted, and then only from the
 *  person who posted the scoreline or an identified admin. */
export const SCORE_ANSWER_UNTAGGED_MS = 30 * 60 * 1000;

export function scoreAskKey(matchId: string, first: number, second: number): string {
  return `${matchId}:${SCORE_ASK_KIND}:${first}-${second}`;
}

export function parseScoreAskKey(key: string): { matchId: string; first: number; second: number } | null {
  const m = new RegExp(`^(.+):${SCORE_ASK_KIND}:(\\d{1,2})-(\\d{1,2})$`).exec(key);
  if (!m) return null;
  return { matchId: m[1], first: Number(m[2]), second: Number(m[3]) };
}

/** Is the question still open at `now`? */
export function isScoreAskOpen(askedAt: string | Date, now: Date): boolean {
  const t = typeof askedAt === "string" ? Date.parse(askedAt) : askedAt.getTime();
  return Number.isFinite(t) && now.getTime() >= t && now.getTime() - t <= SCORE_ASK_TTL_MS;
}

/** Do two scorelines name the same pair of numbers, in either order? */
export function samePair(a: { first: number; second: number }, b: { first: number; second: number }): boolean {
  return (a.first === b.first && a.second === b.second) || (a.first === b.second && a.second === b.first);
}

const LEADING_TAG = /^\s*@\s*match\s*time\b[\s,:]*/iu;
const TRAILING_TAG = /[\s,]*@\s*match\s*time\s*$/iu;
/** Words that may stand in front of the team in an answer. */
const BEFORE = /^(?:(?:it\s+was|it's|its|was|to|for|the)\s+)+/iu;
/** Words that may follow it. */
const AFTER = /\s+(?:won|wins|win|did|kazandı|kazandi|aldı|aldi)\s*$/iu;

/**
 * The team reference in a message that is nothing but an answer to
 * "which team won?", or null. Deliberately narrow: no digits, at most
 * four words once the surroundings are stripped.
 */
export function scoreAnswerRef(body: string): string | null {
  let s = (body ?? "").trim().replace(LEADING_TAG, "").replace(TRAILING_TAG, "");
  if (/\d/.test(s)) return null;
  // "Yellow?" is somebody asking, not somebody answering.
  if (/[?¿]/.test(s)) return null;
  s = s.replace(/^[\s"'“”‘’(]+|[\s"'“”‘’).,!?]+$/gu, "").trim();
  s = s.replace(BEFORE, "").replace(AFTER, "").trim();
  if (!s) return null;
  if (s.split(/\s+/).length > 4) return null;
  return s;
}

/** The side a message answers the open question with, or null. */
export function scoreAnswerSide(body: string, labels: readonly [string, string]): TeamSide | null {
  const ref = scoreAnswerRef(body);
  return ref ? resolveTeamRef(ref, labels, null) : null;
}

/**
 * May this message answer the open question? The whole of rule (a) and
 * (b) in the header, minus the engine's "may this sender report a result
 * at all".
 */
export function isScoreAnswer(args: {
  body: string;
  tagged: boolean;
  senderUserId: string | null;
  senderIsAdmin: boolean;
  ask: { askedAt: string | Date; askerUserId: string | null };
  now: Date;
}): boolean {
  const { body, tagged, senderUserId, senderIsAdmin, ask, now } = args;
  if (/[?¿]/.test(body ?? "")) return false;
  if (!isScoreAskOpen(ask.askedAt, now)) return false;
  if (tagged) return true;
  if (!senderUserId) return false;
  if (!(senderIsAdmin || (ask.askerUserId !== null && ask.askerUserId === senderUserId))) return false;
  const t = typeof ask.askedAt === "string" ? Date.parse(ask.askedAt) : ask.askedAt.getTime();
  return now.getTime() - t <= SCORE_ANSWER_UNTAGGED_MS;
}

/**
 * Does the TEXT contain a scoreline: two numbers? (M1, second review.)
 *
 * The extractor says whether a message has a score (`hasScore`), and a
 * model that ignores that instruction sends `true` with two zeros for
 * "good game lads". So the flag is not trusted alone: no two numbers in
 * the message, no score, whatever the model said. Digits only. A result
 * written in words ("five three") is therefore not recorded; the bot
 * asks for the score when it is tagged.
 *
 * @-mentions are removed first: WhatsApp writes a mention of a person
 * as their phone number.
 */
export function messageHasScoreline(body: string): boolean {
  const text = (body ?? "").replace(/@\S+/g, " ");
  return (text.match(/\d+/g) ?? []).length >= 2;
}
