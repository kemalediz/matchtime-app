/**
 * WHO MOVES UP FROM THE BENCH WHEN A PLACE OPENS (2026-11-17).
 *
 * Sutton FC, Tue 17 Nov 2026, 13:33: the organiser dropped David from a
 * full 14-place squad with Recai on the bench. MatchTime then said
 * "13/14, need 1 more" with "Bench (1): Recai" under it, and posted a
 * public "First to claim it plays" race to Recai alone. The organiser
 * had to write "Recai is IN" by hand.
 *
 * The rule now: in a first-come club a free place goes to the first
 * player on the bench, in bench order, at once. Pure, no database.
 */
import { describe, it, expect } from "vitest";
import { pickBenchMovers, heldOnBench, type BenchFillRow } from "../bench-fill-rules";
import { EXPLICIT_BENCH_NOTE, EXPLICIT_BENCH_WITH_ROOM_NOTE } from "../attendance-events";

function row(userId: string, status: BenchFillRow["status"], position: number, over: Partial<BenchFillRow> = {}): BenchFillRow {
  return { userId, status, position, joinedAt: position * 1000, held: false, ...over };
}

const thirteen = Array.from({ length: 13 }, (_, i) => row(`p${i + 1}`, "CONFIRMED", i + 1));

describe("pickBenchMovers", () => {
  it("THE INCIDENT: 13 of 14 with one on the bench moves him up", () => {
    expect(pickBenchMovers({ maxPlayers: 14, rows: [...thirteen, row("david", "DROPPED", 10), row("recai", "BENCH", 17)] })).toEqual(["recai"]);
  });

  it("two on the bench: the first in bench order moves up, the second waits", () => {
    const rows = [...thirteen, row("second", "BENCH", 19), row("first", "BENCH", 18)];
    expect(pickBenchMovers({ maxPlayers: 14, rows })).toEqual(["first"]);
  });

  it("bench order ties are broken by when they joined, then by id", () => {
    const rows = [...thirteen, row("b", "BENCH", 18, { joinedAt: 5 }), row("a", "BENCH", 18, { joinedAt: 9 })];
    expect(pickBenchMovers({ maxPlayers: 14, rows })).toEqual(["b"]);
  });

  it("two places open: the first two move up", () => {
    const rows = [...thirteen.slice(0, 12), row("x", "BENCH", 20), row("y", "BENCH", 21), row("z", "BENCH", 22)];
    expect(pickBenchMovers({ maxPlayers: 14, rows })).toEqual(["x", "y"]);
  });

  it("a full squad moves nobody", () => {
    const rows = [...thirteen, row("p14", "CONFIRMED", 14), row("recai", "BENCH", 17)];
    expect(pickBenchMovers({ maxPlayers: 14, rows })).toEqual([]);
  });

  it("an empty bench moves nobody", () => {
    expect(pickBenchMovers({ maxPlayers: 14, rows: thirteen })).toEqual([]);
  });

  it("a player who chose the bench while he could have played is skipped; the next one moves up", () => {
    const rows = [...thirteen, row("chose", "BENCH", 17, { held: true }), row("next", "BENCH", 18)];
    expect(pickBenchMovers({ maxPlayers: 14, rows })).toEqual(["next"]);
  });

  it("only held players on the bench: nobody moves", () => {
    const rows = [...thirteen, row("chose", "BENCH", 17, { held: true })];
    expect(pickBenchMovers({ maxPlayers: 14, rows })).toEqual([]);
  });
});

describe("heldOnBench", () => {
  it("no bench move on record (an older row): not held", () => {
    expect(heldOnBench(undefined)).toBe(false);
    expect(heldOnBench(null)).toBe(false);
  });

  it("benched because the squad was full: not held", () => {
    expect(heldOnBench({ fromStatus: null, note: "squad full, no slot to give" })).toBe(false);
  });

  it("a reserve who asked for the bench on a FULL squad ('In as a reserve'): not held, he moves up in his turn", () => {
    expect(heldOnBench({ fromStatus: null, note: EXPLICIT_BENCH_NOTE })).toBe(false);
  });

  it("asked for the bench while places were open: held", () => {
    expect(heldOnBench({ fromStatus: null, note: EXPLICIT_BENCH_WITH_ROOM_NOTE })).toBe(true);
  });

  it("taken out of the squad onto the bench on purpose (himself or an admin): held", () => {
    expect(heldOnBench({ fromStatus: "CONFIRMED", note: EXPLICIT_BENCH_NOTE })).toBe(true);
  });

  it("moved to the bench by a format switch or the monthly seed: not held", () => {
    expect(heldOnBench({ fromStatus: "CONFIRMED", note: "moved to the bench: the match went down to 10 places" })).toBe(false);
  });

  it("the with-room marker still reads as 'chose the bench' for the monthly squad", () => {
    expect(EXPLICIT_BENCH_WITH_ROOM_NOTE.startsWith(EXPLICIT_BENCH_NOTE)).toBe(true);
  });
});
