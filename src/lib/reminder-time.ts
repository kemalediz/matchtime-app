/**
 * §3.2 S22 — "reminder_request incl. **calendar arithmetic**".
 *
 *   category B, 858 measured tokens.
 *   where it goes: *"extractor returns the phrase; `date-fns-tz`
 *   resolves it"*.
 *
 * This is that resolver, and it is the last piece the `admin_ops` route
 * was waiting on (`answer-batch.ts`'s header: *"a reminder whose time
 * phrase still has to become a datetime … nothing resolves it yet"*).
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE MODEL MUST NOT DO THIS
 * ─────────────────────────────────────────────────────────────────────
 * The shipped path asks the mega-prompt for a resolved `{date, time}`
 * pair (`route.ts:3928-3935`) and then defends itself against the answer
 * with a 60-day window and a 60-second grace, staying silent when the
 * pair looks wrong. That defence exists because a language model doing
 * date arithmetic across a DST boundary, from a prompt that does not
 * reliably know today's date, is a coin flip — and the failure is a DM
 * that arrives on the wrong day, which reads as the bot being broken.
 *
 * So: the model reports the WORDS. This turns the words into an instant,
 * deterministically, from an injected `now`. It is a pure function and
 * it has no clock of its own.
 *
 * ─────────────────────────────────────────────────────────────────────
 * A SMALL, STATED VOCABULARY — AND A REFUSAL FOR EVERYTHING ELSE
 * ─────────────────────────────────────────────────────────────────────
 * It understands relative days ("tomorrow", "tonight"), weekday names
 * ("on Monday", "next Tuesday"), durations ("in 2 hours", "in a week"),
 * parts of the day ("tomorrow morning") and clock times ("at 6", "at
 * 7pm"), in London wall-clock, DST-safe via `date-fns-tz`.
 *
 * It refuses everything else, and the refusal is the safety argument
 * rather than a limitation being apologised for: a phrase this cannot
 * resolve is handed back to the analyzer, which still has the
 * mega-prompt and still resolves it exactly as it does today. The cost
 * of a refusal is one analyzer call. The cost of a guess is a DM on the
 * wrong day. There is no version of this module that should prefer the
 * second, so when it is unsure it says so.
 *
 * IT NEVER RETURNS AN INSTANT IN THE PAST. Every branch that could —
 * a weekday that is today, a clock time that has already gone — rolls
 * forward instead, because the engine's window check would drop a past
 * instant and the player's request would vanish silently. Silence is the
 * failure §9 calls this product's signature; rolling forward is what a
 * person means anyway.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { dayLabel, dayTimeLabel } from "./i18n/dates";
import { normaliseLang, type Lang } from "./i18n/lang";

const LONDON = "Europe/London";

/** Shipped default when a phrase names a day but no time
 *  (`route.ts:3936`: `verdict.reminder.time ?? "09:00"`). */
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;

/**
 * The outer bound on a duration phrase, in days.
 *
 * The engine applies the real 60-day window (`route.ts:3941-3947`);
 * this is a cheaper, blunter check that stops "in 400 days" being parsed
 * into a date at all. Two guards rather than one because they fail
 * differently: this one says "that is not a reminder", the engine's says
 * "that is outside the window I will queue".
 */
const MAX_DURATION_DAYS = 90;

export type ReminderResolution =
  | {
      ok: true;
      /** The instant to queue, in UTC. */
      at: Date;
      /** Did the phrase name a TIME OF DAY, or only a day? Drives the
       *  label, exactly as `route.ts:3986-3989` does. */
      statedTime: boolean;
      /** "Mon 7 Sep at 18:00" / "Mon 7 Sep". London. */
      whenLabel: string;
    }
  | { ok: false; reason: string };

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/** Parts of the day, and the hour each one means. Deliberately a closed
 *  list: "later", "soon" and "in a bit" are NOT times and must not be
 *  coerced into one. */
const PARTS_OF_DAY: Record<string, number> = {
  morning: 9,
  afternoon: 14,
  evening: 18,
  night: 20,
  tonight: 20,
};

/** London calendar parts of an instant. */
function londonParts(d: Date): { y: number; m: number; day: number; weekday: number } {
  const y = Number(formatInTimeZone(d, LONDON, "yyyy"));
  const m = Number(formatInTimeZone(d, LONDON, "MM"));
  const day = Number(formatInTimeZone(d, LONDON, "dd"));
  const weekday = Number(formatInTimeZone(d, LONDON, "i")) % 7; // ISO 1..7 (Mon..Sun) → 1..6,0
  return { y, m, day, weekday };
}

/** A London wall clock on the calendar day `offsetDays` after `now`. */
function londonAt(now: Date, offsetDays: number, hour: number, minute: number): Date {
  // Add the offset in CALENDAR days by walking the London date, not by
  // adding 86,400,000ms: the day a clock change falls on is 23 or 25
  // hours long, and "tomorrow at 9" means tomorrow at 9 on both of them.
  const { y, m, day } = londonParts(now);
  const anchor = new Date(Date.UTC(y, m - 1, day + offsetDays, 12, 0, 0));
  const ay = anchor.getUTCFullYear();
  const am = anchor.getUTCMonth() + 1;
  const ad = anchor.getUTCDate();
  const iso =
    `${ay}-${String(am).padStart(2, "0")}-${String(ad).padStart(2, "0")}` +
    `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  return fromZonedTime(iso, LONDON);
}

/** What may follow a Turkish weekday: "cuma günü", "cumaya", "salıdan",
 *  "cumartesileri". A closed list, so a name such as "Salih" is not a day. */
const DAY_SUFFIX = String.raw`(?:\s*g[üu]n[üu])?(?:ya|ye|a|e|y[ıi]|dan|den|lar[ıi]|leri|ki)?`;

function englishLabel(at: Date, statedTime: boolean): string {
  return formatInTimeZone(at, LONDON, statedTime ? "EEE d MMM 'at' HH:mm" : "EEE d MMM");
}

/**
 * TURKISH PHRASES (Phase 3, 2026-09-17). A Turkish org's player asks
 * "@Match Time yarın akşam hatırlat" and the extractor hands back the
 * phrase in Turkish. Rather than a second resolver, the Turkish words are
 * REWRITTEN to the English vocabulary above, and the one resolver below
 * does the arithmetic. The vocabulary is the same small, stated set, so
 * the refusal rule is unchanged: "sonra" (later) and "birazdan" (soon)
 * name no time and are refused, never guessed. Run only for a Turkish
 * org; an English phrase never passes through it.
 */
const TR_REWRITES: Array<[RegExp, string]> = (
  [
    // durations first: "2 saat sonra", "bir hafta sonra"
    [String.raw`(\d{1,3}|bir)\s+(dakika|dk|saat|g[üu]n|hafta)\s+sonra`, "__DURATION__"],
    [String.raw`[öo]b[üu]r\s+g[üu]n|yar[ıi]ndan\s+sonra`, "day after tomorrow"],
    [String.raw`bu\s+ak[şs]am`, "this evening"],
    [String.raw`bu\s+sabah`, "this morning"],
    [String.raw`bu\s+[öo][ğg]leden\s+sonra`, "this afternoon"],
    [String.raw`bu\s+gece`, "tonight"],
    [String.raw`yar[ıi]n`, "tomorrow"],
    [String.raw`bug[üu]n`, "today"],
    [String.raw`[öo][ğg]leden\s+sonra`, "afternoon"],
    [String.raw`ak[şs]am\p{L}*`, "evening"],
    [String.raw`sabah\p{L}*`, "morning"],
    [String.raw`gece`, "night"],
    [`pazartesi${DAY_SUFFIX}`, "monday"],
    [`sal[ıi]${DAY_SUFFIX}`, "tuesday"],
    [`[çc]ar[şs]amba${DAY_SUFFIX}`, "wednesday"],
    [`per[şs]embe${DAY_SUFFIX}`, "thursday"],
    [`cumartesi${DAY_SUFFIX}`, "saturday"],
    [`cuma${DAY_SUFFIX}`, "friday"],
    [`pazar${DAY_SUFFIX}`, "sunday"],
    [String.raw`saat`, "at"],
  ] as Array<[string, string]>
).map(([body, to]) => [new RegExp(`(?<!\\p{L})(?:${body})(?!\\p{L})`, "gu"), to]);

const TR_UNITS: Record<string, string> = { dakika: "minutes", dk: "minutes", saat: "hours", hafta: "weeks" };

function rewriteTurkish(phrase: string): string {
  // Lower-cased the Turkish way so "PERŞEMBE" and "İKİ" read right; any
  // dotless ı left once the Turkish words are rewritten came from an
  // English capital I ("FRIDAY"), so it goes back to i.
  let out = phrase.toLocaleLowerCase("tr");
  for (const [re, to] of TR_REWRITES) {
    out = out.replace(re, (...m: string[]) => {
      if (to !== "__DURATION__") return to;
      const n = m[1] === "bir" ? "a" : m[1];
      const unit = TR_UNITS[m[2]] ?? "days";
      return `in ${n} ${unit}`;
    });
  }
  return out.replace(/ı/g, "i");
}

interface ClockTime {
  hour: number;
  minute: number;
}

/**
 * A clock time inside the phrase: "at 6", "at 6:30", "7pm", "18:00".
 *
 * THE BARE-NUMBER RULE, and it is a judgement call made once, here,
 * rather than left to a model: a bare 1–7 with no am/pm is PM. Nobody in
 * a football group asks to be nudged at 6 in the morning, the shipped
 * prompt's own worked example is "tomorrow at 6" → 18:00, and getting
 * this wrong in the other direction wakes somebody up. 8–11 bare stay
 * as written (8 is a plausible morning), and anything ≥ 12 is already
 * unambiguous on a 24-hour clock.
 */
function parseClock(text: string): ClockTime | null {
  // An ORDINAL is a calendar day, never a clock time. "on the 12th"
  // names a date whose month is a guess, and reading it as 12:00 would
  // queue a DM for lunchtime today. Refuse the whole phrase instead.
  if (/\b\d{1,2}(?:st|nd|rd|th)\b/.test(text)) return null;
  const m = text.match(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (!m) return null;
  // A number that is part of a duration ("in 2 hours") is not a clock
  // time; the caller checks durations first, so reaching here means the
  // phrase is not one.
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const suffix = (m[3] ?? "").toLowerCase().replace(/\./g, "");
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
  if (suffix.startsWith("p")) {
    if (hour < 12) hour += 12;
  } else if (suffix.startsWith("a")) {
    if (hour === 12) hour = 0;
  } else if (hour >= 1 && hour <= 7) {
    hour += 12;
  }
  return { hour, minute };
}

export function resolveReminderPhrase(
  phrase: string,
  now: Date,
  /** The group's language (`state.features.language`): which words the
   *  phrase may use and which language the label is written in. */
  lang?: Lang | string | null,
): ReminderResolution {
  const raw = (phrase ?? "").trim();
  if (!raw) return { ok: false, reason: "empty time phrase" };
  const l = normaliseLang(lang);
  const t = (l === "tr" ? rewriteTurkish(raw) : raw.toLowerCase()).replace(/\s+/g, " ");
  const label = (at: Date, statedTime: boolean): string =>
    l === "en" ? englishLabel(at, statedTime) : statedTime ? dayTimeLabel(l, at) : dayLabel(l, at);

  // ── 1. Durations. "in 2 hours", "in a week". ───────────────────────
  //
  // First, because "in 2 hours" contains a number that `parseClock`
  // would otherwise read as 2pm.
  const dur = t.match(
    /\bin\s+(a|an|one|\d{1,3})\s*(min|mins|minute|minutes|hour|hours|hr|hrs|day|days|week|weeks)\b/,
  );
  if (dur) {
    const n = /^(a|an|one)$/.test(dur[1]) ? 1 : Number(dur[1]);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: `unreadable duration in "${raw}"` };
    const unit = dur[2];
    const ms = unit.startsWith("min")
      ? n * 60_000
      : unit.startsWith("h")
        ? n * 3_600_000
        : unit.startsWith("d")
          ? n * 86_400_000
          : n * 7 * 86_400_000;
    if (ms > MAX_DURATION_DAYS * 86_400_000) {
      return { ok: false, reason: `"${raw}" is further out than a group reminder ever means` };
    }
    const at = new Date(now.getTime() + ms);
    return { ok: true, at, statedTime: true, whenLabel: label(at, true) };
  }

  // A relative phrase with no unit is not a time. "in a bit", "in a
  // while", "later" — the model is allowed to hand these back and this
  // is where they stop.
  if (/\bin\s+(a\s+)?(bit|while|sec|second|moment)\b/.test(t)) {
    return { ok: false, reason: `"${raw}" names no resolvable time` };
  }

  const clock = parseClock(t);
  const part = Object.keys(PARTS_OF_DAY).find((p) => new RegExp(`\\b${p}\\b`).test(t));
  const hour = clock ? clock.hour : part ? PARTS_OF_DAY[part] : DEFAULT_HOUR;
  const minute = clock ? clock.minute : 0;
  const statedTime = !!clock || !!part;

  // ── 2. Relative days. ──────────────────────────────────────────────
  if (/\bday after tomorrow\b/.test(t)) {
    const at = londonAt(now, 2, hour, statedTime ? minute : DEFAULT_MINUTE);
    return { ok: true, at, statedTime, whenLabel: label(at, statedTime) };
  }
  if (/\btomorrow\b|\btmrw?\b|\btmr\b/.test(t)) {
    const at = londonAt(now, 1, hour, statedTime ? minute : DEFAULT_MINUTE);
    return { ok: true, at, statedTime, whenLabel: label(at, statedTime) };
  }
  if (/\btonight\b|\bthis (evening|afternoon|morning)\b|\btoday\b/.test(t)) {
    const at = londonAt(now, 0, hour, minute);
    if (at.getTime() <= now.getTime()) {
      // "this morning" said at 18:00 is not a reminder anybody can
      // receive. Refuse rather than silently move it to tomorrow: the
      // day was stated explicitly and moving it would contradict it.
      return { ok: false, reason: `"${raw}" resolves to a time that has already passed today` };
    }
    return { ok: true, at, statedTime, whenLabel: label(at, statedTime) };
  }

  // ── 3. Weekday names. "on Monday", "next Tuesday", "friday at 7". ──
  const weekdayKey = Object.keys(WEEKDAYS).find((k) => new RegExp(`\\b${k}\\b`).test(t));
  if (weekdayKey) {
    const target = WEEKDAYS[weekdayKey];
    const today = londonParts(now).weekday;
    // STRICTLY AHEAD, always: "on Saturday" said on a Saturday means the
    // one a week out. Resolving it to today would produce an instant in
    // the past for any time already gone, and the engine would drop it.
    let delta = (target - today + 7) % 7;
    if (delta === 0) delta = 7;
    const at = londonAt(now, delta, hour, statedTime ? minute : DEFAULT_MINUTE);
    return { ok: true, at, statedTime, whenLabel: label(at, statedTime) };
  }

  // ── 4. A bare clock time. "at 8pm". ────────────────────────────────
  //
  // Today when it is still to come, tomorrow when it has gone. That is
  // what a person means, and it is the only branch here that CHOOSES a
  // day the phrase did not name — so it chooses the one that cannot
  // produce a reminder in the past.
  if (clock) {
    const todayAt = londonAt(now, 0, hour, minute);
    const at = todayAt.getTime() > now.getTime() ? todayAt : londonAt(now, 1, hour, minute);
    return { ok: true, at, statedTime: true, whenLabel: label(at, true) };
  }

  // ── 5. A part of the day with no day. "in the evening". ────────────
  if (part) {
    const todayAt = londonAt(now, 0, PARTS_OF_DAY[part], 0);
    const at = todayAt.getTime() > now.getTime() ? todayAt : londonAt(now, 1, PARTS_OF_DAY[part], 0);
    return { ok: true, at, statedTime: true, whenLabel: label(at, true) };
  }

  return {
    ok: false,
    reason: `"${raw}" is not a time phrase this resolver understands`,
  };
}
