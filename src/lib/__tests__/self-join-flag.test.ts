/**
 * The request-aware SELF_JOIN_ENABLED reader the organiser web uses.
 *
 * Production reads the env var and nothing else. The e2e suite needs
 * the flag ON for the organiser specs and OFF for the "unchanged" specs
 * from ONE dev server, so a cookie may override it, but only when the
 * server was booted with MT_TEST_MODE=1 (set by e2e/helpers/env.ts and
 * nowhere else), the same double gate as the other test seams.
 */
import { describe, expect, it } from "vitest";
import {
  SELF_JOIN_TEST_COOKIE,
  SELF_JOIN_TEST_HEADER,
  selfJoinEnabledForApiRequest,
  selfJoinEnabledFrom,
} from "../self-join-flag";

describe("selfJoinEnabledFrom", () => {
  it("is the env flag, off by default", () => {
    expect(selfJoinEnabledFrom(undefined, {})).toBe(false);
    expect(selfJoinEnabledFrom(undefined, { SELF_JOIN_ENABLED: "1" })).toBe(true);
    expect(selfJoinEnabledFrom(undefined, { SELF_JOIN_ENABLED: "0" })).toBe(false);
  });

  it("the test cookie is IGNORED outside test mode, in both directions", () => {
    expect(selfJoinEnabledFrom("1", {})).toBe(false);
    expect(selfJoinEnabledFrom("0", { SELF_JOIN_ENABLED: "1" })).toBe(true);
    expect(selfJoinEnabledFrom("1", { MT_TEST_MODE: "true" })).toBe(false);
  });

  it("in test mode the cookie decides; anything unrecognised falls back to the env", () => {
    expect(selfJoinEnabledFrom("1", { MT_TEST_MODE: "1" })).toBe(true);
    expect(selfJoinEnabledFrom("0", { MT_TEST_MODE: "1", SELF_JOIN_ENABLED: "1" })).toBe(false);
    expect(selfJoinEnabledFrom("maybe", { MT_TEST_MODE: "1" })).toBe(false);
    expect(selfJoinEnabledFrom(undefined, { MT_TEST_MODE: "1", SELF_JOIN_ENABLED: "1" })).toBe(true);
  });

  it("names its cookie", () => {
    expect(SELF_JOIN_TEST_COOKIE).toBe("mt-test-self-join");
  });
});

describe("selfJoinEnabledForApiRequest (the Pi's routes, slice 5)", () => {
  const req = (h?: string) =>
    new Request("http://x/api/whatsapp/dm-reply", { headers: h === undefined ? {} : { [SELF_JOIN_TEST_HEADER]: h } });

  it("is the env flag, and the test header is ignored outside test mode", () => {
    expect(selfJoinEnabledForApiRequest(req(), {})).toBe(false);
    expect(selfJoinEnabledForApiRequest(req(), { SELF_JOIN_ENABLED: "1" })).toBe(true);
    expect(selfJoinEnabledForApiRequest(req("1"), {})).toBe(false);
    expect(selfJoinEnabledForApiRequest(req("0"), { SELF_JOIN_ENABLED: "1" })).toBe(true);
  });

  it("in test mode the header decides", () => {
    expect(selfJoinEnabledForApiRequest(req("1"), { MT_TEST_MODE: "1" })).toBe(true);
    expect(selfJoinEnabledForApiRequest(req("0"), { MT_TEST_MODE: "1", SELF_JOIN_ENABLED: "1" })).toBe(false);
    expect(selfJoinEnabledForApiRequest(req(), { MT_TEST_MODE: "1" })).toBe(false);
  });

  it("names its header", () => {
    expect(SELF_JOIN_TEST_HEADER).toBe("x-mt-test-self-join");
  });
});
