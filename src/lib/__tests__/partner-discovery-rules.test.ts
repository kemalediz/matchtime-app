/**
 * Partner discovery, slice P1: the pure rules (2026-10-22).
 * Plan: MDs/partner-discovery-plan-2026-10-21.md, sections 2.1, 3.5 and 6.
 *
 *   - every existing club reads as discoverable (default on), and
 *     auto-accept reads as off;
 *   - only an OWNER or ADMIN changes either setting;
 *   - a club has a geocoded venue when an active game's venue or its
 *     home venue has a position;
 *   - the venue reminder is due at most once a week, never for a club
 *     with a venue, and not while a lookup is still running;
 *   - the platform owner pauses and ends any pairing; only the platform
 *     resumes its own pause.
 */
import { describe, expect, it } from "vitest";
import {
  PARTNERSHIP_END_REASONS,
  PARTNERSHIP_ORIGINS,
  PLATFORM_PAUSE,
  VENUE_REMINDER_EVERY_MS,
  autoAcceptOf,
  canChangeDiscoverySettings,
  hasGeocodedVenue,
  isDiscoverable,
  parseSwitch,
  planPartnershipAction,
  planPlatformAction,
  venueReminderDue,
  type PartnershipRow,
} from "../club-partnership-rules";

const NOW = new Date("2026-10-22T10:00:00Z");
const DAY = 24 * 3600_000;
const GEO = { lat: 51.36, lng: -0.17 };

describe("the two settings, read", () => {
  it("existing clubs read as discoverable: the column default is on, and a missing value is on", () => {
    expect(isDiscoverable({ discoverable: true })).toBe(true);
    expect(isDiscoverable({ discoverable: null })).toBe(true);
    expect(isDiscoverable({})).toBe(true);
    expect(isDiscoverable({ discoverable: false })).toBe(false);
  });
  it("auto-accept reads as off unless switched on", () => {
    expect(autoAcceptOf({ autoAcceptPartnerRequests: true })).toBe(true);
    expect(autoAcceptOf({ autoAcceptPartnerRequests: null })).toBe(false);
    expect(autoAcceptOf({})).toBe(false);
  });
  it("a switch to save is a real boolean or refused", () => {
    expect(parseSwitch(true)).toBe(true);
    expect(parseSwitch(false)).toBe(false);
    expect(parseSwitch("true")).toBeNull();
    expect(parseSwitch(1)).toBeNull();
    expect(parseSwitch(undefined)).toBeNull();
  });
});

describe("who changes them", () => {
  it("owners and admins only", () => {
    expect(canChangeDiscoverySettings("OWNER")).toBe(true);
    expect(canChangeDiscoverySettings("ADMIN")).toBe(true);
    expect(canChangeDiscoverySettings("PLAYER")).toBe(false);
  });
});

describe("a geocoded venue", () => {
  it("an active game's venue with a position counts", () => {
    expect(hasGeocodedVenue({ homeVenue: null, games: [{ isActive: true, venue: GEO }] })).toBe(true);
  });
  it("an inactive game's venue does not", () => {
    expect(hasGeocodedVenue({ homeVenue: null, games: [{ isActive: false, venue: GEO }] })).toBe(false);
  });
  it("a game with no linked venue, or a venue with no position, does not", () => {
    expect(hasGeocodedVenue({ homeVenue: null, games: [{ isActive: true, venue: null }] })).toBe(false);
    expect(hasGeocodedVenue({ homeVenue: null, games: [{ isActive: true, venue: { lat: null, lng: -0.1 } }] })).toBe(false);
  });
  it("the home venue counts when it has a position", () => {
    expect(hasGeocodedVenue({ homeVenue: GEO, games: [] })).toBe(true);
    expect(hasGeocodedVenue({ homeVenue: { lat: null, lng: null }, games: [] })).toBe(false);
    expect(hasGeocodedVenue({ homeVenue: null, games: [] })).toBe(false);
  });
});

describe("the weekly venue reminder", () => {
  const base = { hasVenue: false, lastSentAt: null as Date | null, lookupRunning: false, now: NOW };
  it("is once a week", () => {
    expect(VENUE_REMINDER_EVERY_MS).toBe(7 * DAY);
  });
  it("is due for a club with no venue that was never reminded", () => {
    expect(venueReminderDue(base)).toBe(true);
  });
  it("is not due again within the week, and is due again once a week has passed", () => {
    expect(venueReminderDue({ ...base, lastSentAt: new Date(NOW.getTime() - 6 * DAY) })).toBe(false);
    expect(venueReminderDue({ ...base, lastSentAt: new Date(NOW.getTime() - 7 * DAY + 60_000) })).toBe(false);
    expect(venueReminderDue({ ...base, lastSentAt: new Date(NOW.getTime() - 7 * DAY) })).toBe(true);
    expect(venueReminderDue({ ...base, lastSentAt: new Date(NOW.getTime() - 30 * DAY) })).toBe(true);
  });
  it("is never due for a club with a venue, however long ago it was reminded", () => {
    expect(venueReminderDue({ ...base, hasVenue: true })).toBe(false);
    expect(venueReminderDue({ ...base, hasVenue: true, lastSentAt: new Date(NOW.getTime() - 30 * DAY) })).toBe(false);
  });
  it("waits while a venue lookup is still running", () => {
    expect(venueReminderDue({ ...base, lookupRunning: true })).toBe(false);
  });
  it("a stamp in the future (a clock fault) never sends", () => {
    expect(venueReminderDue({ ...base, lastSentAt: new Date(NOW.getTime() + DAY) })).toBe(false);
  });
});

describe("the CHECK values", () => {
  it("origin and end reason are the plan's values", () => {
    expect(PARTNERSHIP_ORIGINS).toEqual(["owner", "request"]);
    expect(PARTNERSHIP_END_REASONS).toEqual(["declined", "withdrawn", "ended", "expired", "blocked"]);
  });
});

describe("the platform owner's override (P5)", () => {
  const row = (over: Partial<PartnershipRow> = {}): PartnershipRow => ({
    askerOrgId: "fnf",
    partnerOrgId: "sutton",
    status: "active",
    askerAcceptedAt: NOW,
    partnerAcceptedAt: NOW,
    pausedByOrgId: null,
    ...over,
  });
  it("pauses an active pairing as the platform", () => {
    expect(planPlatformAction(row(), { action: "pause", now: NOW })).toEqual({ ok: true, patch: { status: "paused", pausedByOrgId: PLATFORM_PAUSE } });
    expect(planPlatformAction(row({ status: "proposed" }), { action: "pause", now: NOW })).toEqual({ ok: false, refusal: "not-active" });
  });
  it("only the platform resumes its own pause; neither club can", () => {
    const paused = row({ status: "paused", pausedByOrgId: PLATFORM_PAUSE });
    expect(planPlatformAction(paused, { action: "resume", now: NOW })).toEqual({ ok: true, patch: { status: "active", pausedByOrgId: null } });
    expect(planPartnershipAction(paused, { orgId: "fnf", role: "OWNER", action: "resume", userId: "u", now: NOW })).toEqual({
      ok: false,
      refusal: "paused-by-other",
    });
    // A club's own pause is that club's to resume, not the platform's.
    expect(planPlatformAction(row({ status: "paused", pausedByOrgId: "fnf" }), { action: "resume", now: NOW })).toEqual({
      ok: false,
      refusal: "paused-by-other",
    });
  });
  it("ends any pairing that has not ended, recorded as ended by nobody's club", () => {
    expect(planPlatformAction(row({ status: "proposed" }), { action: "end", now: NOW })).toEqual({
      ok: true,
      patch: { status: "ended", pausedByOrgId: null, endedAt: NOW, endedByOrgId: null, endReason: "ended" },
    });
    expect(planPlatformAction(row({ status: "ended" }), { action: "end", now: NOW })).toEqual({ ok: false, refusal: "ended" });
  });
});
