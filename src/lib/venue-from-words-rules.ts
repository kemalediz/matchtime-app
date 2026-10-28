/**
 * WHICH PLACE THE ORGANISER MEANS (2026-10-28, Kemal: every admin feature
 * by WhatsApp too). "@Match Time our pitch is Goals Sutton": the admin
 * extractor hands back the words ("Goals Sutton"); Google's suggestions for
 * them come back from the same Places search the web's venue box uses
 * (`places.ts`); this decides, by code, whether one of them is clearly it.
 *
 *   one       a single suggestion, or exactly one whose name IS the words
 *             (compared normalised, as venue text always is). Set it.
 *   several   anything else with suggestions: a short numbered list, and
 *             the organiser picks by number. A number picked from that
 *             list (`venueChoice`) is that place; one past its end shows
 *             the list again.
 *   none      Google found nothing.
 *
 * Pure: no database, no Google. The words a person typed are never parsed
 * here; only Google's names are compared with the words the model read.
 */
import { normaliseVenueText } from "./venue-location-rules";
import type { VenueSuggestion } from "./venue-suggest-rules";
import { CONFIRM_WINDOW_MS, quotedLogRow, type QuotedMessage } from "./admin-group-confirm-rules";
import type { HqLogRow } from "./admin-group-log";

/**
 * What setting the pitch by words came to: the `AnalyzedMessage.intent`
 * and HQ outcome (with "hq-" in front). None of these replies is a squad
 * post, so the players' group's squad-composition pass leaves them alone
 * (`group-copy.ts` `skipsSquadComposition`): the numbered list of places
 * would otherwise be read as a roster and replaced by the squad.
 */
export const VENUE_WORDS_OUTCOMES = ["venue-set", "venue-which", "venue-none", "venue-unavailable", "venue-no-name"] as const;
export type VenueFromWordsOutcome = (typeof VENUE_WORDS_OUTCOMES)[number];

/** The most places a numbered list shows. */
export const VENUE_CHOICES_MAX = 5;

export type VenueChoice =
  | { kind: "one"; pick: VenueSuggestion }
  | { kind: "several"; options: VenueSuggestion[] }
  | { kind: "none" };

export function chooseVenue(words: string, suggestions: readonly VenueSuggestion[], choice: number | null): VenueChoice {
  const list = suggestions.slice(0, VENUE_CHOICES_MAX);
  if (list.length === 0) return { kind: "none" };
  if (choice !== null && choice >= 1) {
    return choice <= list.length ? { kind: "one", pick: list[choice - 1] } : { kind: "several", options: list };
  }
  if (list.length === 1) return { kind: "one", pick: list[0] };
  const wanted = normaliseVenueText(words);
  const exact = list.filter((x) => normaliseVenueText(x.primary) === wanted);
  return exact.length === 1 ? { kind: "one", pick: exact[0] } : { kind: "several", options: list };
}

// ── MatchTime's own list of places, and the answer to it ──────────────

const VENUE_PICK_PREFIX = "venue-pick:";

/** The askRef MatchTime's numbered list of places is logged under. It
 *  carries the words that were looked up, so a "2" is looked up again for
 *  the SAME words, read from the record and never from the post. */
export function venuePickAskRef(words: string): string {
  return `${VENUE_PICK_PREFIX}${words.replace(/\s+/g, " ").trim().slice(0, 120)}`;
}

/** The words a venue list was for, or null when the ref is not one. */
export function parseVenuePickRef(ref: string | null | undefined): string | null {
  if (!ref || !ref.startsWith(VENUE_PICK_PREFIX)) return null;
  const words = ref.slice(VENUE_PICK_PREFIX.length).trim();
  return words || null;
}

/**
 * Is this message in the place of an answer to MatchTime's list of places?
 * The safe-YES rule's two positional tests, as for "who shall I ask?"
 * (`ask-source-rules.ts` `sourceQuestionAnswered`): a reply quoting the
 * list, or the next message after it (no other organiser message since,
 * and the list is MatchTime's latest question) within the window. Returns
 * the list's log row, or null.
 */
export function venueListAnswered(p: {
  quoted: QuotedMessage | null;
  log: HqLogRow[];
  now: Date;
  windowMs?: number;
}): HqLogRow | null {
  const windowMs = p.windowMs ?? CONFIRM_WINDOW_MS;
  const asked = [...p.log].reverse().find((r) => r.fromMatchTime && parseVenuePickRef(r.askRef));
  if (!asked) return null;
  if (p.quoted && (p.quoted.text || p.quoted.fromMatchTime || p.quoted.messageId)) {
    const { row } = quotedLogRow(p.quoted, p.log);
    return row && row.waMessageId === asked.waMessageId ? asked : null;
  }
  const questions = p.log.filter((r) => r.fromMatchTime && r.askRef);
  if (questions[questions.length - 1]?.waMessageId !== asked.waMessageId) return null;
  const fresh = p.now.getTime() - asked.createdAt.getTime() <= windowMs;
  const quiet = !p.log.some((r) => !r.fromMatchTime && r.createdAt.getTime() > asked.createdAt.getTime());
  return fresh && quiet ? asked : null;
}
