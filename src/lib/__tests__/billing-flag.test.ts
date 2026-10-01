/**
 * The web's BILLING_ENABLED (club fee billing, slice B2): the env var in
 * production; a cookie may override it ONLY under MT_TEST_MODE=1.
 */
import { describe, expect, it } from "vitest";
import { BILLING_TEST_HEADER, billingEnabledForApiRequest, billingUiEnabledFrom } from "@/lib/billing-flag";

describe("billingUiEnabledFrom", () => {
  it("production: exactly the env var, off by default", () => {
    expect(billingUiEnabledFrom(undefined, {})).toBe(false);
    expect(billingUiEnabledFrom(undefined, { BILLING_ENABLED: "1" })).toBe(true);
  });

  it("outside test mode the cookie is ignored in both directions", () => {
    expect(billingUiEnabledFrom("1", {})).toBe(false);
    expect(billingUiEnabledFrom("0", { BILLING_ENABLED: "1" })).toBe(true);
    expect(billingUiEnabledFrom("1", { MT_TEST_MODE: "true" })).toBe(false);
  });

  it("test mode: the cookie wins, either way", () => {
    expect(billingUiEnabledFrom("1", { MT_TEST_MODE: "1" })).toBe(true);
    expect(billingUiEnabledFrom("0", { MT_TEST_MODE: "1", BILLING_ENABLED: "1" })).toBe(false);
    expect(billingUiEnabledFrom(undefined, { MT_TEST_MODE: "1", BILLING_ENABLED: "1" })).toBe(true);
  });
});

describe("billingEnabledForApiRequest (slice B5, the Pi's routes)", () => {
  const req = (h?: string) => new Request("http://x", { headers: h === undefined ? {} : { [BILLING_TEST_HEADER]: h } });
  it("production: exactly the env var; the header is ignored", () => {
    expect(billingEnabledForApiRequest(req(), {})).toBe(false);
    expect(billingEnabledForApiRequest(req(), { BILLING_ENABLED: "1" })).toBe(true);
    expect(billingEnabledForApiRequest(req("1"), {})).toBe(false);
    expect(billingEnabledForApiRequest(req("0"), { BILLING_ENABLED: "1" })).toBe(true);
  });
  it("test mode: the header wins", () => {
    expect(billingEnabledForApiRequest(req("0"), { MT_TEST_MODE: "1", BILLING_ENABLED: "1" })).toBe(false);
    expect(billingEnabledForApiRequest(req("1"), { MT_TEST_MODE: "1" })).toBe(true);
  });
});

