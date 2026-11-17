/**
 * A LATE IN AFTER THE TEAMS ARE MADE, IN AN OPEN SQUAD (review of #623).
 *
 * With no squad limit a player can say IN after the sheet is out, and
 * there is no vacated slot for him: he joins the side with fewer players
 * on it, and when the sides are level, the side with the lower total
 * rating (then Red). A vacated slot is still inherited first, as a
 * replacement always has been. A drop leaves the sides as they are.
 */
import { describe, expect, it } from "vitest";
import { decideOpenSquadJoins } from "../team-slot-inherit";

const row = (userId: string, position: number, status: "CONFIRMED" | "BENCH" | "DROPPED" = "CONFIRMED") => ({ userId, status, position });
const SHEET = [
  { userId: "a", team: "RED" as const },
  { userId: "b", team: "RED" as const },
  { userId: "c", team: "YELLOW" as const },
  { userId: "d", team: "YELLOW" as const },
];
const BASE = [row("a", 1), row("b", 2), row("c", 3), row("d", 4)];
const rating = (r: Record<string, number>) => (id: string) => r[id] ?? 6;

describe("decideOpenSquadJoins", () => {
  it("level sides: the one with the lower total rating", () => {
    const joins = decideOpenSquadJoins({ rows: [...BASE, row("e", 5)], teams: SHEET, ratingOf: rating({ a: 9, b: 9, c: 5, d: 5 }) });
    expect(joins).toEqual([{ userId: "e", team: "YELLOW" }]);
  });

  it("level sides and level ratings: Red", () => {
    expect(decideOpenSquadJoins({ rows: [...BASE, row("e", 5)], teams: SHEET, ratingOf: rating({}) })).toEqual([{ userId: "e", team: "RED" }]);
  });

  it("uneven sides: the smaller one, whatever the ratings; two arrivals in the order they joined", () => {
    const sheet = [...SHEET, { userId: "e", team: "RED" as const }];
    const joins = decideOpenSquadJoins({
      rows: [...BASE, row("e", 5), row("f", 6), row("g", 7)],
      teams: sheet,
      ratingOf: rating({ a: 2, b: 2, e: 2, c: 9, d: 9 }),
    });
    // f to Yellow (3 v 2), then level 3 v 3: Red's total is lower.
    expect(joins).toEqual([
      { userId: "f", team: "YELLOW" },
      { userId: "g", team: "RED" },
    ]);
  });

  it("a slot a player out still holds counts for nobody: the side is short by him", () => {
    const joins = decideOpenSquadJoins({ rows: [row("a", 1), row("b", 2, "DROPPED"), row("c", 3), row("d", 4), row("e", 5)], teams: SHEET, ratingOf: rating({}) });
    expect(joins).toEqual([{ userId: "e", team: "RED" }]);
  });

  it("a player already on the sheet, or not playing, never joins", () => {
    expect(decideOpenSquadJoins({ rows: [...BASE, row("e", 5, "DROPPED")], teams: SHEET, ratingOf: rating({}) })).toEqual([]);
    expect(decideOpenSquadJoins({ rows: BASE, teams: SHEET, ratingOf: rating({}) })).toEqual([]);
  });

  it("no sheet: nothing", () => {
    expect(decideOpenSquadJoins({ rows: [...BASE, row("e", 5)], teams: [], ratingOf: rating({}) })).toEqual([]);
  });
});
