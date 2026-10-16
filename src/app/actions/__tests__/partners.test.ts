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
  createPartnership: vi.fn(),
  loadPartnerAskSettings: vi.fn(),
  loadPartnershipsForOrg: vi.fn(),
  savePartnerAskSettings: vi.fn(),
  setPartnerApproval: vi.fn(),
}));
vi.mock("@/lib/club-partnership", () => writer);

import {
  actOnPartnershipAction,
  createPartnershipAction,
  getPartnerClubs,
  savePartnerAskSettingsAction,
} from "../partners";

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
  writer.createPartnership.mockResolvedValue({ ok: true, id: "p1", reopened: false });
});

describe("the settings page", () => {
  it("an owner reads the section", async () => {
    expect(await getPartnerClubs("fnf")).toEqual({ isOwner: true, partnerships: [{ id: "p1" }], settings: { when: "off", time: null, cutoffHours: 4 } });
    expect(orgMock.requireOrgAdmin).toHaveBeenCalledWith("u1", "fnf");
  });

  it("no partner clubs: nothing to show", async () => {
    writer.loadPartnershipsForOrg.mockResolvedValue([]);
    expect(await getPartnerClubs("fnf")).toBeNull();
  });

  it("a PLAYER is refused before anything is read or written", async () => {
    orgMock.requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(getPartnerClubs("fnf")).rejects.toThrow("Admin access required");
    await expect(savePartnerAskSettingsAction("fnf", { when: "auto" })).rejects.toThrow("Admin access required");
    await expect(actOnPartnershipAction("fnf", "p1", "pause")).rejects.toThrow("Admin access required");
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

describe("pairing two clubs", () => {
  it("the platform owner pairs them", async () => {
    orgMock.isSuperadmin.mockResolvedValue(true);
    expect(await createPartnershipAction("fnf", "sutton")).toEqual({ ok: true, message: "Paired. Both owners have been asked to accept." });
    expect(writer.createPartnership).toHaveBeenCalledWith({ creatorUserId: "u1", askerOrgId: "fnf", partnerOrgId: "sutton" });
  });

  it("anybody else, a club owner included, is refused", async () => {
    await expect(createPartnershipAction("fnf", "sutton")).rejects.toThrow("Not allowed");
    expect(writer.createPartnership).not.toHaveBeenCalled();
  });

  it("a refusal is said in plain words", async () => {
    orgMock.isSuperadmin.mockResolvedValue(true);
    writer.createPartnership.mockResolvedValue({ ok: false, refusal: "exists" });
    expect(await createPartnershipAction("fnf", "sutton")).toEqual({ ok: false, message: "Those two clubs are already paired in that direction." });
  });
});
