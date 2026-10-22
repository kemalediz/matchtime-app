/**
 * Partner discovery, slice P1: the writer (2026-10-22).
 * `src/lib/club-partnership.ts`. Plan: MDs/partner-discovery-plan-2026-10-21.md,
 * sections 2.1, 3.5 and 6.
 *
 *   - the two settings load (existing clubs read as discoverable) and save,
 *     owners and admins only, each with who changed it and when;
 *   - the weekly venue reminder: at most once a week per club, never to a
 *     club with a venue, stops once one is set, through the admin channel
 *     with a link to the venue lookup; a compare-and-set claim, so five
 *     runs at once send ONE;
 *   - the platform owner pauses, resumes and ends any pairing.
 *
 * Against a mocked database. The real-Postgres proof of the claim under
 * concurrency is e2e/api/venue-reminder.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Org = {
  id: string;
  name: string;
  language: string;
  discoverable?: boolean | null;
  autoAcceptPartnerRequests?: boolean | null;
  venueReminderSentAt: Date | null;
  homeVenue: { name: string; formattedAddress: string | null; lat: number | null; lng: number | null } | null;
  activities: Array<{
    isActive: boolean;
    venueLookupStatus: string | null;
    venueResolvedAt: Date | null;
    venueRef: { name: string; lat: number | null; lng: number | null } | null;
  }>;
};

const state = vi.hoisted(() => ({ org: null as Org | null, updates: [] as unknown[] }));

const dbMock = vi.hoisted(() => ({
  organisation: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  clubPartnership: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const noticeMock = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../admin-channel", () => noticeMock);
const hqLogMock = vi.hoisted(() => ({ recordMatchTimeQuestion: vi.fn() }));
vi.mock("../admin-group-log", () => hqLogMock);

import {
  CLUB_VENUE_SETTINGS_PATH,
  loadClubVenueStatus,
  loadDiscoverySettings,
  platformActOnPartnership,
  runVenueReminderSweep,
  saveDiscoverySettings,
  sendVenueReminder,
} from "../club-partnership";
import { PLATFORM_PAUSE } from "../club-partnership-rules";

const NOW = new Date("2026-10-22T10:00:00Z");
const DAY = 24 * 3600_000;
const GEO_VENUE = { name: "Goals Sutton", lat: 51.36, lng: -0.17 };

const club = (over: Partial<Org> = {}): Org => ({
  id: "mt",
  name: "MT Test",
  language: "en",
  venueReminderSentAt: null,
  homeVenue: null,
  activities: [{ isActive: true, venueLookupStatus: "none", venueResolvedAt: null, venueRef: null }],
  ...over,
});

const same = (a: Date | null, b: unknown) => (a === null ? b === null : b instanceof Date && a.getTime() === b.getTime());

beforeEach(() => {
  vi.clearAllMocks();
  state.org = club();
  state.updates = [];
  // A snapshot of the row as it is at the moment of the read.
  dbMock.organisation.findFirst.mockImplementation(() => Promise.resolve(state.org ? structuredClone(state.org) : null));
  dbMock.organisation.findUnique.mockImplementation(() => Promise.resolve(state.org ? structuredClone(state.org) : null));
  // The compare-and-set, applied atomically as Postgres applies one UPDATE.
  dbMock.organisation.updateMany.mockImplementation(({ where, data }: { where: { id: string; venueReminderSentAt?: Date | null }; data: { venueReminderSentAt: Date | null } }) => {
    state.updates.push({ where, data });
    const o = state.org;
    if (!o || o.id !== where.id || !same(o.venueReminderSentAt, where.venueReminderSentAt)) return Promise.resolve({ count: 0 });
    o.venueReminderSentAt = data.venueReminderSentAt;
    return Promise.resolve({ count: 1 });
  });
  dbMock.organisation.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    state.updates.push({ data });
    Object.assign(state.org!, data);
    return Promise.resolve(state.org);
  });
  noticeMock.sendAdminNotice.mockResolvedValue({ channel: "dm", queued: 2 });
});

describe("loading the settings", () => {
  it("an existing club (default on, never changed) reads as discoverable, auto-accept off", async () => {
    state.org = club({ discoverable: true, autoAcceptPartnerRequests: false });
    expect(await loadDiscoverySettings("mt")).toEqual({ discoverable: true, autoAccept: false });
  });
  it("a club that switched it off reads off", async () => {
    state.org = club({ discoverable: false, autoAcceptPartnerRequests: true });
    expect(await loadDiscoverySettings("mt")).toEqual({ discoverable: false, autoAccept: true });
  });
  it("no club: null", async () => {
    state.org = null;
    expect(await loadDiscoverySettings("gone")).toBeNull();
  });
});

describe("saving the settings: owners and admins only", () => {
  it("a PLAYER is refused and nothing is written", async () => {
    const r = await saveDiscoverySettings({ orgId: "mt", userId: "p", role: "PLAYER", patch: { discoverable: false }, now: NOW });
    expect(r).toEqual({ ok: false, refusal: "not-admin" });
    expect(dbMock.organisation.update).not.toHaveBeenCalled();
  });
  it("an ADMIN switches discoverable off, with who and when", async () => {
    state.org = club({ discoverable: true, autoAcceptPartnerRequests: false });
    const r = await saveDiscoverySettings({ orgId: "mt", userId: "a1", role: "ADMIN", patch: { discoverable: false }, now: NOW });
    expect(dbMock.organisation.update).toHaveBeenCalledWith({
      where: { id: "mt" },
      data: { discoverable: false, discoverableAt: NOW, discoverableById: "a1", settingsSetByOrganiser: { push: ["discoverable"] } },
    });
    expect(r).toEqual({ ok: true, settings: { discoverable: false, autoAccept: false } });
  });
  it("an OWNER switches auto-accept on", async () => {
    state.org = club({ discoverable: true, autoAcceptPartnerRequests: false });
    const r = await saveDiscoverySettings({ orgId: "mt", userId: "o1", role: "OWNER", patch: { autoAccept: true }, now: NOW });
    expect(dbMock.organisation.update).toHaveBeenCalledWith({
      where: { id: "mt" },
      data: { autoAcceptPartnerRequests: true, settingsSetByOrganiser: { push: ["autoAcceptPartnerRequests"] } },
    });
    expect(r).toEqual({ ok: true, settings: { discoverable: true, autoAccept: true } });
  });
  it("a value that is not a real on or off is refused, nothing written", async () => {
    expect(await saveDiscoverySettings({ orgId: "mt", userId: "o1", role: "OWNER", patch: { discoverable: "no" }, now: NOW })).toEqual({
      ok: false,
      refusal: "bad-value",
    });
    expect(await saveDiscoverySettings({ orgId: "mt", userId: "o1", role: "OWNER", patch: { discoverable: true, autoAccept: 1 }, now: NOW })).toEqual({
      ok: false,
      refusal: "bad-value",
    });
    expect(dbMock.organisation.update).not.toHaveBeenCalled();
  });
});

describe("the club's venue, for the settings prompt", () => {
  it("no game venue and no home venue: no venue", async () => {
    expect(await loadClubVenueStatus("mt")).toEqual({ hasVenue: false, homeVenue: null, gameVenue: null });
  });
  it("an active game's geocoded venue counts", async () => {
    state.org = club({ activities: [{ isActive: true, venueLookupStatus: "found", venueResolvedAt: NOW, venueRef: GEO_VENUE }] });
    expect(await loadClubVenueStatus("mt")).toEqual({ hasVenue: true, homeVenue: null, gameVenue: { name: "Goals Sutton" } });
  });
  it("the home venue counts", async () => {
    state.org = club({ homeVenue: { name: "Powerleague Croydon", formattedAddress: "Purley Way, Croydon", lat: 51.35, lng: -0.11 } });
    expect(await loadClubVenueStatus("mt")).toEqual({
      hasVenue: true,
      homeVenue: { name: "Powerleague Croydon", address: "Purley Way, Croydon" },
      gameVenue: null,
    });
  });
});

describe("the weekly venue reminder", () => {
  it("a live club with no venue, never reminded: ONE notice through the admin channel, linking to the venue lookup", async () => {
    expect(await sendVenueReminder("mt", NOW)).toBe("sent");
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledTimes(1);
    const n = noticeMock.sendAdminNotice.mock.calls[0][0];
    expect(n.orgId).toBe("mt");
    expect(n.nextPath).toBe(CLUB_VENUE_SETTINGS_PATH);
    expect(CLUB_VENUE_SETTINGS_PATH).toBe("/admin/settings#club-venue");
    // Quiet hours are respected: the notice is not marked to skip them.
    expect(n.holdOvernight).not.toBe(false);
    const text = n.text("https://mt.link/abc", "dm");
    expect(text).toContain("MT Test");
    expect(text).toContain("https://mt.link/abc");
    expect(state.org!.venueReminderSentAt).toEqual(NOW);
  });

  it("in Turkish for a Turkish club", async () => {
    state.org = club({ language: "tr" });
    await sendVenueReminder("mt", NOW);
    expect(noticeMock.sendAdminNotice.mock.calls[0][0].text("https://L", "dm")).toContain("sahasını");
  });

  it("at most once a week: not again 6 days later, again after 7", async () => {
    await sendVenueReminder("mt", NOW);
    expect(await sendVenueReminder("mt", new Date(NOW.getTime() + 6 * DAY))).toBe("not-due");
    expect(await sendVenueReminder("mt", new Date(NOW.getTime() + 7 * DAY))).toBe("sent");
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledTimes(2);
  });

  it("never to a club with a venue", async () => {
    state.org = club({ activities: [{ isActive: true, venueLookupStatus: "found", venueResolvedAt: NOW, venueRef: GEO_VENUE }] });
    expect(await sendVenueReminder("mt", NOW)).toBe("not-due");
    state.org = club({ homeVenue: { name: "Home", formattedAddress: null, lat: 51.3, lng: -0.1 } });
    expect(await sendVenueReminder("mt", NOW)).toBe("not-due");
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("stops for good once a venue is set", async () => {
    await sendVenueReminder("mt", NOW);
    state.org!.homeVenue = { name: "Home", formattedAddress: null, lat: 51.3, lng: -0.1 };
    for (const days of [7, 14, 60]) expect(await sendVenueReminder("mt", new Date(NOW.getTime() + days * DAY))).toBe("not-due");
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledTimes(1);
  });

  it("not while a game's venue lookup is still running (a club created a moment ago)", async () => {
    state.org = club({ activities: [{ isActive: true, venueLookupStatus: "pending", venueResolvedAt: new Date(NOW.getTime() - 60_000), venueRef: null }] });
    expect(await sendVenueReminder("mt", NOW)).toBe("not-due");
    // A lookup that never reported back an hour later is not running.
    state.org = club({ activities: [{ isActive: true, venueLookupStatus: "pending", venueResolvedAt: new Date(NOW.getTime() - 2 * 3600_000), venueRef: null }] });
    expect(await sendVenueReminder("mt", NOW)).toBe("sent");
  });

  it("a club that is not live (no row matched the live filter) is never reminded", async () => {
    state.org = null;
    expect(await sendVenueReminder("mt", NOW)).toBe("not-due");
    expect(noticeMock.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("CONCURRENCY: five runs at once send ONE, because the claim is a compare-and-set on the stamp read", async () => {
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => sendVenueReminder("mt", NOW)));
    expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already")).toHaveLength(4);
    expect(noticeMock.sendAdminNotice).toHaveBeenCalledTimes(1);
    // Each claim compared against the value it read (null), so only one won.
    for (const u of state.updates as Array<{ where: { venueReminderSentAt: unknown } }>) expect(u.where.venueReminderSentAt).toBeNull();
  });

  it("a notice that fails to queue releases the claim, so the next run tries again", async () => {
    noticeMock.sendAdminNotice.mockRejectedValueOnce(new Error("db down"));
    await expect(sendVenueReminder("mt", NOW)).rejects.toThrow("db down");
    expect(state.org!.venueReminderSentAt).toBeNull();
    expect(await sendVenueReminder("mt", NOW)).toBe("sent");
  });

  it("the sweep reminds each candidate club once and reports it", async () => {
    dbMock.organisation.findMany.mockResolvedValue([{ id: "mt" }]);
    expect(await runVenueReminderSweep(NOW)).toEqual({ considered: 1, sent: 1 });
    // Asks only for live clubs not reminded in the last week.
    const where = dbMock.organisation.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain(new Date(NOW.getTime() - 7 * DAY).toISOString());
    expect(where.approvalStatus).toBe("approved");
    expect(where.dormantAt).toBeNull();
  });

  it("the sweep carries on past a club that fails", async () => {
    dbMock.organisation.findMany.mockResolvedValue([{ id: "bad" }, { id: "mt" }]);
    dbMock.organisation.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      where.id === "bad" ? Promise.reject(new Error("boom")) : Promise.resolve(structuredClone(state.org)),
    );
    expect(await runVenueReminderSweep(NOW)).toEqual({ considered: 2, sent: 1 });
  });
});

describe("the platform owner's pause, resume and end (P5)", () => {
  const ROW = { id: "p1", askerOrgId: "fnf", partnerOrgId: "sutton", status: "active", askerAcceptedAt: NOW, partnerAcceptedAt: NOW, pausedByOrgId: null };
  beforeEach(() => {
    dbMock.clubPartnership.findUnique.mockResolvedValue(ROW);
    dbMock.clubPartnership.updateMany.mockResolvedValue({ count: 1 });
  });
  it("pauses as the platform, with a compare-and-set on the status read", async () => {
    expect(await platformActOnPartnership({ partnershipId: "p1", action: "pause", now: NOW })).toEqual({ ok: true, status: "paused" });
    expect(dbMock.clubPartnership.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", status: "active" },
      data: { status: "paused", pausedByOrgId: PLATFORM_PAUSE },
    });
  });
  it("ends it, recording when and why", async () => {
    expect(await platformActOnPartnership({ partnershipId: "p1", action: "end", now: NOW })).toEqual({ ok: true, status: "ended" });
    expect(dbMock.clubPartnership.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", status: "active" },
      data: { status: "ended", pausedByOrgId: null, endedAt: NOW, endedByOrgId: null, endReason: "ended" },
    });
  });
  it("a pairing that changed meanwhile is not overwritten", async () => {
    dbMock.clubPartnership.updateMany.mockResolvedValue({ count: 0 });
    expect(await platformActOnPartnership({ partnershipId: "p1", action: "end", now: NOW })).toEqual({ ok: false, refusal: "changed" });
  });
  it("no such pairing", async () => {
    dbMock.clubPartnership.findUnique.mockResolvedValue(null);
    expect(await platformActOnPartnership({ partnershipId: "gone", action: "end", now: NOW })).toEqual({ ok: false, refusal: "not-found" });
  });
});
