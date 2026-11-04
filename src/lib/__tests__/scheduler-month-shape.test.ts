/**
 * The scheduler's three month shapes from the club summary's month facts
 * (club summary A1, scheduler-month-shape.ts): exactly the rules
 * `computeDuePosts` used to apply to its own reads. The common cases are in
 * club-summary/__tests__/derive.test.ts ("today's scheduler mapping"); these
 * are the windows those reads had.
 */
import { describe, expect, it } from "vitest";
import { schedulerMonthShape } from "../scheduler-month-shape";
import { monthFacts, monthPhaseFor } from "../club-summary/derive";
import { VETS_A, match, month } from "../club-summary/__tests__/fixtures";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const acts = [VETS_A];
const shape = (m: ReturnType<typeof match>, rows: ReturnType<typeof month>[], held: string[] = [], now = NOW) => {
  const months = monthFacts(rows, acts);
  return schedulerMonthShape({ facts: monthPhaseFor({ orgId: "org-vets", match: m, months, activities: acts, heldKeys: held }), months, match: m, now });
};
const game = (iso: string, over: Partial<Parameters<typeof match>[0]> = {}) => match({ id: "m", activityId: VETS_A.id, date: new Date(iso), maxPlayers: 14, ...over });
const row = (monthStart: string, over: Partial<Parameters<typeof month>[0]> = {}) =>
  month({ id: `sm-${monthStart}`, activityId: VETS_A.id, monthStart: new Date(`${monthStart}T00:00:00Z`), createdAt: new Date("2026-10-28T10:00:00Z"), ...over });

describe("schedulerMonthShape", () => {
  it("a weekly club's match (no facts) is no month", () => {
    expect(schedulerMonthShape({ facts: null, months: [], match: game("2026-11-09T20:00:00Z"), now: NOW })).toEqual({ kind: "none" });
  });

  it("a running month: the month, with whether its regulars are on the game", () => {
    expect(shape(game("2026-11-09T20:00:00Z", { rollingSeededAt: new Date("2026-11-03T09:00:00Z") }), [row("2026-11-01")])).toEqual({ kind: "month", monthId: "sm-2026-11-01", seeded: true });
    expect(shape(game("2026-11-09T20:00:00Z"), [row("2026-11-01")])).toEqual({ kind: "month", monthId: "sm-2026-11-01", seeded: false });
  });

  it("a closed month answers for its played games for 14 days after the close, never after", () => {
    const played = game("2026-10-26T20:00:00Z", { status: "COMPLETED" });
    const closed = (at: string) => row("2026-10-01", { status: "closed", closedAt: new Date(at) });
    expect(shape(played, [closed("2026-10-27T10:00:00Z")]).kind).toBe("month");
    expect(shape(played, [closed("2026-10-21T12:00:00Z")]).kind).toBe("month");
    expect(shape(played, [closed("2026-10-21T11:59:00Z")]).kind).toBe("none");
  });

  it("a sign-up month whose list is open: this London month or the next, never one further out", () => {
    const open = (start: string) => row(start, { status: "open", listOpenedAt: new Date("2026-11-03T10:00:00Z") });
    expect(shape(game("2026-12-07T20:00:00Z"), [open("2026-12-01")])).toEqual({ kind: "signup", monthId: "sm-2026-12-01" });
    expect(shape(game("2027-01-04T20:00:00Z"), [open("2027-01-01")])).toEqual({ kind: "none" });
  });

  it("a held month, with no row or a row not yet in sign-up, is held", () => {
    const key = "org-org-vets:msu:held:2026-12-01:a-vets";
    expect(shape(game("2026-12-07T20:00:00Z"), [], [key])).toEqual({ kind: "held" });
    expect(shape(game("2026-12-07T20:00:00Z"), [row("2026-12-01", { status: "priced" })], [key])).toEqual({ kind: "held" });
    expect(shape(game("2026-12-07T20:00:00Z"), [row("2026-12-01", { status: "priced" })])).toEqual({ kind: "none" });
  });
});
