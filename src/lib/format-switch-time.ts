/**
 * FORMAT-SWITCH SCHEDULE arithmetic — pure, no DB, no LLM.
 *
 * WHY THIS FILE EXISTS (2026-09-08 production incident, Sutton FC)
 * ----------------------------------------------------------------
 * Every format is its own `Activity`, and every Activity carries its own
 * London wall-clock kickoff:
 *
 *     tuesday-7aside   time = "21:30"   playersPerTeam = 7
 *     tuesday-5aside   time = "21:15"   playersPerTeam = 5
 *
 * `switchMatchFormat` re-pointed `Match.activityId` and reset
 * `Match.maxPlayers`, but never touched `Match.date`. A match switched to
 * 5-a-side therefore kept the 7-a-side kickoff while pointing at an
 * Activity configured fifteen minutes earlier — and EVERY downstream post
 * (the chase, the squad announcement, the team sheet, the two-hour
 * pre-kickoff message) reads `Match.date`. The group was told the wrong
 * kickoff from the moment of the switch until the owner noticed himself,
 * four hours before a real match.
 *
 * This module owns the three decisions that fix it. It is pure so the
 * decisions are unit-testable, following the repo's pure-core convention
 * (match-slot.ts, next-upcoming-match.ts, block-booking.ts).
 *
 * THE THREE DECISIONS
 * -------------------
 *
 * 1. KICKOFF — rebuilt from the LONDON CALENDAR DAY of the existing
 *    `Match.date` plus the new Activity's `time`, via
 *    `londonWallClockToUtc`. Never the server clock: Vercel runs UTC, so
 *    `getHours()` is an hour out for half the year, and this repo has
 *    been bitten by exactly that before (see london-time.ts). The
 *    calendar day is read in London, which matters for a kickoff that
 *    falls on a different UTC day than London day.
 *
 * 2. A MANUALLY-SET KICKOFF IS NEVER STAMPED OVER. If the match does not
 *    currently sit on its OLD Activity's default time, somebody moved it
 *    deliberately and we leave it alone. This is reachable in-product:
 *    `createBlockBooking` accepts an optional `time` that overrides the
 *    Activity default for a whole block, so an admin who booked the pitch
 *    for 20:00 chose 20:00. Silently relocating his match to the other
 *    format's default would be the same class of surprise as the bug
 *    being fixed. Applying the DELTA between the two format times instead
 *    was rejected: it invents a third time (20:00 − 15min = 19:45) that
 *    nobody configured or booked.
 *
 * 3. attendanceDeadline IS ALWAYS RE-DERIVED when the kickoff moves —
 *    from the NEW kickoff and the NEW Activity's `deadlineHours`. The
 *    asymmetry with (2) is deliberate and principled: a field an admin
 *    CAN set gets its override respected; a field an admin CANNOT set is
 *    always derived. There is no deadline editor anywhere in the product
 *    — every writer (`/api/cron/generate-matches`,
 *    `generateMatchesForActivity`, block bookings) computes
 *    `kickoff − activity.deadlineHours`, so a divergent deadline is an
 *    artefact, never a decision. Leaving it behind is what produced the
 *    incident's second symptom: after the switch the deadline still read
 *    21:30, the OLD kickoff. When the kickoff does NOT move, the deadline
 *    is not touched either — one decision drives both fields, so the
 *    match is never left half-updated.
 *
 * `deadlineHours` of ZERO IS A REAL VALUE — it is Sutton's live setting
 * (sign-ups close at kickoff). Never `deadlineHours || 5`; the column is
 * a non-nullable `Int @default(5)` and 0 means 0.
 */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";
import { londonWallClockToUtc, formatLondon } from "./london-time";

export interface FormatSwitchScheduleInput {
  /** The match's current kickoff instant (`Match.date`). */
  currentKickoff: Date;
  /** The OLD activity's configured London wall clock, "HH:mm". */
  currentActivityTime: string;
  /** The NEW activity's configured London wall clock, "HH:mm". */
  newActivityTime: string;
  /** The NEW activity's `deadlineHours`. 0 is a real value. */
  newDeadlineHours: number;
}

/**
 * Why a switch is not moving the schedule.
 *
 * - `same-time`     both formats kick off at the same wall clock.
 * - `manual-override` the match is not on its old activity's default time.
 * - `unreadable-time` an activity's `time` could not be parsed. A live
 *   admin path must degrade to "change nothing", never throw.
 */
export type NoMoveReason = "same-time" | "manual-override" | "unreadable-time";

export type FormatSwitchSchedule =
  | { move: false; reason: NoMoveReason }
  | {
      move: true;
      reason: "moved";
      /** Where the match was before the switch. */
      previousKickoff: Date;
      /** The new activity's time on the same LONDON calendar day. */
      kickoff: Date;
      /** `kickoff − newDeadlineHours`. */
      attendanceDeadline: Date;
    };

/**
 * Decide what a format switch should do to a match's kickoff and
 * attendance deadline. Returns `{ move: false }` whenever the schedule
 * must be left exactly as it is — callers must then omit `date` and
 * `attendanceDeadline` from the update entirely rather than rewriting
 * them with equal values.
 */
export function planFormatSwitchSchedule(
  input: FormatSwitchScheduleInput,
): FormatSwitchSchedule {
  let oldDefault: Date;
  let target: Date;
  try {
    // Both resolved against the match's LONDON calendar day, so DST is
    // whatever London was actually doing on that date.
    oldDefault = londonWallClockToUtc(
      input.currentKickoff,
      input.currentActivityTime,
    );
    target = londonWallClockToUtc(input.currentKickoff, input.newActivityTime);
  } catch {
    return { move: false, reason: "unreadable-time" };
  }
  if (Number.isNaN(oldDefault.getTime()) || Number.isNaN(target.getTime())) {
    return { move: false, reason: "unreadable-time" };
  }

  // Decision 2: somebody moved this match on purpose — leave it.
  if (oldDefault.getTime() !== input.currentKickoff.getTime()) {
    return { move: false, reason: "manual-override" };
  }

  // Decision 4: same-time formats are a NO-OP, not a rewrite.
  if (target.getTime() === input.currentKickoff.getTime()) {
    return { move: false, reason: "same-time" };
  }

  // Decision 3. 0 is a real value, so no falsy fallback — only a guard
  // against a non-finite value, which degrades to "deadline = kickoff"
  // rather than writing an Invalid Date.
  const deadlineHours = Number.isFinite(input.newDeadlineHours)
    ? input.newDeadlineHours
    : 0;

  return {
    move: true,
    reason: "moved",
    previousKickoff: input.currentKickoff,
    kickoff: target,
    attendanceDeadline: new Date(
      target.getTime() - deadlineHours * 60 * 60 * 1000,
    ),
  };
}

/**
 * The one line the group needs when a switch moves the kickoff — because
 * the whole incident was the group being told the wrong time. Empty
 * string when nothing moved, so callers can concatenate unconditionally.
 *
 * London wall clock on both sides; the UTC hour must never reach a human.
 */
export function renderKickoffMoveLine(plan: FormatSwitchSchedule, lang?: Lang | string | null): string {
  if (!plan.move) return "";
  return t(lang).kickoff_move_line({
    newTime: formatLondon(plan.kickoff, "HH:mm"),
    oldTime: formatLondon(plan.previousKickoff, "HH:mm"),
  });
}
