/**
 * HOW FAR AWAY THE MATCH IS, IN WORDS. Pure: no database, no model.
 *
 * MOVED from `message-analyzer.ts` on 2026-10-20 with the chase rewrite,
 * unchanged except that the clock is now a parameter (`now`, defaulting
 * to the wall clock): the scheduler composes against ITS clock, which the
 * e2e suite pins with `x-test-now`. `message-analyzer.ts` re-exports
 * `enforceProximity`, so every existing import keeps working.
 */
import { t } from "./i18n/t";
import { normaliseLang, type Lang } from "./i18n/lang";
import { dayLabel as i18nDayLabel } from "./i18n/dates";

/**
 * The kickoff DAY in London, "Tue 8 Sept". No time, ever.
 *
 * This used to be `kickoffLocal.split(" at ")[0]` over a single
 * date-AND-time formatter, and that split never fired: en-GB renders
 * weekday+day+month+hour+minute as "Tue 8 Sept, 21:30", the caller
 * stripped the comma, and the ` at ` the split looked for had never
 * existed. `[0]` was therefore the whole string, so every "day label"
 * silently carried the kickoff time, which is how a chase came to read
 * "see you all on Tue 8 Sept 21:30 at 21:30". Formatting the two halves
 * separately is the only way this cannot come back.
 */
export function londonDayLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

/** The kickoff wall-clock in London, "21:30". */
export function londonTimeLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** YYYY-MM-DD key in London time. Used for calendar-day proximity. */
export function londonDateKey(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at); // en-CA formats as YYYY-MM-DD
}

export type Proximity = "past" | "tonight" | "tomorrow" | "this-week" | "future";

export function computeProximity(
  date: Date,
  lang: Lang = "en",
  now: Date = new Date(),
): {
  proximity: Proximity;
  rosterHeader: string;
  friendlyDay: string; // "tonight" | "tomorrow" | "on Tue 28 Apr"
  /** The same day with no leading preposition, "Tue 28 Apr". What goes
   *  in after a preposition the sentence already has, or before a
   *  possessive. See `replaceRelativeDay`. */
  dayLabel: string;
  /** Calendar days from today to the match day, in London. */
  daysOut: number;
} {
  const s = t(lang);
  const hoursToKickoff = (date.getTime() - now.getTime()) / (1000 * 60 * 60);
  const dayPart = lang === "en" ? londonDayLabel(date) : i18nDayLabel(lang, date);

  // Proximity bucket is calendar-day based, not raw hours: "tonight"
  // means the match is later today (London), "tomorrow" means
  // calendar-tomorrow, etc. Hours-only thresholds got it wrong at
  // 14:26 BST on match day (>6h to 21:30, bucketed as "tomorrow"
  // even though the match was that same evening).
  const todayKey = londonDateKey(now);
  const matchDayKey = londonDateKey(date);
  const daysOut = Math.round((Date.parse(matchDayKey) - Date.parse(todayKey)) / 86_400_000);
  let proximity: Proximity;
  if (hoursToKickoff < 0) proximity = "past";
  else if (daysOut === 0) proximity = "tonight";
  else if (daysOut === 1) proximity = "tomorrow";
  else if (daysOut <= 7) proximity = "this-week";
  else proximity = "future";
  const rosterHeader = {
    past: s.roster_header_past,
    tonight: s.roster_header_tonight,
    tomorrow: s.roster_header_tomorrow,
    "this-week": s.roster_header_day({ dayLabel: dayPart }),
    future: s.roster_header_day({ dayLabel: dayPart }),
  }[proximity];
  const friendlyDay = {
    past: `on ${dayPart}`,
    tonight: "tonight",
    tomorrow: "tomorrow",
    "this-week": `on ${dayPart}`,
    future: `on ${dayPart}`,
  }[proximity];
  return { proximity, rosterHeader, friendlyDay, dayLabel: dayPart, daysOut };
}

/** Prepositions that already supply the "on" in "on Tue 8 Sept". */
const DAY_PREPOSITION = "on|for|at|by|before|after|until|till|from";

/**
 * Swap a relative day word ("tonight", "tomorrow", "this evening") for
 * the real day, WITHOUT breaking the sentence it sits in.
 *
 * The naive `text.replace(/\btonight\b/g, "on Tue 8 Sept")` this
 * replaces produced, in production copy, "we still need 8 players for on
 * Tue 8 Sept's 7-a-side". Two grammatical facts have to be respected:
 *
 *   • a preposition already in the sentence supplies the "on"
 *     ("for tonight" becomes "for Tue 8 Sept", never "for on Tue 8 Sept");
 *   • a possessive attaches to the day, not to a preposition
 *     ("tonight's game" becomes "Tue 8 Sept's game").
 *
 * With neither, the day needs its own preposition: "kickoff is tonight"
 * becomes "kickoff is on Tue 8 Sept".
 */
function replaceRelativeDay(text: string, word: string, dayLabel: string, friendlyDay: string): string {
  const re = new RegExp(`(\\b(?:${DAY_PREPOSITION})\\s+)?\\b${word}\\b(['’]s)?`, "gi");
  return text.replace(re, (_m, prep?: string, possessive?: string) => {
    if (possessive) return `${prep ?? ""}${dayLabel}${possessive}`;
    if (prep) return `${prep}${dayLabel}`;
    return friendlyDay;
  });
}

/**
 * Post-process a model-written message so it never says "tonight" when
 * the match is days away (or vice versa).
 *
 *   - Replaces any "*Playing <word>:*" header with the correct one.
 *   - Rewrites loose "tonight"/"this evening" to the friendly day form
 *     when proximity isn't tonight. Leaves "tomorrow" alone unless
 *     proximity is further out.
 *
 * Applied to EVERY outgoing reply in `analyze/route.ts`, whatever
 * composed it, and to the chase's lead.
 */
export function enforceProximity(
  text: string,
  matchDate: Date,
  lang?: Lang | string | null,
  now: Date = new Date(),
): string {
  const l = normaliseLang(lang);
  const { proximity, rosterHeader, friendlyDay, dayLabel } = computeProximity(matchDate, l, now);

  // Swap any "*Playing …:*" roster header to the correct one. In any
  // language: a Turkish model that writes the English header out of
  // habit gets the Turkish one the server chose, and a Turkish header
  // with the wrong day is corrected the same way.
  let out = text.replace(/\*(?:Playing [^*\n]+?|[^*\n]*?oynayanlar|Kadro):\*/giu, rosterHeader);
  // If that didn't match, also try a variant without asterisks.
  if (!out.includes(rosterHeader)) {
    out = out.replace(/Playing (tonight|tomorrow|this (?:evening|week))\s*:/i, rosterHeader);
  }

  // THE RELATIVE-DAY REWRITE IS ENGLISH GRAMMAR (`DAY_PREPOSITION`,
  // possessives) and cannot be translated, only bypassed: for any other
  // language the model is told the day up front and nothing below
  // rewrites its prose.
  if (l !== "en") return fixUtcTime(out, matchDate);

  if (proximity !== "tonight") {
    out = replaceRelativeDay(out, "tonight", dayLabel, friendlyDay);
    out = replaceRelativeDay(out, "this evening", dayLabel, friendlyDay);
  }
  if (proximity !== "tomorrow" && proximity !== "tonight") {
    out = replaceRelativeDay(out, "tomorrow", dayLabel, friendlyDay);
  }

  return fixUtcTime(out, matchDate);
}

/**
 * Catch "off-by-1h" mistakes in HH:MM times. The model occasionally
 * outputs the UTC time (20:30) when it should output the London
 * wall-clock (21:30). Replace the UTC HH:MM with the London one.
 * Language-free: a time is a time.
 */
function fixUtcTime(text: string, matchDate: Date): string {
  const londonHm = londonTimeLabel(matchDate);
  const utcHm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(matchDate);
  if (londonHm === utcHm) return text;
  return text.replace(new RegExp(`\\b${utcHm}\\b`, "g"), londonHm);
}
