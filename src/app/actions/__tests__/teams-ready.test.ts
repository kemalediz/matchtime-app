/**
 * The "Teams ready" setting on /admin/settings (2026-10-14): an owner or
 * admin of the club only; "HH:MM" or "off", anything else refused and
 * nothing saved; read back with whether the club has an admin group
 * linked (the row is shown only then).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => authMock);
const orgMock = vi.hoisted(() => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/org", () => orgMock);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const dbMock = vi.hoisted(() => ({ organisation: { findUnique: vi.fn(), update: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { getTeamsReady, setTeamsReady } from "../teams-ready";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.auth.mockResolvedValue({ user: { id: "u-admin" } });
  orgMock.requireOrgAdmin.mockResolvedValue(undefined);
  dbMock.organisation.findUnique.mockResolvedValue({ teamsReadyTime: "10:00", adminGroupId: "hq@g.us", squadMode: "weekly" });
  dbMock.organisation.update.mockResolvedValue({});
});

describe("Teams ready", () => {
  it("reads the setting and whether an admin group is linked", async () => {
    expect(await getTeamsReady("org-1")).toEqual({ value: "10:00", adminGroupLinked: true, weekly: true });
    expect(orgMock.requireOrgAdmin).toHaveBeenCalledWith("u-admin", "org-1");
  });

  it("saves a time, zero-padded", async () => {
    expect(await setTeamsReady("org-1", "9:30")).toEqual({ ok: true, value: "09:30" });
    expect(dbMock.organisation.update).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { teamsReadyTime: "09:30" } });
  });

  it("saves off", async () => {
    expect(await setTeamsReady("org-1", "off")).toEqual({ ok: true, value: "off" });
  });

  it("refuses anything else and saves nothing", async () => {
    expect(await setTeamsReady("org-1", "25:00")).toEqual({ ok: false, error: "bad-time" });
    expect(dbMock.organisation.update).not.toHaveBeenCalled();
  });

  it("signed out: refused before any read or write", async () => {
    authMock.auth.mockResolvedValue(null);
    await expect(setTeamsReady("org-1", "10:00")).rejects.toThrow("Not authenticated");
    expect(dbMock.organisation.update).not.toHaveBeenCalled();
  });

  it("not an admin of the club: refused", async () => {
    orgMock.requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(getTeamsReady("org-1")).rejects.toThrow("Admin access required");
    expect(dbMock.organisation.findUnique).not.toHaveBeenCalled();
  });
});
