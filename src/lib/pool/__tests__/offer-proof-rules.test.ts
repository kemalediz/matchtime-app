import { describe, expect, it } from "vitest";
import { POOL_OFFER_PROOF, digitsAnswer, digitsMatch, proofCookieName } from "../offer-proof-rules";

describe("the last 4 digits (review of #400, M2)", () => {
  it("match the last four of his number, whatever its format", () => {
    expect(digitsMatch("+447700900123", "0123")).toBe(true);
    expect(digitsMatch("447700900123", " 0123 ")).toBe(true);
    expect(digitsMatch("+447700900123", "9012")).toBe(false);
  });
  it("anything not exactly four digits never matches", () => {
    for (const d of ["123", "12345", "01a3", "", null, undefined, 123]) expect(digitsMatch("+447700900123", d)).toBe(false);
    expect(digitsMatch(null, "0123")).toBe(false);
  });
  it("five wrong tries in a day lock the digits, even a right one after", () => {
    expect(digitsAnswer({ match: true, wrongToday: 0 })).toBe("ok");
    expect(digitsAnswer({ match: false, wrongToday: 4 })).toBe("wrong");
    expect(digitsAnswer({ match: true, wrongToday: POOL_OFFER_PROOF.wrongPerOfferPerDay })).toBe("locked");
  });
  it("one cookie per offer", () => {
    expect(proofCookieName("o1")).toBe("mt-pool-offer-o1");
  });
});
