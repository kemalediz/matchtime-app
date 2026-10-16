/**
 * Partner clubs, the pure rules (cross-club ask, slice S1).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.1 and 3.2.
 *
 * One row per direction; the platform owner creates it; each club's OWNER
 * accepts; active once both have; either side pauses, only the pauser
 * resumes; the partner side alone sets how its organisers approve.
 */
import { describe, expect, it } from "vitest";
import {
  PARTNER_ASK_CUTOFF_DEFAULT_HOURS,
  PARTNER_ASK_CUTOFF_MAX_HOURS,
  PARTNER_ASK_CUTOFF_MIN_HOURS,
  PARTNER_ASK_TIME_DEFAULT,
  effectiveAskTime,
  normalisePartnerAskWhen,
  parseAskTime,
  parseCutoffHours,
  parsePartnerApproval,
  parsePartnerAskWhen,
  planCreate,
  planPartnershipAction,
  sideOf,
  type PartnershipRow,
} from "../club-partnership-rules";

const NOW = new Date("2026-10-16T12:00:00Z");
const row = (over: Partial<PartnershipRow> = {}): PartnershipRow => ({
  askerOrgId: "fnf",
  partnerOrgId: "sutton",
  status: "proposed",
  askerAcceptedAt: null,
  partnerAcceptedAt: null,
  pausedByOrgId: null,
  ...over,
});

describe("settings values", () => {
  it("when to ask: off, on request, automatically; anything else reads off and is refused on save", () => {
    expect(normalisePartnerAskWhen("auto")).toBe("auto");
    expect(normalisePartnerAskWhen("on-request")).toBe("on-request");
    expect(normalisePartnerAskWhen("nonsense")).toBe("off");
    expect(normalisePartnerAskWhen(null)).toBe("off");
    expect(parsePartnerAskWhen("off")).toBe("off");
    expect(parsePartnerAskWhen("sometimes")).toBeNull();
  });

  it("the cut-off is whole hours from 1 to 24, default 4", () => {
    expect(PARTNER_ASK_CUTOFF_DEFAULT_HOURS).toBe(4);
    expect(PARTNER_ASK_CUTOFF_MIN_HOURS).toBe(1);
    expect(PARTNER_ASK_CUTOFF_MAX_HOURS).toBe(24);
    expect(parseCutoffHours(4)).toBe(4);
    expect(parseCutoffHours("6")).toBe(6);
    expect(parseCutoffHours(0)).toBeNull();
    expect(parseCutoffHours(25)).toBeNull();
    expect(parseCutoffHours(2.5)).toBeNull();
    expect(parseCutoffHours("x")).toBeNull();
  });

  it("the automatic time is a London HH:MM, zero padded; not set reads 16:00", () => {
    expect(parseAskTime("9:30")).toBe("09:30");
    expect(parseAskTime("16:00")).toBe("16:00");
    expect(parseAskTime("24:00")).toBeNull();
    expect(parseAskTime("off")).toBeNull();
    expect(PARTNER_ASK_TIME_DEFAULT).toBe("16:00");
    expect(effectiveAskTime(null)).toBe("16:00");
    expect(effectiveAskTime("bad")).toBe("16:00");
    expect(effectiveAskTime("17:15")).toBe("17:15");
  });

  it("partner approval: each ask or standing", () => {
    expect(parsePartnerApproval("each-ask")).toBe("each-ask");
    expect(parsePartnerApproval("standing")).toBe("standing");
    expect(parsePartnerApproval("always")).toBeNull();
  });
});

describe("sides", () => {
  it("knows which side a club is on, or none", () => {
    expect(sideOf(row(), "fnf")).toBe("asker");
    expect(sideOf(row(), "sutton")).toBe("partner");
    expect(sideOf(row(), "other")).toBeNull();
  });
});

describe("creating a pairing (the platform owner)", () => {
  it("one row per direction: a new pair is created", () => {
    expect(planCreate(null, "fnf", "sutton")).toEqual({ ok: true, mode: "create" });
  });
  it("a club is never its own partner", () => {
    expect(planCreate(null, "fnf", "fnf")).toEqual({ ok: false, refusal: "same-club" });
  });
  it("a pair that exists and has not ended is not created twice", () => {
    expect(planCreate(row({ status: "active" }), "fnf", "sutton")).toEqual({ ok: false, refusal: "exists" });
    expect(planCreate(row({ status: "paused" }), "fnf", "sutton")).toEqual({ ok: false, refusal: "exists" });
  });
  it("an ended pair is proposed again, both acceptances needed afresh", () => {
    expect(planCreate(row({ status: "ended" }), "fnf", "sutton")).toEqual({ ok: true, mode: "reopen" });
  });
});

describe("accepting", () => {
  it("an OWNER accepts for its own side; still proposed until the other side accepts", () => {
    const r = planPartnershipAction(row(), { orgId: "fnf", role: "OWNER", action: "accept", userId: "u1", now: NOW });
    expect(r).toEqual({ ok: true, patch: { askerAcceptedAt: NOW, askerAcceptedBy: "u1" } });
  });
  it("the second acceptance makes it active", () => {
    const r = planPartnershipAction(row({ askerAcceptedAt: NOW }), { orgId: "sutton", role: "OWNER", action: "accept", userId: "u2", now: NOW });
    expect(r).toEqual({ ok: true, patch: { partnerAcceptedAt: NOW, partnerAcceptedBy: "u2", status: "active" } });
  });
  it("an ADMIN or PLAYER cannot accept: owners only", () => {
    expect(planPartnershipAction(row(), { orgId: "fnf", role: "ADMIN", action: "accept", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "owner-only" });
    expect(planPartnershipAction(row(), { orgId: "fnf", role: "PLAYER", action: "accept", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "owner-only" });
  });
  it("a club that is neither side can do nothing", () => {
    expect(planPartnershipAction(row(), { orgId: "x", role: "OWNER", action: "accept", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "not-a-side" });
  });
  it("accepting twice is refused", () => {
    expect(planPartnershipAction(row({ askerAcceptedAt: NOW }), { orgId: "fnf", role: "OWNER", action: "accept", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "already-accepted" });
  });
  it("only a proposed pair is accepted", () => {
    expect(planPartnershipAction(row({ status: "ended" }), { orgId: "fnf", role: "OWNER", action: "accept", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "ended" });
    expect(planPartnershipAction(row({ status: "active" }), { orgId: "fnf", role: "OWNER", action: "accept", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "not-proposed" });
  });
});

describe("declining, pausing, resuming, removing", () => {
  it("an owner of either side declines a proposed pair: it ends", () => {
    expect(planPartnershipAction(row(), { orgId: "sutton", role: "OWNER", action: "decline", userId: "u", now: NOW })).toEqual({ ok: true, patch: { status: "ended", pausedByOrgId: null } });
    expect(planPartnershipAction(row(), { orgId: "sutton", role: "ADMIN", action: "decline", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "owner-only" });
  });
  it("either side's owner or admin pauses an active pair", () => {
    const active = row({ status: "active", askerAcceptedAt: NOW, partnerAcceptedAt: NOW });
    expect(planPartnershipAction(active, { orgId: "sutton", role: "ADMIN", action: "pause", userId: "u", now: NOW })).toEqual({ ok: true, patch: { status: "paused", pausedByOrgId: "sutton" } });
    expect(planPartnershipAction(active, { orgId: "fnf", role: "PLAYER", action: "pause", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "admin-only" });
    expect(planPartnershipAction(row(), { orgId: "fnf", role: "OWNER", action: "pause", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "not-active" });
  });
  it("only the side that paused resumes", () => {
    const paused = row({ status: "paused", pausedByOrgId: "sutton", askerAcceptedAt: NOW, partnerAcceptedAt: NOW });
    expect(planPartnershipAction(paused, { orgId: "fnf", role: "OWNER", action: "resume", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "paused-by-other" });
    expect(planPartnershipAction(paused, { orgId: "sutton", role: "ADMIN", action: "resume", userId: "u", now: NOW })).toEqual({ ok: true, patch: { status: "active", pausedByOrgId: null } });
    expect(planPartnershipAction(row({ status: "active" }), { orgId: "sutton", role: "OWNER", action: "resume", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "not-paused" });
  });
  it("an owner of either side removes it at any stage; an ended pair cannot be removed again", () => {
    expect(planPartnershipAction(row({ status: "paused", pausedByOrgId: "fnf" }), { orgId: "sutton", role: "OWNER", action: "end", userId: "u", now: NOW })).toEqual({ ok: true, patch: { status: "ended", pausedByOrgId: null } });
    expect(planPartnershipAction(row({ status: "active" }), { orgId: "sutton", role: "ADMIN", action: "end", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "owner-only" });
    expect(planPartnershipAction(row({ status: "ended" }), { orgId: "sutton", role: "OWNER", action: "end", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "ended" });
  });
});
