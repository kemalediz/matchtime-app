/**
 * "WHICH TEAM WON?": the question the bot asks about a scoreline, and
 * how its answer is recognised (2026-10-07, review of PR #214, item 4).
 * Pure: no DB, no clock, no model.
 *
 * The first version asked "10 - 7 to which team?" and forgot it had
 * asked. A reply of "Yellow" is not a result by itself, so it was routed
 * nowhere and the score was never recorded: a question with no way to
 * answer it.
 *
 * ── WHERE THE QUESTION LIVES ─────────────────────────────────────────
 * One `SentNotification` row per match, kind `SCORE_ASK_KIND`, whose KEY
 * carries the two numbers: `<matchId>:score-ask:<first>-<second>`. The
 * key is the payload on purpose: the table has no free column, the key
 * is unique, and the numbers are the whole of what has to be remembered.
 * Asking about a different pair replaces the row; recording ANY result
 * for the match deletes it (`owner-deps.ts`). The engine only ever sees
 * it as `SquadState.completedMatch.pendingScore`.
 *
 * ── HOW AN ANSWER IS RECOGNISED, WITHOUT A MODEL ─────────────────────
 * While a question is open, a short message that is nothing but a team
 * name ("Yellow", "yellows won", "to the reds", "sarılar kazandı") is
 * the answer. `scoreAnswerRef` strips the words around the name and
 * `score-teams.ts` decides whether what is left names a side. Both the
 * router (which would otherwise call a bare "Yellow" chatter) and the
 * score runner (which would otherwise pay a model to read one word) use
 * it. Anything longer, or with a number in it, goes the ordinary way.
 */
import { resolveTeamRef, type TeamSide } from "./score-teams";

export const SCORE_ASK_KIND = "score-ask";

/** How long a question stays open. The answer normally comes inside a
 *  minute; a question asked late at night should still be answerable
 *  the next morning. */
export const SCORE_ASK_TTL_MS = 24 * 60 * 60 * 1000;

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
