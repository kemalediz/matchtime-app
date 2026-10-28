/**
 * WHERE THE PLAYERS ARE TO COME FROM, WHEN AN ORGANISER ASKS IN HQ
 * (Kemal, 2026-10-28). Pure: no database, no model.
 *
 * "Make it a little bit stricter so MatchTime doesn't misunderstand the
 * command. Only if the admin specifically asks for players from the pool,
 * in their own words, can MatchTime do that. If MatchTime can't understand
 * the command and is in limbo between those two features, MatchTime can
 * ask the admin what they mean."
 *
 * The shared admin extractor reads WHERE the words say the players come
 * from (`AdminFacts`): the pool (`pool`), the partner clubs (`partnerClubs`),
 * the club's own players (none of the three), or nowhere said
 * (`sourceUnsaid`: "we need 2 players for Thursday", "bize oyuncu bul").
 * Code knows what this club actually has. This file puts the two together:
 *
 *   the pool, asked for        the pool (its own door says when it is not
 *                              open for the club)
 *   the partners, asked for    the partners (their door says when there are
 *                              none)
 *   the club's own players     the players' group, as before
 *   nowhere said               the club has partner clubs it may ask, or
 *                              the pool open, or both: ONE short question
 *                              naming the players' group and what the club
 *                              has, never a guess. It has neither: the
 *                              players' group, as before (there is no
 *                              other place to mean, so nothing to ask).
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
  | { kind: "source"; source: RecruitSource }
  | { kind: "ask-which"; options: RecruitSource[] };

type RecruitFacts = Pick<AdminFacts, "pool" | "partnerClubs" | "sourceUnsaid">;

/** The source the words named, or null when they named none. */
export function namedSource(facts: RecruitFacts): RecruitSource | null {
  if (facts.pool) return "pool";
  if (facts.partnerClubs) return "partners";
  if (facts.sourceUnsaid) return null;
  return "club";
}

/**
 * What to do with a recruit read from an organiser's words. A source the
 * words named is that source; nowhere said is a question when the club
 * has anywhere besides its own players' group to look.
 */
export function decideRecruitSource(facts: RecruitFacts, available: SourcesAvailable): SourceDecision {
  const named = namedSource(facts);
  if (named) return { kind: "source", source: named };
  const options = SOURCE_ORDER.filter((s) => s === "club" || available[s]);
  return options.length > 1 ? { kind: "ask-which", options } : { kind: "source", source: "club" };
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
 * @param log HQ rows since a day ago, oldest first, NOT including the
 *            message being decided.
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
 * The organiser's answer, as the admin extractor read it: a recruit from a
 * source the words name. Anything else (not a recruit, "unsaid" again, a
 * failed read) is not an answer, and the message is handled as it would
 * have been with no question asked.
 */
export function sourceFromAnswer(facts: AdminFacts | null): RecruitSource | null {
  if (!facts || facts.action !== "recruit") return null;
  return namedSource(facts);
}
