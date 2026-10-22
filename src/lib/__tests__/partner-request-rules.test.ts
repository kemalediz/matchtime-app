/**
 * Partner requests, the pure rules (partner discovery, slice P3, 2026-10-22).
 * Plan: MDs/partner-discovery-plan-2026-10-21.md, sections 3.1 to 3.5 and 9.
 *
 *   - `planRequest`: every refusal (20 a London day, 50 pending, the 30-day
 *     wait after the other club declined or ended, a block either way,
 *     already paired or pending, the own and the other club's "Let nearby
 *     clubs find us" switch, owners and admins only), and create or reopen;
 *   - the request's acceptance turns it active in ONE step, with the
 *     partner's per-ask choice (default "post without asking");
 *   - withdraw (the asking side, pending only), and expiry after 14 days.
 */
import { describe, expect, it } from "vitest";
import {
  PARTNER_REQUESTS_PENDING_MAX,
  PARTNER_REQUESTS_PER_DAY,
  PARTNER_REQUEST_COOLDOWN_MS,
  PARTNER_REQUEST_EXPIRES_MS,
  REQUEST_DEFAULT_APPROVAL,
  canBlock,
  cooldownUntil,
  planPartnershipAction,
  planRequest,
  requestExpired,
  type RequestFacts,
} from "../club-partnership-rules";

const NOW = new Date("2026-10-22T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const facts = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  askerOrgId: "fnf",
  partnerOrgId: "sutton",
  role: "ADMIN",
  askerDiscoverable: true,
  partner: { approved: true, discoverable: true },
  theyMayAskUs: false,
  existing: null,
  blocked: false,
  sentToday: 0,
  pending: 0,
  now: NOW,
  ...over,
});

describe("the limits (D-4, Kemal 2026-10-22)", () => {
  it("20 new requests a London day, 50 pending, 14 days to answer, 30 days' wait", () => {
    expect(PARTNER_REQUESTS_PER_DAY).toBe(20);
    expect(PARTNER_REQUESTS_PENDING_MAX).toBe(50);
    expect(PARTNER_REQUEST_EXPIRES_MS).toBe(14 * DAY);
    expect(PARTNER_REQUEST_COOLDOWN_MS).toBe(30 * DAY);
  });
  it("a pairing made by a request posts the asks without asking by default", () => {
    expect(REQUEST_DEFAULT_APPROVAL).toBe("standing");
  });
});

describe("planRequest", () => {
  it("a first request: create", () => {
    expect(planRequest(facts())).toEqual({ ok: true, mode: "create" });
  });
  it("an owner sends too; a player cannot", () => {
    expect(planRequest(facts({ role: "OWNER" }))).toEqual({ ok: true, mode: "create" });
    expect(planRequest(facts({ role: "PLAYER" }))).toEqual({ ok: false, refusal: "not-admin" });
  });
  it("never to itself", () => {
    expect(planRequest(facts({ partnerOrgId: "fnf" }))).toEqual({ ok: false, refusal: "same-club" });
  });
  it("the other club must exist and be approved", () => {
    expect(planRequest(facts({ partner: null }))).toEqual({ ok: false, refusal: "no-club" });
    expect(planRequest(facts({ partner: { approved: false, discoverable: true } }))).toEqual({ ok: false, refusal: "no-club" });
  });
  it("a block either way refuses it", () => {
    expect(planRequest(facts({ blocked: true }))).toEqual({ ok: false, refusal: "blocked" });
  });
  it("the other club switched 'Let nearby clubs find us' off: refused", () => {
    expect(planRequest(facts({ partner: { approved: true, discoverable: false } }))).toEqual({ ok: false, refusal: "not-listed" });
  });
  it("our own switch is off: refused (D-3: no club browses others while showing nothing of itself)", () => {
    expect(planRequest(facts({ askerDiscoverable: false }))).toEqual({ ok: false, refusal: "hidden" });
  });
  it("the one-tap 'ask them too' (D-1): a club that may already ask us is asked whatever either switch says", () => {
    expect(planRequest(facts({ theyMayAskUs: true, askerDiscoverable: false, partner: { approved: true, discoverable: false } }))).toEqual({
      ok: true,
      mode: "create",
    });
    // A block still wins.
    expect(planRequest(facts({ theyMayAskUs: true, blocked: true }))).toEqual({ ok: false, refusal: "blocked" });
  });
  it("already pending, or already paired (active or paused)", () => {
    expect(planRequest(facts({ existing: { status: "proposed", endReason: null, endedAt: null, endedByOrgId: null } }))).toEqual({ ok: false, refusal: "already-pending" });
    expect(planRequest(facts({ existing: { status: "active", endReason: null, endedAt: null, endedByOrgId: null } }))).toEqual({ ok: false, refusal: "already-paired" });
    expect(planRequest(facts({ existing: { status: "paused", endReason: null, endedAt: null, endedByOrgId: null } }))).toEqual({ ok: false, refusal: "already-paired" });
  });
  it("within 30 days of the other club declining: refused; after 30 days: reopened", () => {
    const declined = (daysAgo: number) => ({ status: "ended", endReason: "declined", endedAt: new Date(NOW.getTime() - daysAgo * DAY), endedByOrgId: "sutton" });
    expect(planRequest(facts({ existing: declined(29) }))).toEqual({ ok: false, refusal: "cooldown" });
    expect(planRequest(facts({ existing: declined(30) }))).toEqual({ ok: true, mode: "reopen" });
  });
  it("within 30 days of the other club ENDING it: refused; ended by us, withdrawn or expired: no wait", () => {
    const ended = (by: string | null, reason: string) => ({ status: "ended", endReason: reason, endedAt: new Date(NOW.getTime() - DAY), endedByOrgId: by });
    expect(planRequest(facts({ existing: ended("sutton", "ended") }))).toEqual({ ok: false, refusal: "cooldown" });
    expect(planRequest(facts({ existing: ended("fnf", "ended") }))).toEqual({ ok: true, mode: "reopen" });
    expect(planRequest(facts({ existing: ended("fnf", "withdrawn") }))).toEqual({ ok: true, mode: "reopen" });
    expect(planRequest(facts({ existing: ended(null, "expired") }))).toEqual({ ok: true, mode: "reopen" });
    // The platform owner's end is not the other club's.
    expect(planRequest(facts({ existing: ended(null, "ended") }))).toEqual({ ok: true, mode: "reopen" });
  });
  it("50 pending: refused; 49: sent", () => {
    expect(planRequest(facts({ pending: 50 }))).toEqual({ ok: false, refusal: "pending-cap" });
    expect(planRequest(facts({ pending: 49 }))).toEqual({ ok: true, mode: "create" });
  });
  it("20 sent today: refused; 19: sent", () => {
    expect(planRequest(facts({ sentToday: 20 }))).toEqual({ ok: false, refusal: "daily-cap" });
    expect(planRequest(facts({ sentToday: 19 }))).toEqual({ ok: true, mode: "create" });
  });
  it("cooldownUntil names the day the wait ends, or null", () => {
    const endedAt = new Date(NOW.getTime() - DAY);
    expect(cooldownUntil({ status: "ended", endReason: "declined", endedAt, endedByOrgId: "sutton" }, "sutton", NOW)).toEqual(new Date(endedAt.getTime() + 30 * DAY));
    expect(cooldownUntil({ status: "ended", endReason: "blocked", endedAt, endedByOrgId: "sutton" }, "sutton", NOW)).toBeNull();
    expect(cooldownUntil(null, "sutton", NOW)).toBeNull();
  });
});

describe("answering a request", () => {
  const request = {
    askerOrgId: "fnf",
    partnerOrgId: "sutton",
    status: "proposed",
    askerAcceptedAt: NOW,
    partnerAcceptedAt: null,
    pausedByOrgId: null,
  };
  it("the partner's owner OR admin accepts: active in one step, with its per-ask choice", () => {
    expect(planPartnershipAction(request, { orgId: "sutton", role: "ADMIN", action: "accept", userId: "u2", now: NOW, approval: "each-ask" })).toEqual({
      ok: true,
      patch: { partnerAcceptedAt: NOW, partnerAcceptedBy: "u2", status: "active", partnerApproval: "each-ask" },
    });
    expect(planPartnershipAction(request, { orgId: "sutton", role: "OWNER", action: "accept", userId: "u2", now: NOW })).toEqual({
      ok: true,
      patch: { partnerAcceptedAt: NOW, partnerAcceptedBy: "u2", status: "active" },
    });
  });
  it("the asking side's choice is never written by its own accept", () => {
    const legacy = { ...request, askerAcceptedAt: null };
    expect(planPartnershipAction(legacy, { orgId: "fnf", role: "OWNER", action: "accept", userId: "u", now: NOW, approval: "each-ask" })).toEqual({
      ok: true,
      patch: { askerAcceptedAt: NOW, askerAcceptedBy: "u" },
    });
  });
  it("withdraw: the asking side's owner or admin, while it is pending", () => {
    expect(planPartnershipAction(request, { orgId: "fnf", role: "ADMIN", action: "withdraw", userId: "u", now: NOW })).toEqual({
      ok: true,
      patch: { status: "ended", pausedByOrgId: null, endedAt: NOW, endedByOrgId: "fnf", endReason: "withdrawn" },
    });
    expect(planPartnershipAction(request, { orgId: "sutton", role: "OWNER", action: "withdraw", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "not-asker" });
    expect(planPartnershipAction({ ...request, status: "active" }, { orgId: "fnf", role: "OWNER", action: "withdraw", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "not-proposed" });
    expect(planPartnershipAction(request, { orgId: "fnf", role: "PLAYER", action: "withdraw", userId: "u", now: NOW })).toEqual({ ok: false, refusal: "admin-only" });
  });
});

describe("expiry and blocking", () => {
  it("a pending request expires 14 days after it was sent, not a minute before", () => {
    const expiresAt = new Date(NOW.getTime() + PARTNER_REQUEST_EXPIRES_MS);
    const r = { status: "proposed", origin: "request", expiresAt };
    expect(requestExpired(r, new Date(expiresAt.getTime() - 60_000))).toBe(false);
    expect(requestExpired(r, expiresAt)).toBe(true);
    expect(requestExpired({ ...r, status: "active" }, expiresAt)).toBe(false);
    expect(requestExpired({ ...r, origin: "owner" }, expiresAt)).toBe(false);
    expect(requestExpired({ ...r, expiresAt: null }, expiresAt)).toBe(false);
  });
  it("owners and admins block another club, never their own", () => {
    expect(canBlock({ role: "ADMIN", blockerOrgId: "sutton", blockedOrgId: "fnf" })).toEqual({ ok: true });
    expect(canBlock({ role: "PLAYER", blockerOrgId: "sutton", blockedOrgId: "fnf" })).toEqual({ ok: false, refusal: "not-admin" });
    expect(canBlock({ role: "OWNER", blockerOrgId: "sutton", blockedOrgId: "sutton" })).toEqual({ ok: false, refusal: "same-club" });
  });
});
