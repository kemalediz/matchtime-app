/**
 * DAY AND HOURS: is a pool player free for the whole of a game? (slice L4,
 * 2026-10-24). PURE: no database, no clock of its own.
 *
 * A player's availability is London wall-clock ranges per weekday
 * (`AvailabilityRange`, rules.ts, decision log #12): `fromMin` inclusive,
 * `toMin` exclusive, never crossing midnight. He is available for a game
 * when his ranges cover it from kickoff to full time, without a gap.
 *
 * Everything is measured in "week minutes": minutes after Sunday 00:00
 * London (Sunday = 0, as `Activity.dayOfWeek`). An overnight game (Tuesday
 * 23:30 for an hour) is covered by two ranges on two days (Tue 22:00-24:00,
 * Wed 00:00-01:00); a game running past Saturday midnight wraps into the
 * next week's Sunday.
 *
 * Clock changes: the game's end is the LATER of kickoff + its length and
 * the wall clock at full time, so a game across the spring change (00:30
 * GMT + 60 minutes = 02:30 BST) must be covered to 02:30, and one across
 * the autumn change (01:30 BST + 60 minutes = 01:30 GMT) still needs a full
 * wall-clock hour.
 */
import { formatLondon } from "../london-time";
import type { AvailabilityRange } from "./rules";

export const DAY_MINS = 24 * 60;
export const WEEK_MINS = 7 * DAY_MINS;

function weekMinute(d: Date): number {
  const weekday = Number(formatLondon(d, "i")) % 7; // Mon=1..Sun=7 -> Sun=0..Sat=6
  return weekday * DAY_MINS + Number(formatLondon(d, "H")) * 60 + Number(formatLondon(d, "m"));
}

/** The game as week minutes, `start` inclusive, `end` exclusive; `end` may
 *  pass WEEK_MINS when the game runs past Saturday midnight. */
export function gameWindowOf(kickoff: Date, durationMins: number): { start: number; end: number } {
  const mins = Number.isFinite(durationMins) && durationMins > 0 ? durationMins : 1;
  const start = weekMinute(kickoff);
  let wallEnd = weekMinute(new Date(kickoff.getTime() + mins * 60_000));
  if (wallEnd < start) wallEnd += WEEK_MINS;
  return { start, end: Math.max(start + mins, wallEnd) };
}

/** Do the ranges cover the whole game, kickoff to full time? */
export function availableFor(ranges: readonly AvailabilityRange[], kickoff: Date, durationMins: number): boolean {
  const { start, end } = gameWindowOf(kickoff, durationMins);
  // Each range this week and the next, so a game past Saturday midnight is seen.
  const spans = ranges
    .flatMap((r) => [0, WEEK_MINS].map((shift) => ({ from: r.day * DAY_MINS + r.fromMin + shift, to: r.day * DAY_MINS + r.toMin + shift })))
    .sort((a, b) => a.from - b.from);
  let covered = start;
  for (const s of spans) {
    if (s.from > covered) break;
    if (s.to > covered) covered = s.to;
    if (covered >= end) return true;
  }
  return covered >= end;
}
