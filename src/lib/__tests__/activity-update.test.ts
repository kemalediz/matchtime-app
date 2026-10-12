/**
 * What `updateActivity` may write (review fix 7 of PR #238, 2026-10-12).
 * Pure: `activityUpdateData` turns whatever the browser sent into the
 * Prisma `data`, or refuses.
 *
 * Before, the action handed its whole argument to Prisma, so a caller
 * could set any column of the activity (its club, its fee split) by
 * adding a key. Now only named fields pass, each one checked.
 */
import { describe, expect, it } from "vitest";
import { activityUpdateData } from "../activity-update";

const WEEKLY = { feeSplitTotal: false };

describe("activityUpdateData: only named, checked fields are written", () => {
  it("the edit form's fields pass through as they are", () => {
    expect(activityUpdateData({ name: "Tuesday 7s", dayOfWeek: 2, time: "21:30", venue: "Goals" }, WEEKLY)).toEqual({
      ok: true,
      data: { name: "Tuesday 7s", dayOfWeek: 2, time: "21:30", venue: "Goals" },
    });
    expect(activityUpdateData({ isActive: false }, WEEKLY)).toEqual({ ok: true, data: { isActive: false } });
    expect(activityUpdateData({ sportId: "s1", deadlineHours: 5, ratingWindowHours: 120, matchDurationMins: 60 }, WEEKLY)).toEqual({
      ok: true,
      data: { sportId: "s1", deadlineHours: 5, ratingWindowHours: 120, matchDurationMins: 60 },
    });
  });
  it("a key nobody named is never written: not the club, not the id, not the fee split", () => {
    const sneaky = { name: "Tuesday 7s", orgId: "another-club", id: "x", feeSplitTotal: true, createdAt: "2020-01-01", matches: { deleteMany: {} } };
    expect(activityUpdateData(sneaky, WEEKLY)).toEqual({ ok: true, data: { name: "Tuesday 7s" } });
  });
  it("a field that is present but undefined is left alone", () => {
    expect(activityUpdateData({ name: undefined, venue: "Goals", isActive: undefined }, WEEKLY)).toEqual({ ok: true, data: { venue: "Goals" } });
  });
  it("a bad value is refused, with the field named, and nothing is written", () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "x" }, /name/i],
      [{ name: 7 }, /name/i],
      [{ dayOfWeek: 7 }, /day/i],
      [{ dayOfWeek: 1.5 }, /day/i],
      [{ dayOfWeek: "2" }, /day/i],
      [{ time: "9pm" }, /time/i],
      [{ time: "25:00" }, /time/i],
      [{ venue: "" }, /venue/i],
      [{ deadlineHours: 0 }, /deadline/i],
      [{ matchDurationMins: 500 }, /duration/i],
      [{ ratingWindowHours: 1000 }, /rating/i],
      [{ isActive: "yes" }, /active/i],
      [{ sportId: "" }, /sport/i],
    ];
    for (const [input, message] of bad) {
      const r = activityUpdateData({ venue: "Goals", ...input }, WEEKLY);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      if (!r.ok) expect(r.error, JSON.stringify(input)).toMatch(message);
    }
  });
  it("not an object at all: refused", () => {
    for (const input of [null, undefined, "name", 7, ["name"]]) expect(activityUpdateData(input, WEEKLY).ok, String(input)).toBe(false);
  });
});

describe("activityUpdateData: the fee per player", () => {
  it("left out, or present but undefined: the stored fee is NOT touched", () => {
    expect(activityUpdateData({ name: "Tuesday 7s" }, WEEKLY)).toEqual({ ok: true, data: { name: "Tuesday 7s" } });
    const r = activityUpdateData({ name: "Tuesday 7s", feePerPlayer: undefined }, WEEKLY);
    expect(r).toEqual({ ok: true, data: { name: "Tuesday 7s" } });
    if (r.ok) expect("feePerPlayer" in r.data).toBe(false);
  });
  it("typed: through the one parser, to the penny", () => {
    expect(activityUpdateData({ feePerPlayer: "6,50" }, WEEKLY)).toEqual({ ok: true, data: { feePerPlayer: 6.5 } });
    expect(activityUpdateData({ feePerPlayer: 7 }, WEEKLY)).toEqual({ ok: true, data: { feePerPlayer: 7 } });
  });
  it("emptied, or null: the fee is cleared", () => {
    expect(activityUpdateData({ feePerPlayer: "" }, WEEKLY)).toEqual({ ok: true, data: { feePerPlayer: null } });
    expect(activityUpdateData({ feePerPlayer: null }, WEEKLY)).toEqual({ ok: true, data: { feePerPlayer: null } });
  });
  it("not an amount, or too much: refused in the words the form shows", () => {
    for (const fee of ["six", "250", "0", -1, "6.505"]) {
      expect(activityUpdateData({ name: "Tuesday 7s", feePerPlayer: fee }, WEEKLY), String(fee)).toEqual({
        ok: false,
        error: "Enter a fee like 6 or 6.50, at most £100.",
      });
    }
  });
  it("a game that splits the pitch cost has no fixed fee: one cannot be set, though it can be cleared and the rest edited", () => {
    const split = { feeSplitTotal: true };
    expect(activityUpdateData({ feePerPlayer: "6" }, split)).toEqual({
      ok: false,
      error: "This game splits the pitch cost, so it has no fixed fee per player.",
    });
    expect(activityUpdateData({ feePerPlayer: "" }, split)).toEqual({ ok: true, data: { feePerPlayer: null } });
    expect(activityUpdateData({ venue: "Goals" }, split)).toEqual({ ok: true, data: { venue: "Goals" } });
  });
});
