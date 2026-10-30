/**
 * Match day is the London calendar date of the match (2026-09-29, after
 * the Sutton FC incident of Thu 24 Sep, when a joke built the teams five
 * days early). The word tests that stood here are deleted (2026-10-30).
 */
import { describe, expect, it } from "vitest";
import { isMatchDay, londonDateKey } from "../team-requests";

describe("match day is the London calendar date of the match", () => {
  it("Thursday 22:51 BST is not match day for a Tuesday match", () => {
    const now = new Date("2026-09-24T21:51:00Z"); // Thu 22:51 BST
    const kickoff = new Date("2026-09-29T19:30:00Z"); // Tue 20:30 BST
    expect(isMatchDay(kickoff, now)).toBe(false);
  });

  it("Tuesday morning is match day for a Tuesday evening match", () => {
    const now = new Date("2026-09-29T07:00:00Z"); // Tue 08:00 BST
    const kickoff = new Date("2026-09-29T19:30:00Z");
    expect(isMatchDay(kickoff, now)).toBe(true);
  });

  it("uses LONDON dates, not UTC: 00:30 BST is already the next day in London", () => {
    // 23:30 UTC on Mon 28 Sep is 00:30 BST on Tue 29 Sep.
    const now = new Date("2026-09-28T23:30:00Z");
    const kickoff = new Date("2026-09-29T19:30:00Z");
    expect(londonDateKey(now)).toBe("2026-09-29");
    expect(isMatchDay(kickoff, now)).toBe(true);
  });

  it("the day after is not match day", () => {
    const now = new Date("2026-09-30T09:00:00Z");
    const kickoff = new Date("2026-09-29T19:30:00Z");
    expect(isMatchDay(kickoff, now)).toBe(false);
  });
});
