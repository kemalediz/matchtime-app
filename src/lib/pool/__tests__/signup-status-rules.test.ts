/**
 * The /play reminder's status check, the PURE half (2026-10-31): what a
 * waiting sign-up's state is, and the per-address cap on checks.
 */
import { describe, expect, it } from "vitest";
import { POOL_SIGNUP_STATUS } from "../rules";
import { poolSignupState, takeStatusCheck } from "../signup-status-rules";

const NOW = new Date("2026-10-31T12:00:00Z");
const LATER = new Date("2026-11-02T12:00:00Z");
const EARLIER = new Date("2026-10-31T11:00:00Z");

describe("poolSignupState", () => {
  it("no such sign-up: gone", () => expect(poolSignupState(null, "ABCDE", NOW)).toBe("gone"));
  it("still waiting, code right and not run out: waiting", () =>
    expect(poolSignupState({ status: "pending-verify", confirmCode: "ABCDE", confirmCodeExpiresAt: LATER }, "ABCDE", NOW)).toBe("waiting"));
  it("the code has run out: gone", () =>
    expect(poolSignupState({ status: "pending-verify", confirmCode: "ABCDE", confirmCodeExpiresAt: EARLIER }, "ABCDE", NOW)).toBe("gone"));
  it("exactly at expiry: gone", () =>
    expect(poolSignupState({ status: "pending-verify", confirmCode: "ABCDE", confirmCodeExpiresAt: NOW }, "ABCDE", NOW)).toBe("gone"));
  it("a different code on the row: gone", () =>
    expect(poolSignupState({ status: "pending-verify", confirmCode: "ZZZZZ", confirmCodeExpiresAt: LATER }, "ABCDE", NOW)).toBe("gone"));
  it("no expiry recorded: gone", () =>
    expect(poolSignupState({ status: "pending-verify", confirmCode: "ABCDE", confirmCodeExpiresAt: null }, "ABCDE", NOW)).toBe("gone"));
  for (const status of ["active", "paused", "stopped"]) {
    it(`confirmed (${status}, code cleared): done`, () =>
      expect(poolSignupState({ status, confirmCode: null, confirmCodeExpiresAt: null }, "ABCDE", NOW)).toBe("done"));
  }
});

describe("takeStatusCheck: at most POOL_SIGNUP_STATUS.perIpPerHour checks an hour", () => {
  const t0 = NOW.getTime();
  it("the cap is a real number", () => expect(POOL_SIGNUP_STATUS.perIpPerHour).toBeGreaterThanOrEqual(10));
  it("allows up to the cap, refuses the next", () => {
    let hits: number[] = [];
    for (let i = 0; i < POOL_SIGNUP_STATUS.perIpPerHour; i++) {
      const r = takeStatusCheck(hits, t0 + i);
      expect(r.ok).toBe(true);
      hits = r.hits;
    }
    const over = takeStatusCheck(hits, t0 + 1000);
    expect(over.ok).toBe(false);
    expect(over.hits).toHaveLength(POOL_SIGNUP_STATUS.perIpPerHour);
  });
  it("an hour later the old checks no longer count", () => {
    const full = Array.from({ length: POOL_SIGNUP_STATUS.perIpPerHour }, (_, i) => t0 + i);
    const r = takeStatusCheck(full, t0 + 3600_000 + POOL_SIGNUP_STATUS.perIpPerHour);
    expect(r.ok).toBe(true);
    expect(r.hits).toHaveLength(1);
  });
});
