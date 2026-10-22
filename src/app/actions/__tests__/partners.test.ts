/**
 * Partner clubs, the server actions (cross-club ask, slice S1).
 * A server action is a public endpoint: each one proves who is asking.
 * The settings page is for the club's owners and admins (a PLAYER is
 * refused before anything is read); pairing two clubs is the platform
 * owner's alone; the owner or admin role is passed to the writer, which
 * keeps accept, decline and remove for owners.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => authMock);
const orgMock = vi.hoisted(() => ({ requireOrgAdmin: vi.fn(), isSuperadmin: vi.fn() }));
vi.mock("@/lib/org", () => orgMock);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const dbMock = vi.hoisted(() => ({ membership: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const writer = vi.hoisted(() => ({
  actOnPartnership: vi.fn(),
  loadPartnerAskSettings: vi.fn(),
  loadPartnershipsForOrg: vi.fn(),
  savePartnerAskSettings: vi.fn(),
  setPartnerApproval: vi.fn(),
  loadDiscoverySettings: vi.fn(),
  saveDiscoverySettings: vi.fn(),
  loadClubVenueStatus: vi.fn(),
  platformActOnPartnership: vi.fn(),
}));
vi.mock("@/lib/club-partnership", () => writer);
const venueWriter = vi.hoisted(() => ({ setClubHomeVenueToPick: vi.fn() }));
vi.mock("@/lib/venue-location", () => venueWriter);

import {
  actOnPartnershipAction,
  getPartnerClubs,
  platformPartnershipAction,
  saveDiscoverySettingsAction,
  savePartnerAskSettingsAction,
  setClubHomeVenueAction,
} from "../partners";

const DISCOVERY = { discoverable: true, autoAccept: false };
const VENUE = { hasVenue: false, homeVenue: null, gameVenue: null };

beforeEach(() => {
  vi.clearAllMocks();
  authMock.auth.mockResolvedValue({ user: { id: "u1" } });
  orgMock.requireOrgAdmin.mockResolvedValue(undefined);
  orgMock.isSuperadmin.mockResolvedValue(false);
  dbMock.membership.findUnique.mockResolvedValue({ role: "OWNER", leftAt: null });
  writer.loadPartnershipsForOrg.mockResolvedValue([{ id: "p1" }]);
  writer.loadPartnerAskSettings.mockResolvedValue({ when: "off", time: null, cutoffHours: 4 });
  writer.actOnPartnership.mockResolvedValue({ ok: true, status: "active" });
  writer.savePartnerAskSettings.mockResolvedValue({ ok: true, settings: { when: "on-request", time: null, cutoffHours: 4 } });
  writer.loadDiscoverySettings.mockResolvedValue(DISCOVERY);
  writer.loadClubVenueStatus.mockResolvedValue(VENUE);
  writer.saveDiscoverySettings.mockResolvedValue({ ok: true, settings: { discoverable: false, autoAccept: false } });
  writer.platformActOnPartnership.mockResolvedValue({ ok: true, status: "paused" });
  venueWriter.setClubHomeVenueToPick.mockResolvedValue({ status: "found" });
});

describe("the settings page", () => {
  it("an owner reads the section", async () => {
    expect(await getPartnerClubs("fnf")).toEqual({
      isOwner: true,
      partnerships: [{ id: "p1" }],
      settings: { when: "off", time: null, cutoffHours: 4 },
      discovery: DISCOVERY,
      venue: VENUE,
    });
    expect(orgMock.requireOrgAdmin).toHaveBeenCalledWith("u1", "fnf");
  });

  it("no partner clubs: the section still shows, to every club (partner discovery, P1)", async () => {
    writer.loadPartnershipsForOrg.mockResolvedValue([]);
    expect(await getPartnerClubs("fnf")).toMatchObject({ partnerships: [], discovery: DISCOVERY, venue: VENUE });
  });

  it("a PLAYER is refused before anything is read or written", async () => {
    orgMock.requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(getPartnerClubs("fnf")).rejects.toThrow("Admin access required");
    await expect(savePartnerAskSettingsAction("fnf", { when: "auto" })).rejects.toThrow("Admin access required");
    await expect(actOnPartnershipAction("fnf", "p1", "pause")).rejects.toThrow("Admin access required");
    await expect(saveDiscoverySettingsAction("fnf", { discoverable: false })).rejects.toThrow("Admin access required");
    await expect(setClubHomeVenueAction("fnf", { placeId: "ChIJ_e2e_croydon_01", sessionToken: "t" })).rejects.toThrow("Admin access required");
    expect(writer.saveDiscoverySettings).not.toHaveBeenCalled();
    expect(venueWriter.setClubHomeVenueToPick).not.toHaveBeenCalled();
    expect(writer.loadPartnershipsForOrg).not.toHaveBeenCalled();
    expect(writer.savePartnerAskSettings).not.toHaveBeenCalled();
    expect(writer.actOnPartnership).not.toHaveBeenCalled();
  });

  it("an admin acts as ADMIN, so the writer can refuse what is an owner's", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ role: "ADMIN", leftAt: null });
    writer.actOnPartnership.mockResolvedValue({ ok: false, refusal: "owner-only" });
    expect(await actOnPartnershipAction("fnf", "p1", "accept")).toEqual({ ok: false, refusal: "owner-only" });
    expect(writer.actOnPartnership).toHaveBeenCalledWith({ partnershipId: "p1", orgId: "fnf", userId: "u1", role: "ADMIN", action: "accept" });
  });

  it("signed out: refused", async () => {
    authMock.auth.mockResolvedValue(null);
    await expect(getPartnerClubs("fnf")).rejects.toThrow("Not authenticated");
  });
});

describe("partner discovery settings (P1)", () => {
  it("an admin saves them as ADMIN; the writer keeps them to owners and admins", async () => {
    dbMock.membership.findUnique.mockResolvedValue({ role: "ADMIN", leftAt: null });
    expect(await saveDiscoverySettingsAction("fnf", { discoverable: false })).toEqual({ ok: true, settings: { discoverable: false, autoAccept: false } });
    expect(writer.saveDiscoverySettings).toHaveBeenCalledWith({ orgId: "fnf", userId: "u1", role: "ADMIN", patch: { discoverable: false } });
  });

  it("the home venue is set only from a picked place: Google's id and the session token, nothing else", async () => {
    expect(await setClubHomeVenueAction("fnf", { placeId: "ChIJ_e2e_croydon_01", sessionToken: "tok", name: "ignored" } as never)).toEqual({ status: "found" });
    expect(venueWriter.setClubHomeVenueToPick).toHaveBeenCalledWith("fnf", "u1", { placeId: "ChIJ_e2e_croydon_01", sessionToken: "tok" });
  });

  it("no usable pick (typed text only): refused, nothing looked up", async () => {
    expect(await setClubHomeVenueAction("fnf", null)).toEqual({ status: "no-pick" });
    expect(await setClubHomeVenueAction("fnf", { placeId: "x" } as never)).toEqual({ status: "no-pick" });
    expect(venueWriter.setClubHomeVenueToPick).not.toHaveBeenCalled();
  });
});

describe("the platform owner's override (P5)", () => {
  it("the platform owner pauses or ends any pairing", async () => {
    orgMock.isSuperadmin.mockResolvedValue(true);
    expect(await platformPartnershipAction("p1", "pause")).toEqual({ ok: true });
    expect(writer.platformActOnPartnership).toHaveBeenCalledWith({ partnershipId: "p1", action: "pause" });
  });

  it("anybody else, a club owner included, is refused", async () => {
    await expect(platformPartnershipAction("p1", "end")).rejects.toThrow("Not allowed");
    expect(writer.platformActOnPartnership).not.toHaveBeenCalled();
  });

  it("an action that is not pause, resume or end is refused", async () => {
    orgMock.isSuperadmin.mockResolvedValue(true);
    expect(await platformPartnershipAction("p1", "accept" as never)).toEqual({ ok: false, refusal: "bad-action" });
    expect(writer.platformActOnPartnership).not.toHaveBeenCalled();
  });
});
