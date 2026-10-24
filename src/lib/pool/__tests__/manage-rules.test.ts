/**
 * The manage page's switches (slice L2): what each one does to a profile's
 * state, pure. The CHECKs in prisma/sql/pool-check.sql say a paused profile
 * says why and since when, and a stopped one since when; every patch here
 * leaves a row those CHECKs accept.
 */
import { describe, expect, it } from "vitest";
import { POOL_CONSENT_VERSION } from "../rules";
import { manageTransition, canEraseUser } from "../manage-rules";

const NOW = new Date("2026-10-24T12:00:00Z");
const active = { status: "active", pausedReason: null } as const;

describe("pause and resume", () => {
  it("an active profile pauses itself", () => {
    expect(manageTransition({ action: "pause", profile: active, now: NOW })).toEqual({
      ok: true,
      patch: { status: "paused", pausedReason: "self", pausedAt: NOW, lastActiveAt: NOW },
    });
  });

  it("only an active profile pauses", () => {
    expect(manageTransition({ action: "pause", profile: { status: "stopped", pausedReason: null }, now: NOW })).toEqual({ ok: false, reason: "not-active" });
  });

  it("resumes his own pause and the 3-ignored pause (the spec: until he says he wants more)", () => {
    for (const reason of ["self", "ignored"] as const) {
      expect(manageTransition({ action: "resume", profile: { status: "paused", pausedReason: reason }, now: NOW })).toEqual({
        ok: true,
        patch: { status: "active", pausedReason: null, pausedAt: null, lastActiveAt: NOW },
      });
    }
  });

  it("never lifts a pause someone else decided (no-shows, reports, the owner)", () => {
    for (const reason of ["no-shows", "reports", "admin"] as const) {
      expect(manageTransition({ action: "resume", profile: { status: "paused", pausedReason: reason }, now: NOW })).toEqual({ ok: false, reason: "paused-by-matchtime" });
    }
  });
});

describe("stop offers and start again", () => {
  it("stop withdraws consent from active or paused", () => {
    for (const profile of [active, { status: "paused", pausedReason: "self" } as const]) {
      expect(manageTransition({ action: "stop", profile, now: NOW })).toEqual({
        ok: true,
        patch: { status: "stopped", stoppedAt: NOW, pausedReason: null, pausedAt: null, lastActiveAt: NOW },
      });
    }
  });

  it("start again needs the consent ticked, and records it as a web consent with its evidence", () => {
    const stopped = { status: "stopped", pausedReason: null } as const;
    expect(manageTransition({ action: "restart", profile: stopped, now: NOW, consent: false })).toEqual({ ok: false, reason: "consent-required" });
    expect(manageTransition({ action: "restart", profile: stopped, now: NOW, consent: true, evidence: "web:u1:123" })).toEqual({
      ok: true,
      patch: {
        status: "active",
        stoppedAt: null,
        consentAt: NOW,
        consentVersion: POOL_CONSENT_VERSION,
        consentChannel: "web",
        consentEvidence: "web:u1:123",
        lastActiveAt: NOW,
      },
    });
    expect(manageTransition({ action: "restart", profile: active, now: NOW, consent: true, evidence: "x" })).toEqual({ ok: false, reason: "not-stopped" });
  });

  it("a waiting sign-up has no switches yet", () => {
    for (const action of ["pause", "resume", "stop", "restart"] as const) {
      expect(manageTransition({ action, profile: { status: "pending-verify", pausedReason: null }, now: NOW, consent: true, evidence: "x" }).ok).toBe(false);
    }
  });
});

describe("delete: the User row goes too only when he has no club and no history", () => {
  it("a pool-only person is erased whole", () => {
    expect(canEraseUser({ memberships: 0, attendances: 0, guestPlaces: 0, isSuperadmin: false })).toBe(true);
  });
  it("a member, an ex-member, a past guest or a player with history keeps his User", () => {
    expect(canEraseUser({ memberships: 1, attendances: 0, guestPlaces: 0, isSuperadmin: false })).toBe(false);
    expect(canEraseUser({ memberships: 0, attendances: 3, guestPlaces: 0, isSuperadmin: false })).toBe(false);
    expect(canEraseUser({ memberships: 0, attendances: 0, guestPlaces: 1, isSuperadmin: false })).toBe(false);
    expect(canEraseUser({ memberships: 0, attendances: 0, guestPlaces: 0, isSuperadmin: true })).toBe(false);
  });
});
