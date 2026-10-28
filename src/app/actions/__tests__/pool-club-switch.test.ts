/**
 * A club's own "Player pool" switch on /admin/settings (2026-10-28,
 * decision log P.2): an OWNER or ADMIN of THAT club (`requireOrgAdmin`,
 * checked in the action: a server action is a public endpoint), and only
 * while the platform switch is on (as this request resolves it). The write,
 * what OFF closes and the once-ever message are `setClubPlayerPool`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireOrgAdmin: vi.fn(),
  setClubPlayerPool: vi.fn(),
  revalidatePath: vi.fn(),
  poolEnvForRequest: vi.fn(),
  findUnique: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: h.requireOrgAdmin }));
vi.mock("@/lib/pool/club-switch", () => ({ setClubPlayerPool: h.setClubPlayerPool }));
vi.mock("@/lib/pool/switch-env", () => ({ poolEnvForRequest: h.poolEnvForRequest }));
vi.mock("@/lib/db", () => ({ db: { organisation: { findUnique: h.findUnique } } }));

import { getClubPlayerPool, setClubPlayerPoolAction } from "../pool-club-switch";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "admin1" } });
  h.requireOrgAdmin.mockResolvedValue(undefined);
  h.poolEnvForRequest.mockResolvedValue({ MT_POOL_OPEN: "1" });
  h.findUnique.mockResolvedValue({ featurePlayerPool: false });
});

describe("who may switch it", () => {
  it("someone who is not an owner or admin of the club is refused and nothing is written", async () => {
    h.requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(setClubPlayerPoolAction("org1", true)).rejects.toThrow("Admin access required");
    await expect(getClubPlayerPool("org1")).rejects.toThrow("Admin access required");
    expect(h.setClubPlayerPool).not.toHaveBeenCalled();
    expect(h.requireOrgAdmin).toHaveBeenCalledWith("admin1", "org1");
  });

  it("signed out is refused", async () => {
    h.auth.mockResolvedValue(null);
    await expect(setClubPlayerPoolAction("org1", true)).rejects.toThrow("Not authenticated");
    expect(h.setClubPlayerPool).not.toHaveBeenCalled();
  });

  it("only a real boolean is accepted", async () => {
    await expect(setClubPlayerPoolAction("org1", "yes" as unknown as boolean)).rejects.toThrow("Bad request");
    expect(h.setClubPlayerPool).not.toHaveBeenCalled();
  });
});

describe("the platform switch off hides the card and refuses the switch", () => {
  it("get returns null, set writes nothing", async () => {
    h.poolEnvForRequest.mockResolvedValue({ MT_POOL_OPEN: "0" });
    expect(await getClubPlayerPool("org1")).toBeNull();
    expect(await setClubPlayerPoolAction("org1", true)).toEqual({ ok: false, reason: "hidden" });
    expect(h.setClubPlayerPool).not.toHaveBeenCalled();
  });
});

describe("with the platform switch on", () => {
  it("get shows the club's own flag", async () => {
    h.findUnique.mockResolvedValue({ featurePlayerPool: true });
    expect(await getClubPlayerPool("org1")).toEqual({ on: true });
  });

  it("on goes through setClubPlayerPool and revalidates settings", async () => {
    h.setClubPlayerPool.mockResolvedValue({ ok: true, on: true, closedAsks: 0, autoAsk: false, told: true });
    expect(await setClubPlayerPoolAction("org1", true)).toEqual({ ok: true, on: true, closedAsks: 0 });
    expect(h.setClubPlayerPool).toHaveBeenCalledWith("org1", true);
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/settings");
  });

  it("off reports how many open asks were closed", async () => {
    h.setClubPlayerPool.mockResolvedValue({ ok: true, on: false, closedAsks: 2, autoAsk: true, told: false });
    expect(await setClubPlayerPoolAction("org1", false)).toEqual({ ok: true, on: false, closedAsks: 2 });
  });

  it("a club that no longer exists", async () => {
    h.setClubPlayerPool.mockResolvedValue({ ok: false, reason: "not-found" });
    expect(await setClubPlayerPoolAction("gone", true)).toEqual({ ok: false, reason: "not-found" });
  });
});
