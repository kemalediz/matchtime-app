/**
 * A MONTH'S REGULARS WITH NO SQUAD LIMIT (2026-11-17): the main squad
 * "expands or shrinks without any limits", so the month's sign-up never
 * puts a regular on the waiting list for want of a place, carries every
 * regular over, and lists no empty places. Off: two full sides, as before.
 */
import { describe, expect, it } from "vitest";
import { buildSignupList, decideSignup, planCarryOver, type SignupMember } from "../month-signup-rules";
import { monthRegularCap } from "../open-squad";

const reg = (i: number): SignupMember => ({ userId: `r${i}`, name: `R${i}`, kind: "regular", slot: i, waiting: false, out: false, paid: "none", paygMatchIds: [] });
const FOURTEEN = Array.from({ length: 14 }, (_, i) => reg(i + 1));

describe("monthRegularCap", () => {
  it("two full sides, or no cap for an open squad", () => {
    expect(monthRegularCap(7, false)).toBe(14);
    expect(monthRegularCap(7, true)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the month's sign-up with no limit", () => {
  it("the 15th IN is a regular, not waiting", () => {
    const d = decideSignup({ choice: "in", days: [], existing: null, others: FOURTEEN, maxRegulars: monthRegularCap(7, true), matches: [] });
    expect(d).toMatchObject({ kind: "write", outcome: "regular", row: { slot: 15, waiting: false } });
    const off = decideSignup({ choice: "in", days: [], existing: null, others: FOURTEEN, maxRegulars: monthRegularCap(7, false), matches: [] });
    expect(off.outcome).toBe("waiting");
  });

  it("every regular is carried over", () => {
    const previous = Array.from({ length: 18 }, (_, i) => ({ userId: `r${i}`, kind: "regular", tier: "standard", slot: i + 1, left: false, here: true }));
    expect(planCarryOver({ previous, maxRegulars: monthRegularCap(7, true) }).filter((c) => c.waiting)).toHaveLength(0);
    expect(planCarryOver({ previous, maxRegulars: monthRegularCap(7, false) }).filter((c) => c.waiting)).toHaveLength(4);
  });

  it("the list is its regulars, with no empty places", () => {
    const list = buildSignupList({ members: FOURTEEN.slice(0, 12), maxRegulars: monthRegularCap(7, true), matches: [] });
    expect(list.slots).toHaveLength(12);
    expect(list.slots.every((s) => s.userId !== null)).toBe(true);
    expect(buildSignupList({ members: FOURTEEN.slice(0, 12), maxRegulars: 14, matches: [] }).slots).toHaveLength(14);
  });
});
