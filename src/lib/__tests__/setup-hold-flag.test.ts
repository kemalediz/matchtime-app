/**
 * SETUP_HOLD_ENABLED's per-request test seam (go-live plan, slice S1): a
 * cookie for the organiser web and a header for the Pi's API routes, both
 * honoured only when the server was booted with MT_TEST_MODE exactly "1".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import {
  SETUP_HOLD_TEST_COOKIE,
  SETUP_HOLD_TEST_HEADER,
  setupHoldEnabledForApiRequest,
  setupHoldEnabledFrom,
} from "../setup-hold-flag";

const req = (v?: string) =>
  new Request("https://mt.test/api", { headers: v === undefined ? {} : { [SETUP_HOLD_TEST_HEADER]: v } });

describe("setupHoldEnabledFrom", () => {
  it("outside test mode the override is ignored in both directions", () => {
    expect(setupHoldEnabledFrom("1", {})).toBe(false);
    expect(setupHoldEnabledFrom("1", { MT_TEST_MODE: "true" })).toBe(false);
    expect(setupHoldEnabledFrom("0", { SETUP_HOLD_ENABLED: "1" })).toBe(true);
  });

  it("in test mode the override wins either way", () => {
    expect(setupHoldEnabledFrom("1", { MT_TEST_MODE: "1" })).toBe(true);
    expect(setupHoldEnabledFrom("0", { MT_TEST_MODE: "1", SETUP_HOLD_ENABLED: "1" })).toBe(false);
  });

  it("no override: the env var, off by default", () => {
    expect(setupHoldEnabledFrom(undefined, { MT_TEST_MODE: "1" })).toBe(false);
    expect(setupHoldEnabledFrom(undefined, { MT_TEST_MODE: "1", SETUP_HOLD_ENABLED: "on" })).toBe(true);
    expect(setupHoldEnabledFrom("maybe", { MT_TEST_MODE: "1" })).toBe(false);
  });
});

describe("setupHoldEnabledForApiRequest", () => {
  it("reads the header only in test mode", () => {
    expect(setupHoldEnabledForApiRequest(req("1"), {})).toBe(false);
    expect(setupHoldEnabledForApiRequest(req("1"), { MT_TEST_MODE: "1" })).toBe(true);
    expect(setupHoldEnabledForApiRequest(req("0"), { MT_TEST_MODE: "1", SETUP_HOLD_ENABLED: "1" })).toBe(false);
    expect(setupHoldEnabledForApiRequest(req(), { SETUP_HOLD_ENABLED: "1" })).toBe(true);
  });

  it("the names are the ones the e2e suite sends", () => {
    expect(SETUP_HOLD_TEST_HEADER).toBe("x-mt-test-setup-hold");
    expect(SETUP_HOLD_TEST_COOKIE).toBe("mt-test-setup-hold");
  });
});
