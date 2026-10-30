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
 * WHO may answer is FACTS (`isScoreAnswer`): EITHER
 *
 *   (a) the message tags the bot, while the question is open
 *       (`SCORE_ASK_TTL_MS`, two hours), OR
 *   (b) it comes from the person who posted the scoreline, or from an
 *       identified admin, within `SCORE_ANSWER_UNTAGGED_MS` (thirty
 *       minutes) of the question.
 *
 * WHAT the message says is the model's (2026-10-30, "no string parsing").
 * The router is shown that MatchTime is waiting for this sender's answer
 * and routes it; the score extractor reads the team it names (`winner`,
 * or the team beside the restated pair). Until today a word test here
 * (`scoreAnswerRef`, `scorePairAnswerSide`, a question-mark test) decided
 * both whether a message was an answer and which team it named, and
 * forced the route before the router ran.
 *
 * A sender WhatsApp did not identify can only use (a). Whether the
 * answerer may report a result at all is the engine's check, as for any
 * first result.
 */

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

/**
 * May this sender answer the open question now? The whole of rule (a) and
 * (b) in the header, minus the engine's "may this sender report a result
 * at all". Facts only: never the words.
 */
export function isScoreAnswer(args: {
  /** Not read (kept so callers need not change shape). */
  body?: string;
  tagged: boolean;
  senderUserId: string | null;
  senderIsAdmin: boolean;
  ask: { askedAt: string | Date; askerUserId: string | null };
  now: Date;
}): boolean {
  const { tagged, senderUserId, senderIsAdmin, ask, now } = args;
  if (!isScoreAskOpen(ask.askedAt, now)) return false;
  if (tagged) return true;
  if (!senderUserId) return false;
  if (!(senderIsAdmin || (ask.askerUserId !== null && ask.askerUserId === senderUserId))) return false;
  const t = typeof ask.askedAt === "string" ? Date.parse(ask.askedAt) : ask.askedAt.getTime();
  return now.getTime() - t <= SCORE_ANSWER_UNTAGGED_MS;
}


/** The whole numbers written in a message, in order, with @-mentions
 *  removed first (WhatsApp writes a mention of a person as their phone
 *  number, and of the bot as "@Match Time"). */
function numbersIn(body: string): number[] {
  const text = (body ?? "").replace(/@\S+/g, " ");
  return (text.match(/\d+/g) ?? []).map((d) => Number.parseInt(d, 10));
}

/**
 * Does the TEXT state this score: is `first` one of its numbers and
 * `second` ANOTHER? (Third review, item 1.)
 *
 * A first version only asked for two numbers, any two, so "see you
 * at 21:30" passed and the model's 0-0, or 3-3, was recorded. The
 * extractor's two numbers have to be numbers the sender wrote, each its
 * own: "3-3" needs two threes, and "21:30" supplies neither a 0 nor a
 * second 0. Anything else is a message with no score, whatever the
 * model returned.
 */
export function messageStatesScore(body: string, first: number, second: number): boolean {
  const found = numbersIn(body);
  const i = found.indexOf(first);
  if (i === -1) return false;
  found.splice(i, 1);
  return found.includes(second);
}



/**
 * A BARE "WRONG WAY ROUND" IS HONOURED ONCE PER MATCH (third review,
 * item 3). It names no winner, so two of them flip the result there and
 * back, each with a cheerful "Corrected". One `SentNotification` row per
 * match records that it has been used; after that the sender is told to
 * say the score and the team that won. Never cleared: once is once.
 */
export const SCORE_SWAP_KIND = "score-swap";
export function scoreSwapKey(matchId: string): string {
  return `${matchId}:${SCORE_SWAP_KIND}`;
}

// ── A CORRECTION OF A RECORDED RESULT ─────────────────────────────────
//
// Until 2026-10-30 a fixed vocabulary here ("other way round", "tam
// tersi", a "no"/"yanlış" opener with a scoreline or a team name, and a
// first-person word list) forced a tagged message to the score route
// before the router ran. The router is now shown, as a fact, that a
// result is recorded and this sender may correct it, and it routes on
// meaning; the score extractor reads `correction` and `swapped`.
