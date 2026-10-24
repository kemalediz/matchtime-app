/**
 * The pool's switches (slice L1). Decision log #2: every pool feature ships
 * behind a per-club flag that is OFF, and one global switch, also OFF.
 */
import { describe, expect, it } from "vitest";
import {
  POOL_OFFERS_ENV,
  POOL_SIGNUP_PAUSED_ENV,
  isPoolOffersEnabled,
  isPoolSignupPaused,
  poolOffersOpenForClub,
  poolOpenFrom,
  signupGoesOnEarlyList,
} from "../flags";
import { POOL_OPEN_TEST_COOKIE, POOL_OPEN_TEST_HEADER, poolOpenForApiRequest } from "../flags-request";

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

describe("sign-up (slice L2)", () => {
  it("is open unless POOL_SIGNUP_PAUSED is explicitly on (the abuse brake)", () => {
    expect(POOL_SIGNUP_PAUSED_ENV).toBe("POOL_SIGNUP_PAUSED");
    expect(isPoolSignupPaused({})).toBe(false);
    expect(isPoolSignupPaused({ POOL_SIGNUP_PAUSED: "0" })).toBe(false);
    for (const on of ["1", "true", "on", "YES"]) expect(isPoolSignupPaused({ POOL_SIGNUP_PAUSED: on }), on).toBe(true);
  });

  it("goes on the early sign-up list while the pool is not open (the global switch off)", () => {
    expect(signupGoesOnEarlyList({})).toBe(true);
    expect(signupGoesOnEarlyList({ POOL_OFFERS_ENABLED: "1" })).toBe(false);
  });
});

describe("the test seam for the pool being open", () => {
  it("is honoured only under MT_TEST_MODE=1, in both directions", () => {
    expect(poolOpenFrom("1", { MT_TEST_MODE: "1" })).toBe(true);
    expect(poolOpenFrom("0", { MT_TEST_MODE: "1", POOL_OFFERS_ENABLED: "1" })).toBe(false);
    expect(poolOpenFrom("1", {})).toBe(false);
    expect(poolOpenFrom("0", { POOL_OFFERS_ENABLED: "1" })).toBe(true);
    expect(poolOpenFrom(undefined, { MT_TEST_MODE: "1" })).toBe(false);
  });
});

describe("poolOpenForApiRequest reads the seam off a header or the cookie", () => {
  const req = (headers: Record<string, string>) => new Request("http://x.test/api/play/signup", { headers });
  it("header, cookie, or neither", () => {
    const test = { MT_TEST_MODE: "1" };
    expect(poolOpenForApiRequest(req({ [POOL_OPEN_TEST_HEADER]: "1" }), test)).toBe(true);
    expect(poolOpenForApiRequest(req({ cookie: `a=b; ${POOL_OPEN_TEST_COOKIE}=1` }), test)).toBe(true);
    expect(poolOpenForApiRequest(req({}), test)).toBe(false);
    expect(poolOpenForApiRequest(req({ [POOL_OPEN_TEST_HEADER]: "1" }), {})).toBe(false);
  });
});
