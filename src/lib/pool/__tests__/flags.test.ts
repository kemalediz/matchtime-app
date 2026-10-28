/**
 * The pool's switches (slice L1; the platform switch a database row since
 * 2026-10-28, decision log P.1). The platform switch is read per request
 * and carried in the call's env (`POOL_OPEN_KEY`); POOL_OFFERS_ENABLED can
 * only force it OFF.
 */
import { describe, expect, it } from "vitest";
import {
  POOL_OFFERS_ENV,
  POOL_OPEN_KEY,
  POOL_SIGNUP_PAUSED_ENV,
  POOL_SWITCH_UNREAD_KEY,
  isPoolOffersEnabled,
  isPoolSignupPaused,
  poolForcedOffByEnv,
  poolOffersOpenForClub,
  poolOpenForClub,
  poolOpenFrom,
  poolPlatformOpen,
  poolSwitchEnv,
  poolSwitchUnread,
  signupGoesOnEarlyList,
  signupGoesOnEarlyListFrom,
} from "../flags";
import { POOL_OPEN_TEST_COOKIE, POOL_OPEN_TEST_HEADER, poolTestOverrideOf } from "../flags-request";

describe("the platform switch", () => {
  it("is the database row; the env var can only force it off", () => {
    expect(POOL_OFFERS_ENV).toBe("POOL_OFFERS_ENABLED");
    expect(poolPlatformOpen(true, {})).toBe(true);
    expect(poolPlatformOpen(false, {})).toBe(false);
    // Today's production value "1" leaves the row in charge, both ways.
    expect(poolPlatformOpen(true, { POOL_OFFERS_ENABLED: "1" })).toBe(true);
    expect(poolPlatformOpen(false, { POOL_OFFERS_ENABLED: "1" })).toBe(false);
    for (const off of ["0", "false", "OFF", " no "]) {
      expect(poolForcedOffByEnv({ POOL_OFFERS_ENABLED: off }), off).toBe(true);
      expect(poolPlatformOpen(true, { POOL_OFFERS_ENABLED: off }), off).toBe(false);
    }
    for (const neutral of [undefined, "", "1", "yes", "nope"]) expect(poolForcedOffByEnv({ POOL_OFFERS_ENABLED: neutral }), String(neutral)).toBe(false);
  });

  it("travels in the call's env, and a call that never resolved it reads CLOSED", () => {
    expect(POOL_OPEN_KEY).toBe("MT_POOL_OPEN");
    expect(isPoolOffersEnabled(poolSwitchEnv(true))).toBe(true);
    expect(isPoolOffersEnabled(poolSwitchEnv(false))).toBe(false);
    // Plain process.env (or the old env var on its own) is never "open".
    expect(isPoolOffersEnabled({})).toBe(false);
    expect(isPoolOffersEnabled({ POOL_OFFERS_ENABLED: "1" })).toBe(false);
    expect(poolSwitchEnv(true, { A: "b" })).toEqual({ A: "b", MT_POOL_OPEN: "1" });
  });

  it("a switch that could not be read, or was never resolved, is UNREAD (hold, never close)", () => {
    expect(poolSwitchUnread({ [POOL_SWITCH_UNREAD_KEY]: "1" })).toBe(true);
    expect(poolSwitchUnread(undefined)).toBe(true);
    expect(poolSwitchUnread({})).toBe(true);
    expect(poolSwitchUnread({ POOL_OFFERS_ENABLED: "1" })).toBe(true);
    expect(poolSwitchUnread(poolSwitchEnv(false))).toBe(false);
    expect(poolSwitchUnread(poolSwitchEnv(true))).toBe(false);
  });
});

describe("THE ONE RULE: a club may use the pool only with both switches on", () => {
  it("the platform switch AND the club's own flag", () => {
    expect(poolOpenForClub({ featurePlayerPool: true }, true)).toBe(true);
    expect(poolOpenForClub({ featurePlayerPool: false }, true)).toBe(false);
    expect(poolOpenForClub({ featurePlayerPool: true }, false)).toBe(false);
    expect(poolOpenForClub(null, true)).toBe(false);
  });

  it("with the switch as a call resolved it", () => {
    const on = poolSwitchEnv(true);
    expect(poolOffersOpenForClub({ featurePlayerPool: true }, on)).toBe(true);
    expect(poolOffersOpenForClub({ featurePlayerPool: false }, on)).toBe(false);
    expect(poolOffersOpenForClub({ featurePlayerPool: true }, poolSwitchEnv(false))).toBe(false);
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

  it("goes on the early sign-up list while the pool is not open", () => {
    expect(signupGoesOnEarlyList({})).toBe(true);
    expect(signupGoesOnEarlyList(poolSwitchEnv(true))).toBe(false);
  });

  it("the pages ask the same switch, with the test seam only under MT_TEST_MODE=1", () => {
    expect(signupGoesOnEarlyListFrom(undefined, false, {})).toBe(true);
    expect(signupGoesOnEarlyListFrom(undefined, true, {})).toBe(false);
    expect(signupGoesOnEarlyListFrom("1", false, { MT_TEST_MODE: "1" })).toBe(false);
    expect(signupGoesOnEarlyListFrom("0", true, { MT_TEST_MODE: "1" })).toBe(true);
    expect(signupGoesOnEarlyListFrom("1", false, {})).toBe(true);
  });
});

describe("the test seam for the pool being open", () => {
  it("is honoured only under MT_TEST_MODE=1, in both directions", () => {
    expect(poolOpenFrom("1", false, { MT_TEST_MODE: "1" })).toBe(true);
    expect(poolOpenFrom("0", true, { MT_TEST_MODE: "1" })).toBe(false);
    expect(poolOpenFrom("1", false, {})).toBe(false);
    expect(poolOpenFrom("0", true, {})).toBe(true);
    expect(poolOpenFrom(undefined, false, { MT_TEST_MODE: "1" })).toBe(false);
    expect(poolOpenFrom(undefined, true, { MT_TEST_MODE: "1" })).toBe(true);
  });
});

describe("poolTestOverrideOf reads the seam off a header or the cookie", () => {
  const req = (headers: Record<string, string>) => new Request("http://x.test/api/play/signup", { headers });
  it("header, cookie, or neither; nothing outside test mode", () => {
    const test = { MT_TEST_MODE: "1" };
    expect(poolTestOverrideOf(req({ [POOL_OPEN_TEST_HEADER]: "1" }), test)).toBe("1");
    expect(poolTestOverrideOf(req({ cookie: `a=b; ${POOL_OPEN_TEST_COOKIE}=0` }), test)).toBe("0");
    expect(poolTestOverrideOf(req({}), test)).toBeUndefined();
    expect(poolTestOverrideOf(req({ [POOL_OPEN_TEST_HEADER]: "1" }), {})).toBeUndefined();
  });
});
