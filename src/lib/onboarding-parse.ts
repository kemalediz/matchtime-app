/**
 * Pure parsing logic for the autonomous onboarding flow (Phase 1,
 * 2026-06-12 design — MDs/autonomous-onboarding-design-2026-06-12.md).
 *
 * NO imports of db / Anthropic / Next — everything in here is a pure
 * function over strings, so it's unit-testable without a database and
 * usable from both the conversation state machine and the test suites.
 *
 * Codebase principle: "LLM for understanding, deterministic code for
 * control". These functions ARE the deterministic control layer — the
 * LLM only ever backfills what they miss.
 */
import { FEATURE_META, type ToggleableKey } from "./org-features-meta";

// ─────────────────────────── feature bundles ───────────────────────────

/** The "YES" bundle — the recommended setup the intro message offers.
 *  Everything except payment tracking (the most common carve-out).
 *  statsQa is excluded from the LIST because completion flips it on
 *  unconditionally anyway (Kemal 2026-05-29: always on). */
export const RECOMMENDED_BUNDLE: ToggleableKey[] = [
  "attendance",
  "bench",
  "teamBalancing",
  "momVoting",
  "playerRating",
  "reminders",
];

/** The "EVERYTHING" bundle — recommended + payment tracking + statsQa.
 *  `paymentCollection` (Stripe) is deliberately NEVER chat-set: it
 *  requires a connected bank, which the dashboard owns. */
export const EVERYTHING_BUNDLE: ToggleableKey[] = [
  ...RECOMMENDED_BUNDLE,
  "statsQa",
  "paymentTracking",
];

export interface BundleChoice {
  choice: "yes" | "everything" | "custom";
  features: ToggleableKey[];
}

/** Standalone-affirmative matcher. Deliberately strict (short message,
 *  nothing but the affirmative + punctuation/emoji) so a "yes" buried in
 *  normal chat ("yes mate what a game") can never trigger setup. */
const YES_RE =
  /^(yes|yes please|yes pls|yess+|yeah|yep|yup|go for it|let'?s do it|let'?s go|sounds good|count us in|sign us up|yes go)$/i;

/** Feature keywords → canonical keys. Mirrors the legacy feature-menu
 *  regex in regexExtract, minus numbered picks (the group-add intro has
 *  no numbered menu, and bare digits in chat are noise). */
function pickFeatureKeywords(t: string): ToggleableKey[] {
  const picked = new Set<ToggleableKey>();
  if (/\b(mom|man of the match|motm)\b/.test(t)) picked.add("momVoting");
  if (/\b(rating|ratings|rate)\b/.test(t)) picked.add("playerRating");
  if (/\b(attendance|in\/out|squad list|squad)\b/.test(t)) picked.add("attendance");
  if (/\bbench\b/.test(t)) picked.add("bench");
  if (/\b(fair teams?|balanc|team generation|teams)\b/.test(t)) picked.add("teamBalancing");
  if (/\b(reminders?|remind)\b/.test(t)) picked.add("reminders");
  if (/\b(stats|history|leaderboard)\b/.test(t)) picked.add("statsQa");
  if (/\bpay(ment)?s?( tracking)?\b/.test(t)) picked.add("paymentTracking");
  return [...picked];
}

/**
 * Parse a consent/bundle reply at the `introduced` stage.
 *
 * Returns null when the message is NOT a setup answer (ordinary group
 * chat) — the bot stays silent, per the falls-open principle.
 *
 *  - "YES" (standalone)            → recommended bundle
 *  - "EVERYTHING" / "the lot"      → everything incl. payment tracking
 *  - "everything except payments"  → everything minus paymentTracking
 *  - named subset ("just MoM and ratings") → those features. Guarded:
 *    needs an explicit selection cue OR ≥2 distinct feature keywords,
 *    so incidental words ("nice teams lads") can't start setup.
 */
export function parseBundleReply(raw: string): BundleChoice | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t) return null;

  // Strip trailing punctuation/emoji for the standalone-YES check.
  const bare = t
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[!.,…\s]+$/g, "")
    .trim();
  if (bare.length <= 30 && YES_RE.test(bare)) {
    return { choice: "yes", features: [...RECOMMENDED_BUNDLE] };
  }

  // EVERYTHING (kept reasonably short so "we talked about everything
  // last night" in a long chat message can't trigger).
  if (t.length <= 120 && /\b(everything|the lot|all of (?:it|them)|all features)\b/.test(t)) {
    let features = [...EVERYTHING_BUNDLE];
    if (/\b(except|but not|apart from|without|minus|no)\b[^.]*\bpay/.test(t)) {
      features = features.filter((k) => k !== "paymentTracking");
    }
    return { choice: "everything", features };
  }

  // Named subset.
  const picks = pickFeatureKeywords(t);
  if (picks.length === 0) return null;
  const cue =
    /\b(just|only|want|we'?d like|give us|enable|turn on|switch on|set ?up|start with|go with|please)\b/.test(t);
  if ((cue || picks.length >= 2) && t.length <= 200) {
    return { choice: "custom", features: picks };
  }
  return null;
}

// ───────────────────── when & where extraction ─────────────────────────

export const DAY_WORDS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

export interface WhenWhere {
  dayOfWeek: number | null;
  kickoffTime: string | null; // "HH:MM" 24h London wall clock
  venue: string | null;       // FREE TEXT — no geocoding in Phase 1
  playersPerSide: number | null;
  recurrence: "weekly" | "oneoff" | null;
  oneOffDate: string | null;  // "YYYY-MM-DD"
}

/** Day-of-week from free text ("tuesdays" → 2). */
export function extractDayOfWeek(text: string): number | null {
  const t = text.toLowerCase();
  for (const [w, d] of Object.entries(DAY_WORDS)) {
    if (new RegExp(`\\b${w}s?\\b`).test(t)) return d;
  }
  return null;
}

/** Kickoff time from free text ("9pm" → "21:00", "20.30" → "20:30"). */
export function extractKickoffTime(text: string): string | null {
  const t = text.toLowerCase();
  const tm =
    t.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/) ||
    t.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (!tm) return null;
  let h = parseInt(tm[1], 10);
  const min = tm[2] && /^\d{2}$/.test(tm[2]) ? tm[2] : "00";
  const mer = (tm[3] || tm[2] || "").toString();
  if (/pm/.test(mer) && h < 12) h += 12;
  if (/am/.test(mer) && h === 12) h = 0;
  if (h < 0 || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${min}`;
}

/** Players-per-side ("7-a-side", "5s") — 4..16 or null. */
export function extractPlayersPerSide(text: string): number | null {
  const t = text.toLowerCase();
  const ps =
    t.match(/(\d{1,2})\s*[-\s]?\s*a[-\s]?side/) ||
    t.match(/\b(\d{1,2})\s*aside\b/) ||
    t.match(/\b(4|5|6|7|8|9|10|11)s\b/);
  if (!ps) return null;
  const n = parseInt(ps[1], 10);
  return n >= 4 && n <= 16 ? n : null;
}

/**
 * Venue from free text — the "at <venue>" / "@ <venue>" tail of a
 * combined answer like "Tuesdays 9pm at Goals Wembley, 7-a-side".
 *
 * FREE TEXT ONLY in Phase 1 — stored raw, geocoding slots in later.
 * Takes the LAST "at" clause (so "at 9 at Goals" lands on "Goals"),
 * skips captures that are just a time, and strips a trailing format
 * fragment ("…, 7-a-side").
 */
export function extractVenueFreeText(raw: string): string | null {
  // Collect the start offsets of every "at "/"@ " token (a single
  // matchAll over a capture would consume "9 at Goals" in one greedy
  // match and hide the later, real venue clause).
  const re = /(?:\bat|@)\s+/gi;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) starts.push(m.index + m[0].length);
  for (let i = starts.length - 1; i >= 0; i--) {
    let v = (raw.slice(starts[i]).match(/^([^,.;\n]{2,80})/)?.[1] ?? "").trim();
    // Drop a trailing "N-a-side" fragment that slipped into the capture.
    v = v.replace(/\s*\d{1,2}\s*-?\s*a-?\s*side.*$/i, "").trim();
    // Skip pure time/number captures ("at 9pm", "at 8").
    if (/^\d{1,2}([:.]\d{2})?\s*(am|pm)?$/i.test(v)) continue;
    if (v.length >= 2) return v.slice(0, 120);
  }
  return null;
}

/** Recurrence; the group-add flow DEFAULTS to weekly when unstated. */
export function extractRecurrence(text: string): "weekly" | "oneoff" | null {
  const t = text.toLowerCase();
  if (/\b(one[-\s]?off|just this once|one time|single (?:game|match)|this week only)\b/.test(t))
    return "oneoff";
  if (/\b(weekly|every week|each week|recurring|every (?:mon|tue|wed|thu|fri|sat|sun))/.test(t))
    return "weekly";
  return null;
}

/** ISO one-off date if present. */
export function extractOneOffDate(text: string): string | null {
  const dm = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  return dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
}

/**
 * The combined "when & where do you play?" extractor — one message may
 * carry day + time + venue + format + recurrence all at once (the
 * existing multifield extraction already proved this pattern works).
 */
export function extractWhenWhere(raw: string): WhenWhere {
  return {
    dayOfWeek: extractDayOfWeek(raw),
    kickoffTime: extractKickoffTime(raw),
    venue: extractVenueFreeText(raw),
    playersPerSide: extractPlayersPerSide(raw),
    recurrence: extractRecurrence(raw),
    oneOffDate: extractOneOffDate(raw),
  };
}

// ───────────────── legacy batch extractor (moved here) ─────────────────

export interface Extracted {
  groupName: string | null;
  venue: string | null;
  dayOfWeek: number | null;
  kickoffTime: string | null;
  playersPerSide: number | null;
  recurrence: string | null;
  oneOffDate: string | null;
  featureSelection: string[] | null;
  confidence: number;
}

/** Deterministic, LLM-free extractor (moved from onboarding-conversation
 *  so it's unit-testable; behaviour unchanged). Event answers are
 *  formulaic; this keeps onboarding progressing if Anthropic is
 *  unavailable and backfills LLM misses on terse replies. Venue is
 *  intentionally not guessed here — the collecting branch's "sole
 *  missing field" heuristic handles a bare "PowerLeague Shoreditch"
 *  answer (the details stage additionally runs extractVenueFreeText). */
export function regexExtract(messages: Array<{ body: string }>): Extracted {
  const text = messages.map((m) => m.body).join("  ").toLowerCase();
  const empty: Extracted = {
    groupName: null, venue: null, dayOfWeek: null, kickoffTime: null,
    playersPerSide: null, recurrence: null, oneOffDate: null,
    featureSelection: null, confidence: 0,
  };

  const playersPerSide = extractPlayersPerSide(text);
  const dayOfWeek = extractDayOfWeek(text);
  const kickoffTime = extractKickoffTime(text);
  const recurrence = extractRecurrence(text);
  const oneOffDate = extractOneOffDate(text);

  // feature selection (only meaningful at the features stage; caller
  // decides when to use it). Numbers map to FEATURE_META order.
  let featureSelection: string[] | null = null;
  if (/\b(everything|all of (?:it|them)|all features|the lot|all)\b/.test(text)) {
    featureSelection = FEATURE_META.map((f) => f.key);
    if (/\b(except|but not|apart from|without)\b[^.]*\bpay/.test(text))
      featureSelection = featureSelection.filter((k) => k !== "paymentTracking");
  } else {
    const picked = new Set<string>();
    if (/\b(mom|man of the match|motm)\b/.test(text)) picked.add("momVoting");
    if (/\b(rating|ratings|rate)\b/.test(text)) picked.add("playerRating");
    if (/\b(attendance|in\/out|squad)\b/.test(text)) picked.add("attendance");
    if (/\bbench\b/.test(text)) picked.add("bench");
    if (/\b(teams?|balanc)/.test(text)) picked.add("teamBalancing");
    if (/\b(reminder|remind)\b/.test(text)) picked.add("reminders");
    if (/\b(stats|history|leaderboard)\b/.test(text)) picked.add("statsQa");
    if (/\bpay(ment)?s?\b/.test(text)) picked.add("paymentTracking");
    // numbered picks: "4 and 5", "options 1, 4", "1 & 4"
    const nums = text.match(/\b([1-8])\b/g);
    if (nums) for (const n of nums) {
      const meta = FEATURE_META[parseInt(n, 10) - 1];
      if (meta) picked.add(meta.key);
    }
    if (picked.size > 0) featureSelection = [...picked];
  }

  const gotAny =
    playersPerSide != null || dayOfWeek != null || kickoffTime != null ||
    recurrence != null || oneOffDate != null ||
    (featureSelection != null && featureSelection.length > 0);

  return {
    ...empty,
    playersPerSide,
    dayOfWeek,
    kickoffTime,
    recurrence,
    oneOffDate,
    featureSelection,
    confidence: gotAny ? 0.7 : 0,
  };
}

// ───────────────────── details-stage state machine ─────────────────────

export type DetailsField = "day" | "time" | "venue";

/** Which of the three UNKNOWABLE fields (only day, time, venue are
 *  mandatory — everything else has a sensible default) are still
 *  missing. Empty array ⇒ the details stage is complete. */
export function detailsStillMissing(s: {
  dayOfWeek: number | null;
  kickoffTime: string | null;
  venue: string | null;
}): DetailsField[] {
  const missing: DetailsField[] = [];
  if (s.dayOfWeek == null) missing.push("day");
  if (!s.kickoffTime) missing.push("time");
  if (!s.venue) missing.push("venue");
  return missing;
}

/** Static follow-up copy for whatever is still missing after a
 *  details-stage turn (deterministic — never depends on the LLM). */
export function detailsFollowUpQuestion(missing: DetailsField[]): string {
  if (missing.length === 3) {
    return (
      "One thing I need: *when and where do you play?* One message is fine, " +
      "like: _\"Thursdays 9pm at PowerLeague Shoreditch, 7-a-side\"_."
    );
  }
  const parts: string[] = [];
  if (missing.includes("day")) parts.push("which *day of the week* you play");
  if (missing.includes("time")) parts.push("the *kickoff time* (e.g. 9pm)");
  if (missing.includes("venue")) parts.push("the *venue* name");
  return `Almost there — I just need ${parts.join(" and ")}.`;
}

// ───────────────────────── env-flag gate ────────────────────────────────

/**
 * Safety gate for the bot-added auto-onboarding entry point. OFF unless
 * the env var is explicitly "1"/"true"/"on" — so nothing can fire on a
 * live deployment until the flag is deliberately flipped.
 */
export function isOnboardingAutostartEnabled(
  value: string | undefined = process.env.ONBOARDING_AUTOSTART,
): boolean {
  return /^(1|true|on|yes)$/i.test((value ?? "").trim());
}
