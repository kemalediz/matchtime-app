/**
 * The appearances and Man of the Match counts, cut to a period
 * (2026-09-23). Pure: the loader in `match-history.ts` reads the rows,
 * these count them. The whole-record appearances table in the prompt's
 * recent-history block is counted by the same function, so the group's
 * answer and that table cannot disagree.
 */
import { describe, expect, it } from "vitest";
import { countAppearances, countMomWins, earliestDate } from "../club-record-tables";

const d = (iso: string) => new Date(`${iso}T20:00:00.000Z`);
const NAMES: Record<string, string> = { a: "Abid", b: "Baki", c: "Cem", z: "Zair" };
const nameOf = (id: string) => NAMES[id] ?? "(unnamed)";
const everyone = () => true;

const ROWS = [
  { userId: "a", date: d("2026-04-14") },
  { userId: "a", date: d("2026-05-12") },
  { userId: "a", date: d("2026-09-15") },
  { userId: "b", date: d("2026-09-01") },
  { userId: "b", date: d("2026-09-15") },
  { userId: "c", date: d("2026-09-08") },
  { userId: "c", date: d("2026-09-15") },
  { userId: "z", date: d("2026-04-21") },
];

describe("countAppearances", () => {
  it("over the whole record: most first, a name breaking a tie", () => {
    expect(countAppearances(ROWS, { since: null, isRanked: everyone, nameOf })).toEqual([
      { userId: "a", name: "Abid", matches: 3 },
      { userId: "b", name: "Baki", matches: 2 },
      { userId: "c", name: "Cem", matches: 2 },
      { userId: "z", name: "Zair", matches: 1 },
    ]);
  });

  it("cut to a period, counting only the matches on or after its start", () => {
    expect(countAppearances(ROWS, { since: d("2026-09-01"), isRanked: everyone, nameOf })).toEqual([
      { userId: "b", name: "Baki", matches: 2 },
      { userId: "c", name: "Cem", matches: 2 },
      { userId: "a", name: "Abid", matches: 1 },
    ]);
  });

  it("the three-month inactivity rule removes the row and touches nobody else's number", () => {
    const rows = countAppearances(ROWS, { since: null, isRanked: (id) => id !== "z", nameOf });
    expect(rows.map((r) => r.userId)).toEqual(["a", "b", "c"]);
    expect(rows[0].matches).toBe(3);
  });

  it("is uncapped: the group's cap of ten is the renderer's, applied after", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ userId: `p${i}`, date: d("2026-09-15") }));
    expect(countAppearances(many, { since: null, isRanked: everyone, nameOf })).toHaveLength(25);
  });
});

describe("countMomWins", () => {
  const WINS = [
    { userId: "a", name: "Abid", date: d("2025-11-04") },
    { userId: "a", name: "Abid", date: d("2026-09-15") },
    { userId: "b", name: "Baki", date: d("2026-09-08") },
    { userId: "c", name: "Cem", date: d("2026-05-01") },
  ];
  it("counts every win, historical awards included, on the whole record", () => {
    expect(countMomWins(WINS, { since: null, isRanked: everyone })).toEqual([
      { userId: "a", name: "Abid", wins: 2 },
      { userId: "b", name: "Baki", wins: 1 },
      { userId: "c", name: "Cem", wins: 1 },
    ]);
  });
  it("cut to a period", () => {
    expect(countMomWins(WINS, { since: d("2026-09-01"), isRanked: everyone })).toEqual([
      { userId: "a", name: "Abid", wins: 1 },
      { userId: "b", name: "Baki", wins: 1 },
    ]);
  });
  it("inactive players out", () => {
    expect(countMomWins(WINS, { since: null, isRanked: (id) => id !== "a" }).map((r) => r.userId)).toEqual(["b", "c"]);
  });
});

describe("earliestDate: where a club's records begin", () => {
  it("is the earliest, or null when there is nothing", () => {
    expect(earliestDate([d("2026-05-01"), d("2026-04-14"), d("2026-09-01")])).toEqual(d("2026-04-14"));
    expect(earliestDate([])).toBeNull();
  });
});
