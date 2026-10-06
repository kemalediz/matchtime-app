/**
 * Which open bench offers has an audience not been told about, and which
 * offer is their one announcement keyed on (`bench-offer-batch.ts`,
 * 2026-10-06). Pure: no database, no clock.
 */
import { describe, expect, it } from "vitest";
import { leadOffer, untoldOffers } from "../bench-offer-batch";

const T0 = new Date("2026-10-03T12:30:00.000Z").getTime();
const o = (id: string, secs: number) => ({ id, createdAt: new Date(T0 + secs * 1000) });
const sent = (...ids: string[]) => (id: string) => ids.includes(id);
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe("untoldOffers", () => {
  it("nothing announced yet: every open offer, oldest first", () => {
    expect(ids(untoldOffers([o("c", 3), o("a", 1), o("b", 2)], [], sent()))).toEqual(["a", "b", "c"]);
  });

  it("an announcement keyed on the newest covers the older ones", () => {
    expect(untoldOffers([o("a", 1), o("b", 2), o("c", 3)], [], sent("c"))).toEqual([]);
  });

  it("an offer opened after the announced one is untold", () => {
    expect(ids(untoldOffers([o("a", 1), o("b", 2), o("c", 60)], [], sent("b")))).toEqual(["c"]);
  });

  it("the announced offer has been taken: the older ones it covered stay told", () => {
    expect(untoldOffers([o("a", 1), o("b", 2)], [o("c", 3)], sent("c"))).toEqual([]);
  });

  it("a closed offer nobody announced says nothing", () => {
    expect(ids(untoldOffers([o("a", 1)], [o("z", 9)], sent()))).toEqual(["a"]);
  });

  it("offers opened in the same instant are one batch", () => {
    expect(untoldOffers([o("a", 1), o("b", 1), o("c", 1)], [], sent("b"))).toEqual([]);
  });

  it("each offer announced on its own, the old way: all told", () => {
    expect(untoldOffers([o("a", 1), o("b", 2)], [], sent("a", "b"))).toEqual([]);
  });
});

describe("leadOffer", () => {
  it("the newest, whatever order they arrive in; the id breaks a tie", () => {
    expect(leadOffer([o("b", 2), o("c", 3), o("a", 1)])?.id).toBe("c");
    expect(leadOffer([o("b", 1), o("a", 1)])?.id).toBe("b");
  });
  it("null when there is nothing to announce", () => {
    expect(leadOffer([])).toBeNull();
  });
});
