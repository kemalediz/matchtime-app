/**
 * One message, twice in one batch (PR #250 review, fix 7). The analyze
 * route's dedupe looks each id up among the rows already stored, so two
 * copies of a NEW message in the same batch both passed it.
 */
import { describe, expect, it } from "vitest";
import { uniqueByWaMessageId } from "../analyze-batch";

const m = (waMessageId: string, body = "in") => ({ waMessageId, body });

describe("uniqueByWaMessageId", () => {
  it("a batch with no repeated id comes back AS THE SAME ARRAY: nothing can change for it", () => {
    const batch = [m("a"), m("b"), m("c")];
    expect(uniqueByWaMessageId(batch)).toBe(batch);
    const one = [m("a")];
    expect(uniqueByWaMessageId(one)).toBe(one);
    const none: Array<{ waMessageId: string }> = [];
    expect(uniqueByWaMessageId(none)).toBe(none);
  });

  it("a repeated id keeps its FIRST copy, in place, and the order of the rest", () => {
    const first = m("a", "In");
    const batch = [first, m("b"), m("a", "In (the catch-up's copy)"), m("c"), m("b")];
    const out = uniqueByWaMessageId(batch);
    expect(out.map((x) => x.waMessageId)).toEqual(["a", "b", "c"]);
    expect(out[0]).toBe(first);
    // The caller's array is not touched.
    expect(batch).toHaveLength(5);
  });

  it("ids are compared exactly: a different id is a different message", () => {
    const batch = [m("false_g@g.us_AAA"), m("false_g@g.us_AAB"), m("FALSE_g@g.us_AAA")];
    expect(uniqueByWaMessageId(batch)).toBe(batch);
  });
});
