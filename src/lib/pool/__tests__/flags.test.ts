/**
 * The pool's switches (slice L1). Decision log #2: every pool feature ships
 * behind a per-club flag that is OFF, and one global switch, also OFF.
 */
import { describe, expect, it } from "vitest";
import { POOL_OFFERS_ENV, isPoolOffersEnabled, poolOffersOpenForClub } from "../flags";

describe("the global switch", () => {
  it("is POOL_OFFERS_ENABLED, off unless explicitly on", () => {
    expect(POOL_OFFERS_ENV).toBe("POOL_OFFERS_ENABLED");
    expect(isPoolOffersEnabled({})).toBe(false);
    expect(isPoolOffersEnabled({ POOL_OFFERS_ENABLED: "" })).toBe(false);
    expect(isPoolOffersEnabled({ POOL_OFFERS_ENABLED: "0" })).toBe(false);
    expect(isPoolOffersEnabled({ POOL_OFFERS_ENABLED: "nope" })).toBe(false);
    for (const on of ["1", "true", "ON", " yes "]) expect(isPoolOffersEnabled({ POOL_OFFERS_ENABLED: on }), on).toBe(true);
  });
});

describe("a club may ask the pool only with both switches on", () => {
  const on = { POOL_OFFERS_ENABLED: "1" };
  it("needs the club's own flag and the global switch", () => {
    expect(poolOffersOpenForClub({ featurePlayerPool: true }, on)).toBe(true);
    expect(poolOffersOpenForClub({ featurePlayerPool: false }, on)).toBe(false);
    expect(poolOffersOpenForClub({ featurePlayerPool: true }, {})).toBe(false);
    expect(poolOffersOpenForClub(null, on)).toBe(false);
  });
});
