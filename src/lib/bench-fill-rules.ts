/**
 * ── THE BENCH FILLS AN OPEN PLACE BY ITSELF (2026-11-17) ──────────────
 *
 * Pure: no database, no clock. `bench-fill.ts` applies it.
 *
 * THE INCIDENT. Sutton FC, Tue 17 Nov 2026, 13:33, a 14-place 7-a-side.
 * Recai said IN on a full squad and went on the bench; a second later the
 * organiser dropped David. MatchTime then:
 *   1. answered "what is the list?" with "13/14, need 1 more 🙏" and
 *      "Bench (1): Recai Gunay" under it;
 *   2. posted "🎟 A slot just opened … *First to claim it plays.*" tagging
 *      Recai alone, a public race with one runner;
 *   3. left the organiser to write "Recai is IN" before the squad read
 *      14/14.
 * The players laughed at it.
 *
 * WHY IT HAPPENED. Since 2026-04-19 a drop did not move anybody up: it
 * asked the bench (first a 👍/👎 chain, one bencher at a time with a 2h
 * timer; after the Karahan incident of 2026-05-19, where three benchers
 * were dropped overnight for being asleep, one offer broadcast to the
 * whole bench, first to claim plays). The reason was "the bench player
 * may have mentally checked out". Both designs leave the squad short with
 * somebody waiting until a human acts, which is the contradiction above.
 *
 * THE RULE NOW, for a first-come club:
 *   • a free place goes to the first player on the bench, in bench order
 *     (position, then when they joined), straight away;
 *   • he is told by DM that he is in and that replying OUT passes the
 *     place on (an OUT moves the next one up), and the group is told who
 *     moved up. No timer and nobody is ever dropped for silence, so the
 *     Karahan lessons still hold; the DM waits for the club's quiet hours
 *     to end like every other DM;
 *   • a player who CHOSE the bench while he could have played (`held`)
 *     is never moved up by MatchTime: he asked to wait, and his own IN
 *     still puts him in.
 * An organiser-pick club is untouched: there the organisers choose.
 *
 * The same order `flex-format-rules.ts:planResize` uses when a match goes
 * up a size, so a bigger format and a drop agree on who is next.
 */
import { EXPLICIT_BENCH_NOTE, EXPLICIT_BENCH_WITH_ROOM_NOTE } from "./attendance-events";

export interface BenchFillRow {
  userId: string;
  status: "CONFIRMED" | "BENCH" | "DROPPED";
  /** `Attendance.position`: the order they joined the list. */
  position: number;
  /** When they last answered (ms), the tie-break after position. */
  joinedAt: number;
  /** Chose the bench while a place was his for the taking (`heldOnBench`). */
  held: boolean;
}

/** Who moves up, first in bench order first. Empty when the squad is
 *  full or nobody on the bench can be moved up. */
export function pickBenchMovers(p: { rows: readonly BenchFillRow[]; maxPlayers: number }): string[] {
  const confirmed = p.rows.filter((r) => r.status === "CONFIRMED").length;
  const room = p.maxPlayers - confirmed;
  if (room <= 0) return [];
  return p.rows
    .filter((r) => r.status === "BENCH" && !r.held)
    .sort((a, b) => a.position - b.position || a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId))
    .slice(0, room)
    .map((r) => r.userId);
}

/**
 * Did he choose the bench while he could have played? Read from his LAST
 * move onto the bench in the attendance log:
 *   • asked for it while places were open (`EXPLICIT_BENCH_WITH_ROOM_NOTE`);
 *   • or taken out of the squad onto it on purpose, by himself or an
 *     admin ("move Luca to the bench"): an explicit request from CONFIRMED.
 * A reserve who asked for the bench on a FULL squad ("In as a reserve")
 * is not held: that is exactly who the bench is for. Neither is anyone
 * the squad had no room for, a format switch or the monthly seed.
 */
export function heldOnBench(lastBenchMove: { fromStatus: string | null; note: string | null } | null | undefined): boolean {
  const note = lastBenchMove?.note;
  if (!note) return false;
  if (note === EXPLICIT_BENCH_WITH_ROOM_NOTE) return true;
  return note.startsWith(EXPLICIT_BENCH_NOTE) && lastBenchMove?.fromStatus === "CONFIRMED";
}
