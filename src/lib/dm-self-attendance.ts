/**
 * COLD self-attendance in a 1-1 DM — pure classification (2026-08-31).
 *
 * WHY THIS EXISTS
 * ---------------
 * The recruit blast DMs a player about the next match. Plenty of players
 * — especially the older, less technical half of a club — reply "IN" to
 * the DM and consider themselves signed up. (Since 2026-08-31 the invite
 * explicitly ASKS for that reply; before then it led with a magic link
 * and they replied anyway.) Until this existed, that reply matched no
 * pending prompt in
 * /api/whatsapp/dm-reply (tentative follow-up, roster survey, bench offer,
 * collector fee) so it was silently dropped: the player believed they had
 * a spot and nothing was recorded. Same silent-failure class as the
 * duplicate-send incident, where the DB looked healthy and the humans got
 * the wrong outcome.
 *
 * INTERACTION CONTRACT
 * --------------------
 * A DM to MatchTime is inherently directed at the bot, so no "@Match Time"
 * tag is required (src/lib/interaction-contract.ts requires a tag only for
 * GROUP messages, and even there exempts a player's own self-attendance —
 * `isSelfAttendanceVerdict` / `actionRequiresTag`). This module handles
 * exactly that exempt class: the sender's OWN in/out, never a third party.
 *
 * DESIGN: A REGEX FAST-PATH IN FRONT OF AN LLM
 * --------------------------------------------
 * `classifyDmSelfAttendance` is a cheap, instant, WHOLE-MESSAGE regex for
 * the unambiguous cases ("IN", "count me in", "cant make it"). It is a
 * fast-path ONLY: it is free, so we use it, but it is NOT the decision.
 *
 * Real replies from this club look like "yeah sure count me in", "why not,
 * coming", "go on then", "can't tomorrow sorry". Many of these players are
 * older and not technical; they write naturally and never type keywords, so
 * anything the fast-path does not recognise goes to the LLM
 * (`classifyMatchAvailability`) rather than being dropped. `unclear` from
 * the model means DO NOTHING — never a guess.
 *
 * Every fast-path pattern is anchored to the WHOLE normalised message, so a
 * message that merely contains "in" ("I'm in London this week", "the game is
 * in Sutton") never short-circuits to a write; it goes to the model, which
 * is far better placed to judge it.
 *
 * Deliberately NOT matched by the FAST-PATH (all deferred to the LLM):
 *   - bare acknowledgements: "yes", "ok", "👍", "✅" — with no pending
 *     prompt to anchor them there is nothing to say yes TO;
 *   - tentative: "maybe", "not sure", "I'll try";
 *   - anything containing "?";
 *   - hypothetical / past tense (reuses `looksLikeHypotheticalOrPast`);
 *   - third-party statements ("Kieran is in") — a directed op, group-only.
 */
import { looksLikeHypotheticalOrPast } from "./interaction-contract";
import {
  classifyMatchAvailability,
  type MatchAvailabilityContext,
} from "./match-availability-classifier";

export type DmSelfAttendance = "in" | "out";

/** Longest message we will even consider. A genuine self-attendance line
 *  is short; anything longer is conversation. */
const MAX_LEN = 60;

/**
 * Lowercase, strip accents, drop apostrophes ("i'm" → "im", "can't" →
 * "cant"), drop emoji and stray punctuation, collapse whitespace.
 */
function normalise(text: string): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’'`´]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[‍️]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Leading social filler we allow before the statement itself. Note that
 *  a message consisting ONLY of filler ("yes", "ok", "sorry") normalises
 *  to an empty core and is therefore rejected. */
const LEAD = String.raw`(?:(?:yes|yeah|yep|yup|yh|ya|ok|okay|sure|sorry|hi|hey|hello|alright|right|ah)\s+)*`;

/** Trailing courtesy + match-reference filler. */
const TAIL = String.raw`(?:\s+(?:please|pls|plz|mate|m8|bro|bruv|lads|thanks|thank you|thanx|thx|cheers|ta|definitely|deffo|for (?:it|tonight|tomorrow|today|this one|the game|the match|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tonight|tomorrow|today|this one|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday))*`;

/** Self-attendance IN, as a whole message. */
const IN_CORE = [
  String.raw`(?:(?:im|i am|am)\s+)?in`,
  String.raw`count me in`,
  String.raw`(?:put|stick|sign|add|book|mark) me in`,
  String.raw`(?:ill|i will) (?:play|be there|be playing)`,
  String.raw`i can (?:play|make it)`,
  String.raw`(?:im|i am) playing`,
];

/** Self-attendance OUT, as a whole message. */
const OUT_CORE = [
  String.raw`(?:(?:im|i am|am)\s+)?out`,
  String.raw`count me out`,
  String.raw`(?:i )?(?:cant|cannot) (?:make it|play|come|attend|do it|make this one)`,
  String.raw`(?:im |i am )?not (?:playing|available|coming|in)`,
  String.raw`not (?:this week|tonight|tomorrow|today)`,
  String.raw`(?:i )?wont (?:make it|be there|be playing|be able to play)`,
  String.raw`(?:pull|take) me out`,
];

function whole(cores: string[]): RegExp {
  return new RegExp(`^${LEAD}(?:${cores.join("|")})${TAIL}$`);
}

const IN_RE = whole(IN_CORE);
const OUT_RE = whole(OUT_CORE);

/**
 * Is this DM body an unambiguous statement of the SENDER'S OWN
 * attendance? Returns null for everything else so the caller falls
 * through to its existing handling.
 */
export function classifyDmSelfAttendance(text: string): DmSelfAttendance | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  if (raw.length > MAX_LEN) return null;
  // A question is a question. It belongs to the Q&A path, never to an
  // attendance write ("am I in?", "in?").
  if (raw.includes("?")) return null;
  // Hypothetical / past-tense seatbelt, shared with the group gate.
  if (looksLikeHypotheticalOrPast(raw)) return null;

  const t = normalise(raw);
  if (!t) return null;

  // OUT first: several OUT forms embed the word "in" ("not in"), and the
  // whole-message anchoring means the two can never both match anyway.
  if (OUT_RE.test(t)) return "out";
  if (IN_RE.test(t)) return "in";
  return null;
}

export interface DmSelfAttendanceFallbackInput {
  /** The raw DM body. */
  text: string;
  /**
   * Does a MORE SPECIFIC pending prompt own this DM (an open tentative
   * follow-up, bench offer, collector-fee request or roster survey)? Those
   * paths run first in the route and must keep winning: they know which
   * match / question the answer belongs to, and this fallback does not.
   */
  hasPendingPrompt: boolean;
}

/**
 * The SYNCHRONOUS half of the fallback decision: a pending prompt beats
 * this fallback every time, and otherwise the free fast-path gets first
 * refusal. `null` here does NOT mean "not attendance" — it means "the
 * fast-path could not tell", which is the LLM's cue (see
 * `resolveDmSelfAttendance`).
 */
export function decideDmSelfAttendanceFallback(
  input: DmSelfAttendanceFallbackInput,
): DmSelfAttendance | null {
  if (input.hasPendingPrompt) return null;
  return classifyDmSelfAttendance(input.text);
}

export interface DmSelfAttendanceResolution {
  /** What to write, or null to leave the DM to the existing handling. */
  decision: DmSelfAttendance | null;
  /** Which layer decided. Surfaced in the API response for observability. */
  via: "fast-path" | "llm" | "pending-prompt" | "none";
  confidence?: number;
  reasoning?: string;
}

export interface ResolveDmSelfAttendanceInput extends DmSelfAttendanceFallbackInput {
  /** Context handed to the model (club, player, kick-off, was-asked). */
  context?: MatchAvailabilityContext;
}

/**
 * The full decision: pending prompt → regex fast-path → LLM.
 *
 * The LLM is only consulted when the caller has already established there
 * IS something to register against (an active match on an attendance-
 * tracking org), so an idle group never burns tokens on banter.
 */
export async function resolveDmSelfAttendance(
  input: ResolveDmSelfAttendanceInput,
): Promise<DmSelfAttendanceResolution> {
  if (input.hasPendingPrompt) return { decision: null, via: "pending-prompt" };

  const fast = classifyDmSelfAttendance(input.text);
  if (fast) return { decision: fast, via: "fast-path", confidence: 1 };

  const raw = (input.text ?? "").trim();
  if (!raw) return { decision: null, via: "none" };
  // Hard seatbelt, shared with the group gate: a hypothetical or past-tense
  // statement is NEVER an attendance write, whatever the model thinks.
  if (looksLikeHypotheticalOrPast(raw)) {
    return { decision: null, via: "none", reasoning: "hypothetical-or-past" };
  }

  const verdict = await classifyMatchAvailability(raw, input.context ?? {});
  if (verdict.decision === "unclear") {
    return {
      decision: null,
      via: "llm",
      confidence: verdict.confidence,
      reasoning: verdict.reasoning,
    };
  }
  return {
    decision: verdict.decision,
    via: "llm",
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
  };
}
