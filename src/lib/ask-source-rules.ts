/**
 * WHERE THE PLAYERS ARE TO COME FROM, WHEN AN ORGANISER ASKS (Kemal,
 * 2026-10-28). Pure: no database, no model.
 *
 * "Make it a little bit stricter so MatchTime doesn't misunderstand the
 * command. Only if the admin specifically asks for players from the pool,
 * in their own words, can MatchTime do that. If MatchTime can't understand
 * the command and is in limbo between those two features, MatchTime can
 * ask the admin what they mean."
 *
 * The shared admin extractor reads WHERE the words say the players come
 * from (`AdminFacts`): one place or several ("partner clubs and the pool",
 * "everywhere", "her yerden"), or nowhere said (`sourceUnsaid`: "we need 2
 * players for Thursday", "bize oyuncu bul"). Code knows what this club
 * actually has. This file puts the two together:
 *
 *   places named               each of them, in `SOURCE_ORDER` (the
 *                              partners before the pool, so the pool joins
 *                              the partners' round and they keep their
 *                              hour); a place the club does not have says
 *                              so through its own door, in the same reply
 *   nowhere said               the club has partner clubs it may ask, or
 *                              the pool open, or both: ONE short question
 *                              naming its own players and what the club
 *                              has, never a guess. It has neither: its own
 *                              players, as before (there is no other place
 *                              to mean, so nothing to ask).
 *
 * The same in HQ (`admin-group-understand.ts`, "its own players" is a post
 * in the players' group) and in the players' group of a club with no HQ
 * (the analyze route, "its own players" is the recruit DM to its recent
 * players, `ask-source-group.ts`).
 *
 * The question is logged as MatchTime's own (`askSourceRef`), so the
 * organiser's answer is found by the safe-YES rule's own positional test
 * (`decideApproval`: a reply quoting it, or the next message after it in
 * the window) and READ BY THE MODEL (the same admin extractor, with the
 * question as MatchTime's last post). Never a phrase match on the answer.
 */
import type { AdminFacts } from "./pipeline/types";
import type { HqLogRow } from "./admin-group-log";
import { CONFIRM_WINDOW_MS, quotedLogRow, type QuotedMessage } from "./admin-group-confirm-rules";

/** Where players may be found: the club's own players' group, its partner
 *  clubs, or the MatchTime player pool. */
export type RecruitSource = "club" | "partners" | "pool";

/** The order the question names them in. */
export const SOURCE_ORDER: readonly RecruitSource[] = ["club", "partners", "pool"];

export interface SourcesAvailable {
  /** An active partner club the club may ask (asking switched on). */
  partners: boolean;
  /** The pool is open for the club (the platform switch and its flag). */
  pool: boolean;
}

export type SourceDecision =
  | { kind: "sources"; sources: RecruitSource[] }
  | { kind: "ask-which"; options: RecruitSource[] };

type RecruitFacts = Pick<AdminFacts, "pool" | "partnerClubs" | "ownClub" | "sourceUnsaid">;

/**
 * The places the words named, in `SOURCE_ORDER`, or null when they named
 * none. Words naming no other place are the club's own players, as they
 * always were.
 */
export function namedSources(facts: RecruitFacts): RecruitSource[] | null {
  if (facts.sourceUnsaid) return null;
  const named = SOURCE_ORDER.filter((s) => (s === "club" ? facts.ownClub === true : s === "partners" ? facts.partnerClubs === true : facts.pool === true));
  return named.length > 0 ? named : ["club"];
}

/** The places besides the club's own players this club has. */
export function otherSourcesOf(available: SourcesAvailable): RecruitSource[] {
  return SOURCE_ORDER.filter((s) => s !== "club" && available[s as "partners" | "pool"]);
}

/**
 * What to do with a recruit read from an organiser's words. The places the
 * words named are those places; nowhere said is a question when the club
 * has anywhere besides its own players to look.
 */
export function decideRecruitSource(facts: RecruitFacts, available: SourcesAvailable): SourceDecision {
  const named = namedSources(facts);
  if (named) return { kind: "sources", sources: named };
  const others = otherSourcesOf(available);
  return others.length > 0 ? { kind: "ask-which", options: ["club", ...others] } : { kind: "sources", sources: ["club"] };
}

/**
 * NOBODY LEFT AMONG THE CLUB'S OWN PLAYERS (the recruit DM found nobody new
 * to ask, 2026-10-28): the places the club has besides them, to offer as a
 * question, or none (the plain "nobody left" line).
 */
export function offerAfterNobodyLeft(available: SourcesAvailable): RecruitSource[] {
  return otherSourcesOf(available);
}

// ── The question, logged as MatchTime's in HQ ─────────────────────────

export const ASK_SOURCE_PREFIX = "ask-source:";

/** `ask-source:club+partners+pool`: the options it offered. */
export function askSourceRef(options: readonly RecruitSource[]): string {
  return `${ASK_SOURCE_PREFIX}${options.join("+")}`;
}

/** The options a logged question offered, or null for any other ref. */
export function parseAskSourceRef(ref: string | null | undefined): RecruitSource[] | null {
  if (!ref || !ref.startsWith(ASK_SOURCE_PREFIX)) return null;
  const opts = ref
    .slice(ASK_SOURCE_PREFIX.length)
    .split("+")
    .filter((s): s is RecruitSource => (SOURCE_ORDER as readonly string[]).includes(s));
  return opts.length > 0 ? opts : null;
}

/**
 * IS THIS MESSAGE IN THE PLACE OF AN ANSWER to MatchTime's "who shall I
 * ask?"? The safe-YES rule's own two positional tests
 * (`admin-group-confirm-rules.ts`, `decideApproval` rules 1 and 2), on the
 * question's logged row; whether it IS an answer, and which, is then the
 * model's read of the words (`sourceFromAnswer`).
 *
 *   1. A WhatsApp reply quoting the latest such question (by its id, or
 *      its words when the id is unknown): yes. Quoting anything else: no.
 *   2. Otherwise: the NEXT message in HQ after it (nobody else spoke in
 *      between), within `CONFIRM_WINDOW_MS`.
 *
 * Returns the options the question offered, or null.
 *
 * @param log the question's log since a day ago, oldest first, NOT
 *            including the message being decided: HQ's rows, or the
 *            players' group's (MatchTime's question and the organisers'
 *            messages read after it, `ask-source-group.ts`), so there
 *            "nobody else spoke" means no other organiser.
 */
export function sourceQuestionAnswered(p: {
  quoted: QuotedMessage | null;
  log: HqLogRow[];
  now: Date;
  windowMs?: number;
}): RecruitSource[] | null {
  const windowMs = p.windowMs ?? CONFIRM_WINDOW_MS;
  const asked = [...p.log].reverse().find((r) => r.fromMatchTime && parseAskSourceRef(r.askRef));
  if (!asked) return null;
  const options = parseAskSourceRef(asked.askRef)!;
  if (p.quoted && (p.quoted.text || p.quoted.fromMatchTime || p.quoted.messageId)) {
    const { row } = quotedLogRow(p.quoted, p.log);
    return row && row.waMessageId === asked.waMessageId ? options : null;
  }
  const questions = p.log.filter((r) => r.fromMatchTime && r.askRef);
  if (questions[questions.length - 1]?.waMessageId !== asked.waMessageId) return null;
  const fresh = p.now.getTime() - asked.createdAt.getTime() <= windowMs;
  const quiet = !p.log.some((r) => !r.fromMatchTime && r.createdAt.getTime() > asked.createdAt.getTime());
  return fresh && quiet ? options : null;
}

/**
 * The organiser's answer, as the admin extractor read it: a recruit from
 * the places the words name ("the pool", "both", "everywhere"). Anything
 * else (not a recruit, "unsaid" again, a failed read) is not an answer,
 * and the message is handled as it would have been with no question asked.
 */
export function sourcesFromAnswer(facts: AdminFacts | null): RecruitSource[] | null {
  if (!facts || facts.action !== "recruit") return null;
  return namedSources(facts);
}
