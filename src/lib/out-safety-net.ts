/**
 * OUT safety net — reasoning signals.
 *
 * Extracted from the analyze route so it can be unit-tested against the
 * REAL `AnalyzedMessage.reasoning` strings production has emitted, rather
 * than against strings invented to match the regex.
 *
 * Context. When the LLM classifies a message as
 * `intent:"replacement_request"` from sender X but does NOT set
 * `registerAttendance:"OUT"`, the server may force the OUT itself. That
 * decision is made purely from the model's own free-text reasoning:
 *
 *   forceOut = strongDrop && !notDropping
 *
 *   strongDrop  — the reasoning says the SENDER is definitely leaving.
 *   notDropping — the reasoning shows a deliberate "I left this null"
 *                 signal (type-b cover request, tentative, running late,
 *                 group-level chase). Vetoes the override.
 *
 * Prose-matching an LLM's reasoning is a seatbelt, not a mechanism —
 * `MDs/analyzer-redesign-2026-08-31.md` step 6 deletes this whole class
 * of guard. Until then the bar is: fire on the incidents it was written
 * for, and never on a cover request.
 *
 * Over-firing is the dangerous direction: wrongly dropping a player who
 * was only asking for cover is worse than missing a drop. Every widening
 * of `strongDrop` here is pinned by a must-NOT-fire case below it in
 * `__tests__/out-safety-net.test.ts`.
 */

/**
 * Lowercase and fold typographic apostrophes to ASCII.
 *
 * The model emits "can’t" (U+2019) at least as often as "can't", and
 * every `can'?t` style pattern here is ASCII-only. Folding once at the
 * top means no individual pattern has to care.
 */
function normalise(reasoning: string | null | undefined): string {
  return (reasoning ?? "").toLowerCase().replace(/[‘’ʼ`´]/g, "'");
}

/**
 * "I deliberately left registerAttendance null" signals. Any hit vetoes
 * the override.
 *
 * Deliberately generous: a false positive here costs a missed drop that
 * a human corrects in chat; a false negative costs a player wrongly
 * removed from the squad.
 */
const NOT_DROPPING: RegExp[] = [
  // "still in", "will still be playing", "still going to play", "may
  // still come". `still` alone already matches every "may/might still"
  // form, so those need no alternative of their own.
  /\bstill\s+(?:be\s+)?(?:in\b|play|attend|com|going)/,
  // Late, not absent. "be late" subsumes "will be late" / "might be late".
  /\b(?:running|arriving|just|be)\s+late\b/,
  // The model narrating its own null. All four phrasings below are
  // attested in production: "stays null", "no registerAttendance",
  // "registerAttendance: null", "registerAttendance is null".
  /\b(?:stays?|staying|remains?|is|are|kept|left)\s+null\b/,
  /\bregister\w*\s*[:=]\s*null\b/,
  /\bregister\w*\s+(?:stays?\s+)?null\b/,
  /\bno\s+register\w*\b/,
  // The cover-request / group-chase flavour.
  /\b(?:tentative|group[-\s]level|not\s+a\s+personal\s+drop)\b/,
  /\b(?:just|only|merely)\s+(?:chasing|asking|nudging|a\s+nudge)\b/,
  /\badmin\s+(?:chase|nudge|nudging)\b/,
  // The prompt's own taxonomy for a cover request. The model says both
  // "type (b)" and "flavour (b)".
  /\b(?:type|flavou?r)[\s-]*\(?b\)?\b/,
  // Explicit negation of a strong-drop phrase — "not a definite drop",
  // "he's not definitely out", "they haven't confirmed OUT yet". Without
  // these the negated phrase reads as the assertion to `strongDrop`.
  /\bnot\s+(?:yet\s+)?(?:a\s+)?(?:definite|definitely|definitive|definitively|confirmed)\b/,
  /\b(?:have|has|had)n'?t\s+confirmed\b/,
];

/**
 * "The sender themselves is definitely leaving" signals.
 *
 * Every alternative is pinned against a real production reasoning string
 * in the test file. Plurals and gerunds matter: the incident this guard
 * was written for (Mojib, 2026-05-26) reasoned "Both are definite
 * drops" — a `drop\b` pattern never saw it.
 */
const STRONG_DROP: RegExp[] = [
  // "definite drop", "definite drops", "definitely dropping",
  // "definitely out". The plural is the 2026-05-26 incident.
  /\b(?:definite|definitely)\s+(?:drops?|dropping|out)\b/,
  // "can't make it", "won't be able to make it", "unable to attend".
  /\b(?:cannot|can'?t|won'?t|will\s+not|unable\s+to|not\s+able\s+to)\s+(?:be\s+able\s+to\s+)?(?:make|play|attend|come|be\s+there|join)/,
  // "is dropping out", "are dropping", "is definitely out". `are` is the
  // plural form of the same sentence the incident produced.
  /\b(?:is|are|am)\s+(?:now\s+|definitely\s+|clearly\s+)?(?:dropping|out)\b/,
  // Explicit "the sender ..." phrasing. Never once observed in
  // production reasoning (the model uses the player's name), kept only
  // because removing it would be a behaviour change with no test behind
  // the removal.
  /\bsender\s+(?:is|are)?\s*(?:dropping|out|gone|leaving|sick|injured|ill|can'?t\s+make)/,
];

export interface OutSafetyNetSignals {
  strongDrop: boolean;
  notDropping: boolean;
  /** `strongDrop && !notDropping` — the route forces OUT on this. */
  forceOut: boolean;
}

/** Both signals plus the combined verdict, for diagnosis and tests. */
export function outSafetyNetSignals(
  reasoning: string | null | undefined,
): OutSafetyNetSignals {
  const r = normalise(reasoning);
  const notDropping = NOT_DROPPING.some((re) => re.test(r));
  const strongDrop = STRONG_DROP.some((re) => re.test(r));
  return { strongDrop, notDropping, forceOut: strongDrop && !notDropping };
}

/**
 * Should the server force `registerAttendance:"OUT"` for the sender of a
 * `replacement_request` the LLM left un-dropped?
 */
export function shouldForceSenderOut(
  reasoning: string | null | undefined,
): boolean {
  return outSafetyNetSignals(reasoning).forceOut;
}
