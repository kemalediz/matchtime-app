/**
 * The platform owner's ONE "Player pool" switch on /admin/clubs
 * (2026-10-28, decision log P.1): superadmin only, checked in the action
 * itself; the write and what OFF closes are `setPoolPlatformSwitch`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  isSuperadmin: vi.fn(),
  setPoolPlatformSwitch: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/org", () => ({ isSuperadmin: h.isSuperadmin }));
vi.mock("@/lib/pool/platform-switch", () => ({ setPoolPlatformSwitch: h.setPoolPlatformSwitch }));

import { setPoolPlatformSwitchAction } from "../pool-platform-switch";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "kemal" } });
  h.isSuperadmin.mockResolvedValue(true);
});

describe("owner only", () => {
  it("a club admin who is not the superadmin is refused and nothing is written", async () => {
    h.isSuperadmin.mockResolvedValue(false);
    await expect(setPoolPlatformSwitchAction(false)).rejects.toThrow("Not allowed");
    expect(h.setPoolPlatformSwitch).not.toHaveBeenCalled();
  });

  it("signed out is refused", async () => {
    h.auth.mockResolvedValue(null);
    await expect(setPoolPlatformSwitchAction(true)).rejects.toThrow("Not allowed");
    expect(h.setPoolPlatformSwitch).not.toHaveBeenCalled();
  });

  it("only a real boolean is accepted", async () => {
    await expect(setPoolPlatformSwitchAction("on" as unknown as boolean)).rejects.toThrow("Bad request");
  });
});

describe("setPoolPlatformSwitchAction", () => {
  it("on: writes the switch as the owner and revalidates the owner page and club settings", async () => {
    h.setPoolPlatformSwitch.mockResolvedValue({ on: true, closedAsks: 0, forcedOff: false });
    expect(await setPoolPlatformSwitchAction(true)).toEqual({ ok: true, message: "Player pool on for every club. Each club's admins can now switch it on in their settings." });
    expect(h.setPoolPlatformSwitch).toHaveBeenCalledWith(true, "kemal");
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/clubs");
    expect(h.revalidatePath).toHaveBeenCalledWith("/admin/settings");
  });

  it("off says how many open asks were closed", async () => {
    h.setPoolPlatformSwitch.mockResolvedValue({ on: false, closedAsks: 3, forcedOff: false });
    expect((await setPoolPlatformSwitchAction(false)).message).toBe("Player pool off for every club. 3 open pool asks closed.");
    h.setPoolPlatformSwitch.mockResolvedValue({ on: false, closedAsks: 0, forcedOff: false });
    expect((await setPoolPlatformSwitchAction(false)).message).toBe("Player pool off for every club.");
  });

  it("on while the emergency override forces it off: says so", async () => {
    h.setPoolPlatformSwitch.mockResolvedValue({ on: true, closedAsks: 0, forcedOff: true });
    expect((await setPoolPlatformSwitchAction(true)).message).toBe(
      "Switched on, but POOL_OFFERS_ENABLED forces the pool off in this deployment. Remove it, or set it to 1, and redeploy.",
    );
  });
});
