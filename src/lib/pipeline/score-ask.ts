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

/** The whole numbers written in a message, in order, with @-mentions
 *  removed first (WhatsApp writes a mention of a person as their phone
 *  number, and of the bot as "@Match Time"). */
function numbersIn(body: string): number[] {
  const text = (body ?? "").replace(/@\s*match\s*time\b/giu, " ").replace(/@\S+/g, " ");
  return (text.match(/\d+/g) ?? []).map((d) => Number.parseInt(d, 10));
}

/**
 * Does the TEXT state this score: is `first` one of its numbers and
 * `second` ANOTHER? (Third review, item 1.)
 *
 * `messageHasScoreline` only asked for two numbers, any two, so "see you
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
 * THE OPEN QUESTION, ANSWERED BY RESTATING IT (third review, item 2):
 * "Yellow 7-10", "10-7 yellow". The message is the pair that was asked
 * about, in either order, plus ONE team of the match and nothing else.
 * After "which team won?", the team named is the winner.
 *
 * Narrow on purpose: exactly those two numbers and no others, no
 * question mark, and what is left once the numbers are taken out must
 * be a bare team answer by `scoreAnswerSide`'s own rule. "yellow were
 * 7-10 down at one point" is a sentence, not an answer.
 */
export function scorePairAnswerSide(
  body: string,
  pair: { first: number; second: number },
  labels: readonly [string, string],
): TeamSide | null {
  if (/[?¿]/.test(body ?? "")) return null;
  const found = numbersIn(body);
  if (found.length !== 2 || !samePair(pair, { first: found[0], second: found[1] })) return null;
  const rest = (body ?? "")
    .replace(/@\s*match\s*time\b/giu, " ")
    .replace(/@\S+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[-:\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return scoreAnswerSide(rest, labels);
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

// ── A TAGGED CORRECTION, RECOGNISED WITHOUT A MODEL ───────────────────
//
// The one approved live run of the score check (2026-10-07, 94 calls)
// passed 45 of 47, and the extractor was right 47 times. The two
// failures were the ROUTER, whose prompt this work does not touch:
//
//   "@Match Time other way round"            -> unsure
//   "@Match Time yanlış, kırmızı 6 sarı 9"   -> other_att
//
// Both then go to the ATTENDANCE extractor, so the correction never
// happens, and the second hands two colour words to the stage that
// looks for people. Same remedy as the one-word answer: a fixed
// vocabulary, read in code before any model runs, and the router is
// handed the ids (`RouteBatchOptions.scoreCorrectionIds`).
//
// THE RULE, all of it:
//   - the message tags the bot                       (the caller checks)
//   - the club's latest played match has a recorded result and kicked
//     off inside the correction window               (the caller checks)
//   - and the text, mentions removed, is EITHER
//       a swap phrase, anywhere: "other way round", "wrong way round",
//       "the other way around", "tam tersi", "tersi";
//     OR
//       a correction OPENER, as its first words: "no", "nope", "wrong",
//       "that's wrong", "that is wrong", "not right", "yanlış", "hayır",
//       "öyle değil"
//       TOGETHER WITH a scoreline (two numbers) or one of THAT match's
//       team names,
//       AND the sender is not talking about themselves ("no, I'm out",
//       "no, put me on yellow", "hayır ben yokum"): that is attendance,
//       whatever else the sentence mentions.
//
// It decides the ROUTE and nothing else. Whether the sender may correct
// a result, and what the correction says, are the engine's, unchanged.

function plainText(body: string): string {
  return (body ?? "").replace(/@\s*match\s*time\b/giu, " ").replace(/@\S+/g, " ");
}

/** Lower case, Turkish letters folded, apostrophes dropped, everything
 *  else that is not a letter or digit turned into a space. */
function normalise(body: string): string {
  return plainText(body)
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const SWAP_PHRASE = /(?:^| )(?:other way a?round|wrong way a?round|tam tersi|tersi)(?: |$)/;
const CORRECTION_OPENER = /^(?:no|nope|wrong|thats wrong|that is wrong|not right|yanlis|hayir|oyle degil)(?: |$)/;
/** The sender talking about THEMSELVES: attendance, not a result. */
const FIRST_PERSON = new Set(["i", "im", "ill", "ive", "id", "me", "my", "mine", "ben", "beni", "bana", "benim", "bende"]);
const FIRST_PERSON_TR_VERB = /(?:yorum|mem|mam|yokum|varim|irim|urum)$/;

/**
 * The cheap first look, needing no team names: is it worth loading the
 * match to decide? True for every message `isScoreCorrectionText` could
 * accept, and for some it will not ("no, I'm out").
 */
export function mayBeScoreCorrection(body: string): boolean {
  const n = normalise(body);
  return SWAP_PHRASE.test(n) || CORRECTION_OPENER.test(n);
}

/**
 * Is this text, on its words alone, a correction of a recorded result?
 * `labels` are the names of the match that would be corrected.
 */
export function isScoreCorrectionText(body: string, labels: readonly [string, string]): boolean {
  const n = normalise(body);
  if (!n) return false;
  if (SWAP_PHRASE.test(n)) return true;
  if (!CORRECTION_OPENER.test(n)) return false;
  const tokens = n.split(" ");
  if (tokens.some((t) => FIRST_PERSON.has(t) || FIRST_PERSON_TR_VERB.test(t))) return false;
  if (numbersIn(body).length >= 2) return true;
  // One of the match's team names: single words, and adjacent pairs for
  // a two-word name.
  const words = plainText(body).split(/[^\p{L}\p{N}'’]+/u).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (resolveTeamRef(words[i], labels, null)) return true;
    if (i + 1 < words.length && resolveTeamRef(`${words[i]} ${words[i + 1]}`, labels, null)) return true;
  }
  return false;
}
