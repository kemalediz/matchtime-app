/**
 * The platform owner's "Player pool" switch on /admin/clubs: superadmin
 * only, checked in the action itself (a server action is a public
 * endpoint); the write goes through `setClubPlayerPool`; both pages that
 * show the pool's settings are revalidated. No database, nothing messaged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  isSuperadmin: vi.fn(),
  setClubPlayerPool: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/org", () => ({ isSuperadmin: h.isSuperadmin }));
vi.mock("@/lib/pool/club-switch", () => ({ setClubPlayerPool: h.setClubPlayerPool }));

import { setClubPlayerPoolAction } from "../pool-club-switch";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "kemal" } });
  h.isSuperadmin.mockResolvedValue(true);
});

describe("owner only", () => {
  it("a club admin who is not the superadmin is refused and nothing is written", async () => {
    h.isSuperadmin.mockResolvedValue(false);
    await expect(setClubPlayerPoolAction("org1", true)).rejects.toThrow("Not allowed");
    expect(h.setClubPlayerPool).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("signed out is refused", async () => {
    h.auth.mockResolvedValue(null);
    await expect(setClubPlayerPoolAction("org1", false)).rejects.toThrow("Not allowed");
    expect(h.setClubPlayerPool).not.toHaveBeenCalled();
  });
});

describe("setClubPlayerPoolAction", () => {
  it("on writes the flag and revalidates the Clubs page and the club's settings", async () => {
    h.setClubPlayerPool.mockResolvedValue({ ok: true, on: true, closedAsks: 0, autoAsk: false });
    const r = await setClubPlayerPoolAction("org1", true);
    expect(h.setClubPlayerPool).toHaveBeenCalledWith("org1", true);
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/clubs");
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/settings");
    expect(r).toEqual({ ok: true, message: "Player pool on. Automatic asking stays off until the club's admin turns it on." });
  });

  it("on, with the club's automatic asking already on from before, says so", async () => {
    h.setClubPlayerPool.mockResolvedValue({ ok: true, on: true, closedAsks: 0, autoAsk: true });
    expect((await setClubPlayerPoolAction("org1", true)).message).toBe(
      "Player pool on. The club's admin had already turned automatic asking on, so it asks the pool automatically.",
    );
  });

  it("off says how many open asks were closed", async () => {
    h.setClubPlayerPool.mockResolvedValue({ ok: true, on: false, closedAsks: 2, autoAsk: false });
    expect(await setClubPlayerPoolAction("org1", false)).toEqual({ ok: true, message: "Player pool off. 2 open pool asks closed." });
    h.setClubPlayerPool.mockResolvedValue({ ok: true, on: false, closedAsks: 0, autoAsk: false });
    expect((await setClubPlayerPoolAction("org1", false)).message).toBe("Player pool off.");
  });

  it("only a real boolean is accepted", async () => {
    await expect(setClubPlayerPoolAction("org1", "yes" as unknown as boolean)).rejects.toThrow("Bad request");
    expect(h.setClubPlayerPool).not.toHaveBeenCalled();
  });

  it("a club that no longer exists", async () => {
    h.setClubPlayerPool.mockResolvedValue({ ok: false, reason: "not-found" });
    expect(await setClubPlayerPoolAction("gone", true)).toEqual({ ok: false, message: "That club no longer exists." });
  });
});
